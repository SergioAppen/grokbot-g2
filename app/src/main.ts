import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { api, askAndWait, avatarData, chatStream, cfg, relTime, type Bot, type Conversation } from './api'
import { paginate } from './paginate'
import { ui } from './ui'

// ───────────────────────── state ─────────────────────────
type Screen = 'bots' | 'chat'
type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'streaming' | 'reply' | 'error'
const S = {
  screen: 'bots' as Screen,
  phase: 'idle' as Phase,
  bots: [] as Bot[],
  convs: [] as Conversation[],   // newest first (relay /conversations)
  sel: 0,                        // highlighted row on the HUD conversation list
  seen: {} as Record<string, number>, // last time each conversation was opened (unread dot)
  bot: '',
  pages: ['Tap to talk · hold to talk\nSwipe ▲▼ to page · double-tap: bot list'],
  page: 0,
  lastPrompt: '',
  micSource: AudioInputSource.Glasses as AudioInputSource,
}
let pcmChunks: Uint8Array[] = []
let pcmBytes = 0
const MAX_PCM = 16000 * 2 * 90 // 90 s cap

// ───────────────────────── bridge + storage ─────────────────────────
const bridge: EvenAppBridge = await waitForEvenAppBridge()
const store = {
  get: async (k: string) => { try { return (await bridge.getLocalStorage(k)) || '' } catch { return localStorage.getItem(k) ?? '' } },
  set: async (k: string, v: string) => { try { await bridge.setLocalStorage(k, v) } catch { /* sim */ } localStorage.setItem(k, v) },
}

// Config: relay URL defaults to the origin that served this page (the relay serves /app/).
// A one-time setup link may carry "#token=…&relay=…"; it is stored then stripped from the URL.
const hash = new URLSearchParams(location.hash.slice(1))
// Relay URL: setup-link override > saved value (ignoring ephemeral trycloudflare.com quick-tunnel URLs) > baked-in
// VITE_RELAY_URL (set by run.sh build from RELAY_PUBLIC_URL) > page origin.
const savedRelay = await store.get('relayUrl')
cfg.relayUrl = hash.get('relay') || (savedRelay && !savedRelay.includes('trycloudflare.com') ? savedRelay : '') ||
  (import.meta.env.VITE_RELAY_URL ?? '') || (location.pathname.startsWith('/app') ? location.origin : '')
cfg.token = hash.get('token') || (await store.get('relayToken'))
if (hash.get('token')) { await store.set('relayToken', cfg.token); history.replaceState(null, '', location.pathname + location.search) }
if (hash.get('relay')) await store.set('relayUrl', cfg.relayUrl)
S.bot = (await store.get('bot')) || '' // empty until /conversations returns the relay's default bot
try { S.seen = JSON.parse((await store.get('seen')) || '{}') } catch { S.seen = {} }
export const isUnread = (c: Conversation) => !!c.last && c.last.role === 'bot' && c.last.at > (S.seen[c.name] ?? 0)
async function markSeen(name: string) { S.seen[name] = Date.now(); await store.set('seen', JSON.stringify(S.seen)) }
S.micSource = (await store.get('mic')) === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses

// ───────────────────────── glasses rendering ─────────────────────────
// Serialize all bridge writes; the BLE render queue is slow.
let chain: Promise<unknown> = Promise.resolve()
const enqueue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch((e) => console.error('render', e)))

const HEADER = { id: 1, name: 'header' }
const BODY = { id: 2, name: 'body' }
const CAPTURE = { id: 5, name: 'input' }

function header(): string {
  if (S.screen === 'bots') {
    if (!cfg.token) return 'NOT PAIRED · phone screen → Settings → code'
    const n = S.convs.length, w = winStart()
    const unread = S.convs.filter(isUnread).length
    return `CHATS${unread ? `  ● ${unread} new` : ''}   ${n ? `${w + 1}-${Math.min(n, w + ROWS)}/${n}` : ''}  ▲▼`
  }
  const icon = { idle: '○', listening: '● REC', transcribing: '… transcribing', thinking: '… thinking', streaming: '… more coming', reply: '', error: '! error' }[S.phase]
  const pg = S.pages.length > 1 ? `  ${S.page + 1}/${S.pages.length} ▲▼` : ''
  return `${S.bot}  ${icon}${pg}`.slice(0, 60)
}

function textC(c: { id: number; name: string }, y: number, h: number, content: string, capture: number, textColor?: number) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: y, width: 576, height: h, borderWidth: 0, borderColor: 0, paddingLength: 4,
    containerID: c.id, containerName: c.name, content: content.slice(0, 990), isEventCapture: capture,
    ...(textColor !== undefined ? { textColor } : {}),
  })
}

// ── HUD conversation list: the SDK list container only takes strings (itemName: string[]), so rows are
// composed from 4 image containers (avatars; max 4 per page, 20–288 × 20–144 px) + 4 text containers.
// A blank full-screen text container captures input (swipe = move selection, tap = open). Selection = "▶" + brightness.
const ROWS = 4, ROW_H = 64, TOP = 32, AV = 40
const rowText = (i: number) => ({ id: 20 + i, name: `row${i}` })
const rowImg = (i: number) => ({ id: 10 + i, name: `av${i}` })
const winStart = () => Math.floor(S.sel / ROWS) * ROWS
function rowContent(c: Conversation | undefined, selected: boolean): string {
  if (!c) return ''
  const when = c.last ? `  · ${relTime(c.last.at)}` : ''
  const prev = c.last ? `${c.last.role === 'user' ? 'You: ' : ''}${c.last.text}` : 'No messages yet'
  const line2 = prev.length > 46 ? prev.slice(0, 45) + '…' : prev
  return `${selected ? '▶ ' : '   '}${c.name}${isUnread(c) ? '  ●' : ''}${when}\n   ${line2}`
}
function botsPage() {
  const w = winStart()
  // Per Even's display docs for image pages: a full-screen ' ' text container, declared first (drawn behind),
  // captures input. Its content never changes, so firmware scroll state stays put and every swipe is a boundary event.
  const textObject = [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: CAPTURE.id, containerName: CAPTURE.name, content: ' ', isEventCapture: 1,
  }), new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: TOP, borderWidth: 0, borderColor: 0, paddingLength: 4,
    containerID: HEADER.id, containerName: HEADER.name, content: header(), isEventCapture: 0, textColor: 3,
  })]
  const imageObject: ImageContainerProperty[] = []
  for (let i = 0; i < ROWS; i++) {
    const y = TOP + i * ROW_H
    imageObject.push(new ImageContainerProperty({ xPosition: 10, yPosition: y + (ROW_H - AV) / 2, width: AV, height: AV, containerID: rowImg(i).id, containerName: rowImg(i).name }))
    const c = S.convs[w + i]
    textObject.push(new TextContainerProperty({
      xPosition: 56, yPosition: y, width: 520, height: ROW_H, borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: rowText(i).id, containerName: rowText(i).name, content: rowContent(c, w + i === S.sel),
      isEventCapture: 0, textColor: w + i === S.sel ? 4 : 2,
    }))
  }
  return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
}

// Avatar bytes per row slot; null = nothing sent yet since the last rebuild.
let slotAvatar: (string | null)[] = [null, null, null, null]
let monoCache = new Map<string, Promise<Uint8Array>>()
function monogram(name: string): Promise<Uint8Array> {
  // Fallback avatar (and blank slot when name is ''): letter in a ring, drawn on a canvas.
  if (!monoCache.has(name)) monoCache.set(name, new Promise((resolve) => {
    const cv = document.createElement('canvas'); cv.width = AV; cv.height = AV
    const g = cv.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, AV, AV)
    if (name) {
      g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(AV / 2, AV / 2, AV / 2 - 3, 0, Math.PI * 2); g.stroke()
      g.fillStyle = '#fff'; g.font = `bold ${AV * 0.5}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText((name.match(/[A-Za-z]/)?.[0] ?? '?').toUpperCase(), AV / 2, AV / 2 + 1)
    }
    cv.toBlob(async (b) => resolve(new Uint8Array(await b!.arrayBuffer())), 'image/png')
  }))
  return monoCache.get(name)!
}
function pushAvatars() {
  if (S.screen !== 'bots') return
  const w = winStart()
  for (let i = 0; i < ROWS; i++) {
    const c = S.convs[w + i], key = c?.hudAvatar ?? ''
    if (slotAvatar[i] === key) continue
    slotAvatar[i] = key
    enqueue(async () => {
      if (S.screen !== 'bots' || slotAvatar[i] !== key) return
      const bytes = (c && (await avatarData(c.hudAvatar))) || (await monogram(c?.name ?? ''))
      const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: rowImg(i).id, containerName: rowImg(i).name, imageData: bytes }))
      if (!ImageRawDataUpdateResult.isSuccess(ImageRawDataUpdateResult.normalize(r))) { console.warn('avatar', key, r); slotAvatar[i] = null }
    })
  }
}
let listTimer: number | null = null
function refreshList() {
  // Flicker-free list update: header + 4 row texts (brightness marks the selection), then any changed avatars.
  ui.render(S)
  if (S.screen !== 'bots' || listTimer !== null) return
  listTimer = window.setTimeout(() => {
    listTimer = null
    const w = winStart()
    enqueue(async () => {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header() }))
      for (let i = 0; i < ROWS; i++) {
        const sel = w + i === S.sel
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: rowText(i).id, containerName: rowText(i).name, content: rowContent(S.convs[w + i], sel), textColor: sel ? 4 : 2 }))
      }
    })
    pushAvatars()
  }, 120)
}
function moveSel(d: number) {
  const n = Math.max(0, Math.min(S.convs.length - 1, S.sel + d))
  if (n !== S.sel) { S.sel = n; refreshList() }
}
function chatPage() {
  return {
    containerTotalNum: 2,
    textObject: [textC(HEADER, 0, 34, header(), 0, 3), textC(BODY, 36, 252, S.pages[S.page] ?? '', 1)],
  }
}
const MENU = { menuItems: [
  { itemID: 1, itemName: 'Bot list' },
  { itemID: 2, itemName: 'Check for reply' },
  { itemID: 3, itemName: 'Interrupt bot' },
  { itemID: 4, itemName: 'Re-ask last' },
  { itemID: 5, itemName: 'Mic: glasses/phone' },
] }

let started = false
function rebuild() {
  const page = S.screen === 'bots' ? botsPage() : chatPage()
  slotAvatar = [null, null, null, null] // image containers come back empty after create/rebuild
  const done = enqueue(async () => {
    if (!started) {
      started = true
      const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ ...page, menuObject: MENU as any }))
      if (r !== 0) console.error('createStartUpPageContainer failed', r)
    } else {
      await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page, menuObject: MENU as any }))
    }
  })
  pushAvatars()
  return done
}
let renderTimer: number | null = null
function refresh() {
  // Text-only update for the chat screen (flicker-free); debounced 120 ms.
  ui.render(S)
  if (S.screen !== 'chat' || renderTimer !== null) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    enqueue(async () => {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header() }))
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BODY.id, containerName: BODY.name, content: (S.pages[S.page] ?? '').slice(0, 1990) }))
    })
  }, 120)
}
function show(text: string, phase: Phase) {
  S.phase = phase
  S.pages = paginate(text)
  S.page = 0
  refresh()
}

// ───────────────────────── actions ─────────────────────────
async function openBot(name: string) {
  S.bot = name
  await store.set('bot', name)
  await markSeen(name)
  S.screen = 'chat'
  S.phase = 'idle'
  S.pages = paginate(`${name}\n\nTap to talk (tap again to send), or hold to talk.\nSwipe ▲▼ to page. Double-tap: bot list.`)
  S.page = 0
  await rebuild()
  ui.render(S)
  ui.loadHistory(name)
}
async function openBotList() {
  if (S.phase === 'listening') await stopMic(false)
  if (S.screen === 'chat') await markSeen(S.bot)
  S.screen = 'bots'
  const i = S.convs.findIndex((c) => c.name === S.bot)
  S.sel = i >= 0 ? i : 0
  await rebuild()
  ui.render(S)
  loadConvs()
}

async function startMic() {
  if (S.phase === 'listening' || S.phase === 'thinking' || S.phase === 'streaming' || S.phase === 'transcribing') return
  pcmChunks = []; pcmBytes = 0
  const ok = await bridge.audioControl(true, S.micSource)
  if (ok === false) { show('Could not start the microphone (permission?)', 'error'); return }
  show(`Listening… (${S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses'} mic)\n\nTap again or release to send.`, 'listening')
}
async function stopMic(send = true) {
  if (S.phase !== 'listening') return
  await bridge.audioControl(false)
  const pcm = new Uint8Array(pcmBytes)
  let o = 0
  for (const c of pcmChunks) { pcm.set(c, o); o += c.length }
  pcmChunks = []; pcmBytes = 0
  if (!send) { show('Cancelled.', 'idle'); return }
  if (pcm.length < 16000) { show('Too short — tap and speak, then tap again.', 'idle'); return }
  show('Transcribing…', 'transcribing')
  try {
    const { text } = await api.stt(pcm)
    if (!text) { show('Did not catch that. Tap to try again.', 'idle'); return }
    await sendPrompt(text)
  } catch (e) { show(`Speech-to-text failed:\n${(e as Error).message}`, 'error') }
}

let inflight = false
export async function sendPrompt(text: string, bot = S.bot) {
  if (inflight) { ui.toast('Still waiting for the previous reply'); return }
  inflight = true
  S.lastPrompt = text
  if (bot !== S.bot || S.screen !== 'chat') await openBot(bot)
  ui.addMessage({ role: 'user', text, at: Date.now() })
  show(`» ${text}\n\n${bot} is thinking…`, 'thinking')
  const t0 = Date.now()
  const turn: string[] = []
  // Each bot message is appended; the HUD jumps to the first page of the newest message,
  // and swipe pages through the whole turn. Header shows "▸ more coming" until the turn ends.
  const showTurn = (phase: Phase) => {
    // Every message starts on a fresh page; jump to the newest message's first page.
    const per = turn.map((m) => paginate(m))
    S.phase = phase
    S.pages = per.flat()
    S.page = per.slice(0, -1).reduce((n, p) => n + p.length, 0)
    refresh()
  }
  try {
    let streamed = false
    try {
      await chatStream(bot, text, (e) => {
        streamed = true
        if (e.type === 'message') {
          turn.push(e.text)
          ui.addMessage({ role: 'bot', text: e.text, at: Date.now() })
          if (S.screen === 'chat' && S.bot === bot) markSeen(bot)
          console.log(`msg ${e.index} at ${e.ms} ms`)
          showTurn('streaming')
        } else if (e.type === 'done') {
          if (!turn.length) turn.push(e.status === 'running' ? '(still working — Menu → Check for reply)' : '(no reply text)')
          else if (e.status === 'running') turn.push('(still working — Menu → Check for reply)')
          showTurn('reply')
          console.log(`turn done in ${e.ms} ms, ${e.messages} msgs`)
        } else if (e.type === 'error') {
          throw Object.assign(new Error(e.error), { status: e.status })
        }
      })
      if (S.phase === 'streaming' || S.phase === 'thinking') showTurn('reply') // stream ended without "done"
    } catch (e) {
      const err = e as Error & { status?: number }
      if (streamed || err.status === 409) throw err
      // Fallback: non-streaming /chat (+ /check polling)
      const reply = await askAndWait(bot, text, (partial) => show(partial, 'thinking'))
      ui.addMessage({ role: 'bot', text: reply, at: Date.now() })
      show(reply, 'reply')
    }
    console.log(`reply in ${Date.now() - t0} ms`)
    loadConvs()
  } catch (e) {
    const err = e as Error & { status?: number }
    show(err.status === 409 ? `${bot} is busy with an earlier message.\nMenu → Check for reply.` : `Error: ${err.message}`, 'error')
  } finally { inflight = false }
}
async function checkReply() {
  show('Checking…', 'thinking')
  try { const r = await api.check(S.bot, 20); show(r.reply || (r.status === 'running' ? 'Still working…' : 'Nothing new.'), r.reply ? 'reply' : 'idle') }
  catch (e) { show(`Error: ${(e as Error).message}`, 'error') }
}
async function interrupt() {
  try { await api.interrupt(S.bot); show('Interrupted.', 'idle') } catch (e) { show(`Error: ${(e as Error).message}`, 'error') }
}
function pageBy(d: number) {
  const n = Math.max(0, Math.min(S.pages.length - 1, S.page + d))
  if (n !== S.page) { S.page = n; refresh() }
}
async function toggleMicSource() {
  S.micSource = S.micSource === AudioInputSource.Glasses ? AudioInputSource.Phone : AudioInputSource.Glasses
  await store.set('mic', S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses')
  show(`Mic: ${S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses'}`, 'idle')
}

// ───────────────────────── events ─────────────────────────
const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? e.eventType ?? OsEventTypeList.CLICK_EVENT : null)
let cleanedUp = false
function cleanup() { if (cleanedUp) return; cleanedUp = true; bridge.audioControl(false); unsubscribe() }

const unsubscribe = bridge.onEvenHubEvent((event) => {
  if (event.audioEvent?.audioPcm) {
    if (S.phase === 'listening' && pcmBytes < MAX_PCM) { pcmChunks.push(event.audioEvent.audioPcm); pcmBytes += event.audioEvent.audioPcm.length }
    return
  }
  if (event.menuItemClickEvent) {
    const id = event.menuItemClickEvent.itemID
    if (id === 1) openBotList()
    else if (id === 2) checkReply()
    else if (id === 3) interrupt()
    else if (id === 4 && S.lastPrompt) sendPrompt(S.lastPrompt)
    else if (id === 5) toggleMicSource()
    return
  }
  const sys = typeOf(event.sysEvent), txt = typeOf(event.textEvent), lst = typeOf(event.listEvent)
  const t = sys ?? txt ?? lst
  if (t === null) return

  if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) { cleanup(); return }
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { rebuild(); return }
  if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT) { if (S.phase === 'listening') stopMic(false); return }

  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Root page = bot list → system exit dialog (required by QA). Chat page → back to list.
    if (S.screen === 'bots') bridge.shutDownPageContainer(1)
    else openBotList()
    return
  }

  if (S.screen === 'bots') {
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return moveSel(-1)
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return moveSel(1)
    if (t === OsEventTypeList.CLICK_EVENT) { const c = S.convs[S.sel]; if (c) openBot(c.name) }
    return
  }

  // chat screen
  if (t === OsEventTypeList.SCROLL_TOP_EVENT) return pageBy(-1)
  if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return pageBy(1)
  if (t === OsEventTypeList.LONG_PRESS_EVENT) { startMic(); return }
  if (t === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { stopMic(true); return }
  if (t === OsEventTypeList.CLICK_EVENT) {
    if (S.phase === 'listening') stopMic(true)
    else if (S.phase === 'thinking' || S.phase === 'streaming') ui.toast('Waiting for reply…')
    else startMic()
  }
})
window.addEventListener('beforeunload', cleanup)

// ───────────────────────── boot ─────────────────────────
ui.mount({
  state: S,
  onSend: (text, bot) => sendPrompt(text, bot),
  onPickBot: (bot) => openBot(bot),
  onBack: () => openBotList(),
  onTalk: () => (S.phase === 'listening' ? stopMic(true) : startMic()),
  onCheck: checkReply,
  onInterrupt: interrupt,
  onSaveSettings: async (relayUrl, token, pairCode) => {
    cfg.relayUrl = relayUrl.trim() || cfg.relayUrl; if (token.trim()) cfg.token = token.trim()
    if (pairCode.trim()) {
      try { cfg.token = await api.pair(pairCode.trim()); ui.setStatus('ok', 'Paired ✓'); ui.settingsSaved() }
      catch (e) { ui.setStatus('error', `Pairing failed: ${(e as Error).message}`); return }
    }
    await store.set('relayUrl', cfg.relayUrl); await store.set('relayToken', cfg.token)
    await loadBots()
  },
  cfg,
})

async function loadConvs() {
  try {
    const r = await api.conversations()
    const selName = S.convs[S.sel]?.name
    S.convs = r.conversations
    S.bots = r.conversations.map((c) => ({ name: c.name, id: c.id }))
    if (!S.bots.find((b) => b.name === S.bot)) S.bot = r.default
    const i = S.convs.findIndex((c) => c.name === selName)
    S.sel = i >= 0 ? i : Math.min(S.sel, Math.max(0, S.convs.length - 1))
    ui.setStatus('ok', `Relay connected · ${S.bots.length} bots`)
  } catch (e) {
    ui.setStatus('error', `Relay: ${(e as Error).message}`)
  }
  if (S.screen === 'bots') refreshList()
  else ui.render(S)
}
const loadBots = loadConvs
// Keep previews / unread dots fresh while the list is showing.
window.setInterval(() => { if (S.screen === 'bots' && cfg.token && !document.hidden) loadConvs() }, 30_000)
await rebuild()
await loadConvs()
