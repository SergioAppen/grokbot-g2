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
import { api, askAndWait, avatarData, chatStream, cfg, relTime, type Action, type Bot, type Conversation, type Msg } from './api'
import { paginate, sanitize, textWidth, charWidth } from './paginate'
import { ui } from './ui'

// ───────────────────────── state ─────────────────────────
type Screen = 'bots' | 'chat' | 'actions'
type Phase = 'idle' | 'listening' | 'transcribing' | 'sending' | 'thinking' | 'streaming' | 'reply' | 'error'
/** One message in the HUD read view, pre-split into pages (see paginate.ts). */
type Item = { role: Msg['role']; text: string; at: number; pages: string[] }
const S = {
  screen: 'bots' as Screen,
  screenAt: 0,                   // when the screen last changed (ignores the tap that opened it)
  phase: 'idle' as Phase,
  bots: [] as Bot[],
  convs: [] as Conversation[],   // newest first (relay /conversations)
  sel: 0,                        // highlighted row on the HUD conversation list (row 0 = Quick actions)
  seen: {} as Record<string, number>, // last time each conversation was opened (unread dot)
  bot: '',
  items: [] as Item[],           // read view: messages of the open conversation
  mi: 0, pi: 0,                  // read position: message index, page index within it
  unseenFrom: null as number | null, // first message that arrived while reading earlier pages ("new" hint)
  overlay: '' as string,         // transient body text (listening / transcribing / sending)
  actions: [] as Action[],
  asel: 0,                       // highlighted quick action
  // phone preview compatibility
  pages: [''] as string[],
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
try { S.actions = JSON.parse((await store.get('actions')) || '[]') } catch { S.actions = [] }
export const isUnread = (c: Conversation) => !!c.last && c.last.role === 'bot' && c.last.at > (S.seen[c.name] ?? 0)
async function markSeen(name: string) { S.seen[name] = Date.now(); await store.set('seen', JSON.stringify(S.seen)) }
S.micSource = (await store.get('mic')) === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses

// ───────────────────────── glasses rendering ─────────────────────────
// Serialize all bridge writes; the BLE render queue is slow.
let chain: Promise<unknown> = Promise.resolve()
const enqueue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch((e) => console.error('render', e)))

const HEADER = { id: 1, name: 'header' }
const BODY = { id: 2, name: 'body' }
const FOOTER = { id: 3, name: 'footer' }
const CAPTURE = { id: 5, name: 'input' }
const TEXT_W = 568 // 576 px container minus 2×4 px padding
const DEBUG = new URLSearchParams(location.search).has('debug') // ?debug logs every HUD text update (tests)

/** Cut a single line to fit the HUD width (measured glyph widths), adding "…". */
function fit(line: string, width = TEXT_W - 8): string {
  if (textWidth(line) <= width) return line
  let out = '', w = charWidth('…')
  for (const c of line) { if (w + charWidth(c) > width) break; out += c; w += charWidth(c) }
  return out.replace(/\s+$/, '') + '…'
}

// Conversation-list rows: row 0 is the "Quick actions" entry, then one row per bot conversation.
type Row = { kind: 'actions' } | { kind: 'conv'; c: Conversation }
const listRows = (): Row[] => [{ kind: 'actions' }, ...S.convs.map((c) => ({ kind: 'conv' as const, c }))]

function header(): string {
  if (S.screen === 'bots') {
    if (!cfg.token) return 'NOT PAIRED · phone screen → Settings → code'
    const n = listRows().length, w = winStart()
    const unread = S.convs.filter(isUnread).length
    return `CHATS${unread ? `  ● ${unread} new` : ''}   ${w + 1}-${Math.min(n, w + ROWS)}/${n}  ▲▼`
  }
  if (S.screen === 'actions') {
    const n = S.actions.length
    return fit(`QUICK ACTIONS   ${n ? `${S.asel + 1}/${n}  ▲▼` : ''}`)
  }
  const icon = { idle: '', listening: '● REC', transcribing: '… transcribing', sending: '… sending', thinking: '… thinking', streaming: '… more coming', reply: '', error: '! error' }[S.phase]
  const it = S.items[S.mi]
  const pos = S.overlay || !it ? '' : `msg ${S.mi + 1}/${S.items.length}${it.pages.length > 1 ? ` · p ${S.pi + 1}/${it.pages.length}` : ''}`
  const right = [pos, icon].filter(Boolean).join('  ')
  // Bot name gets whatever width is left after the position/status part.
  return fit(`${fit(S.bot, Math.max(80, TEXT_W - 16 - textWidth(` · ${right}`)))}${right ? ` · ${right}` : ''}`)
}
function newCount(): number {
  if (S.unseenFrom === null) return 0
  return Math.max(0, S.items.length - Math.max(S.unseenFrom, S.mi + 1))
}
function footer(): string {
  if (S.screen === 'actions') return S.actions.length ? 'Tap: send   2xTap: back' : '2xTap: back'
  if (S.screen !== 'chat') return ''
  const n = newCount()
  const hint = n ? `↓ ${n} new  ` : ''
  if (S.phase === 'listening') return 'Tap: send   2xTap: cancel'
  if (S.phase === 'transcribing' || S.phase === 'sending' || S.phase === 'thinking' || S.phase === 'streaming') return fit(`${hint}▲▼ read   2xTap: list`)
  return fit(`${hint}Tap: talk   ▲▼ read   2xTap: list`)
}
function body(): string {
  if (S.overlay) return S.overlay
  const it = S.items[S.mi]
  return it ? it.pages[S.pi] ?? '' : ''
}

// Single-line containers (header/footer) need ≥ 27 px inside the padding, or the firmware shows a scrollbar.
function textC(c: { id: number; name: string }, y: number, h: number, content: string, textColor?: number, pad = 4) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: y, width: 576, height: h, borderWidth: 0, borderColor: 0, paddingLength: pad,
    containerID: c.id, containerName: c.name, content: content.slice(0, 990), isEventCapture: 0,
    ...(textColor !== undefined ? { textColor } : {}),
  })
}
// A blank full-screen text container, declared first (drawn behind), takes all input. Its content never changes,
// so the firmware never scrolls it and every swipe arrives as a boundary event (Even's documented pattern).
const captureC = () => new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0, paddingLength: 0,
  containerID: CAPTURE.id, containerName: CAPTURE.name, content: ' ', isEventCapture: 1,
})

// ── HUD conversation list: the SDK list container only takes strings (itemName: string[]), so rows are
// composed from 4 image containers (avatars; max 4 per page, 20–288 × 20–144 px) + 4 text containers.
// Selection = "▶" + brightness.
const ROWS = 4, ROW_H = 64, TOP = 32, AV = 40
const rowText = (i: number) => ({ id: 20 + i, name: `row${i}` })
const rowImg = (i: number) => ({ id: 10 + i, name: `av${i}` })
const winStart = () => Math.floor(S.sel / ROWS) * ROWS
function rowContent(r: Row | undefined, selected: boolean): string {
  if (!r) return ''
  const mark = selected ? '▶ ' : '   '
  if (r.kind === 'actions') {
    const n = S.actions.length
    return `${mark}Quick actions\n   ${n ? `${n} saved · ${S.actions.slice(0, 3).map((a) => a.label).join(', ')}` : 'None yet: add them on the phone'}`.split('\n').map((l) => fit(l, 500)).join('\n')
  }
  const c = r.c
  const when = c.last ? `  · ${relTime(c.last.at)}` : ''
  const prev = c.last ? `${c.last.role === 'user' ? 'You: ' : ''}${sanitize(c.last.text).replace(/\s+/g, ' ')}` : 'No messages yet'
  return `${fit(`${mark}${c.name}${isUnread(c) ? '  ●' : ''}${when}`, 500)}\n${fit(`   ${prev}`, 500)}`
}
function botsPage() {
  const w = winStart(), rows = listRows()
  const textObject = [captureC(), new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: TOP, borderWidth: 0, borderColor: 0, paddingLength: 2,
    containerID: HEADER.id, containerName: HEADER.name, content: header(), isEventCapture: 0, textColor: 3,
  })]
  const imageObject: ImageContainerProperty[] = []
  for (let i = 0; i < ROWS; i++) {
    const y = TOP + i * ROW_H
    imageObject.push(new ImageContainerProperty({ xPosition: 10, yPosition: y + (ROW_H - AV) / 2, width: AV, height: AV, containerID: rowImg(i).id, containerName: rowImg(i).name }))
    textObject.push(new TextContainerProperty({
      xPosition: 56, yPosition: y, width: 520, height: ROW_H, borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: rowText(i).id, containerName: rowText(i).name, content: rowContent(rows[w + i], w + i === S.sel),
      isEventCapture: 0, textColor: w + i === S.sel ? 4 : 2,
    }))
  }
  return { containerTotalNum: textObject.length + imageObject.length, textObject, imageObject }
}

// Avatar bytes per row slot; null = nothing sent yet since the last rebuild.
let slotAvatar: (string | null)[] = [null, null, null, null]
const iconCache = new Map<string, Promise<Uint8Array>>()
function drawIcon(key: string, draw: (g: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
  if (!iconCache.has(key)) iconCache.set(key, new Promise((resolve) => {
    const cv = document.createElement('canvas'); cv.width = AV; cv.height = AV
    const g = cv.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, AV, AV)
    draw(g)
    cv.toBlob(async (b) => resolve(new Uint8Array(await b!.arrayBuffer())), 'image/png')
  }))
  return iconCache.get(key)!
}
// Fallback avatar (and blank slot when name is ''): letter in a ring.
const monogram = (name: string) => drawIcon(`m:${name}`, (g) => {
  if (!name) return
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(AV / 2, AV / 2, AV / 2 - 3, 0, Math.PI * 2); g.stroke()
  g.fillStyle = '#fff'; g.font = `bold ${AV * 0.5}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText((name.match(/[A-Za-z]/)?.[0] ?? '?').toUpperCase(), AV / 2, AV / 2 + 1)
})
// Quick-actions icon: a lightning bolt in a ring (an image, since the HUD font has no emoji).
const boltIcon = () => drawIcon('bolt', (g) => {
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(AV / 2, AV / 2, AV / 2 - 3, 0, Math.PI * 2); g.stroke()
  g.fillStyle = '#fff'; g.beginPath()
  for (const [x, y] of [[23, 7], [12, 22], [19, 22], [16, 33], [28, 17], [21, 17], [23, 7]]) g.lineTo(x, y)
  g.fill()
})
function pushAvatars() {
  if (S.screen !== 'bots') return
  const w = winStart(), rows = listRows()
  for (let i = 0; i < ROWS; i++) {
    const r = rows[w + i], key = !r ? '' : r.kind === 'actions' ? 'bolt' : r.c.hudAvatar
    if (slotAvatar[i] === key) continue
    slotAvatar[i] = key
    enqueue(async () => {
      if (S.screen !== 'bots' || slotAvatar[i] !== key) return
      const bytes = !r ? await monogram('') : r.kind === 'actions' ? await boltIcon() : (await avatarData(r.c.hudAvatar)) || (await monogram(r.c.name))
      const res = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: rowImg(i).id, containerName: rowImg(i).name, imageData: bytes }))
      if (!ImageRawDataUpdateResult.isSuccess(ImageRawDataUpdateResult.normalize(res))) { console.warn('avatar', key, res); slotAvatar[i] = null }
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
    const w = winStart(), rows = listRows()
    enqueue(async () => {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header() }))
      for (let i = 0; i < ROWS; i++) {
        const sel = w + i === S.sel
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: rowText(i).id, containerName: rowText(i).name, content: rowContent(rows[w + i], sel), textColor: sel ? 4 : 2 }))
      }
    })
    pushAvatars()
  }, 120)
}
function moveSel(d: number) {
  const n = Math.max(0, Math.min(listRows().length - 1, S.sel + d))
  if (n !== S.sel) { S.sel = n; refreshList() }
}

// ── Read view / quick actions: header line, 7-line body, footer hint line.
const BODY_Y = 32, BODY_H = 224, FOOTER_Y = 256
function actionsBody(): string {
  if (!S.actions.length) return 'No quick actions yet.\n\nOn the phone: Quick actions → Add.\nEach one sends a fixed message to a bot.'
  const VIS = 7, start = Math.max(0, Math.min(S.asel - 3, S.actions.length - VIS))
  return S.actions.slice(start, start + VIS).map((a, k) => fit(`${start + k === S.asel ? '▶ ' : '   '}${a.label} > ${a.bot}`)).join('\n')
}
function textPage() {
  const content = S.screen === 'actions' ? actionsBody() : body()
  return {
    containerTotalNum: 4,
    textObject: [captureC(), textC(HEADER, 0, 32, header(), 3, 2), textC(BODY, BODY_Y, BODY_H, content), textC(FOOTER, FOOTER_Y, 32, footer(), 2, 2)],
  }
}
const MENU = { menuItems: [
  { itemID: 1, itemName: 'Bot list' },
  { itemID: 2, itemName: 'Check for reply' },
  { itemID: 3, itemName: 'Interrupt bot' },
  { itemID: 4, itemName: 'Re-ask last' },
  { itemID: 5, itemName: 'Mic: glasses/phone' },
  { itemID: 6, itemName: 'Quick actions' },
] }

let started = false
function rebuild() {
  const page = S.screen === 'bots' ? botsPage() : textPage()
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
function setScreen(s: Screen) { S.screen = s; S.screenAt = Date.now() }
let renderTimer: number | null = null
function refresh() {
  // Text-only update for the read view / actions screen (flicker-free); debounced 120 ms.
  syncPreview()
  ui.render(S)
  if (S.screen === 'bots' || renderTimer !== null) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    const content = S.screen === 'actions' ? actionsBody() : body()
    if (DEBUG) console.log('[hud]', JSON.stringify({ h: header(), b: content, f: footer() }))
    enqueue(async () => {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header() }))
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BODY.id, containerName: BODY.name, content }))
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: FOOTER.id, containerName: FOOTER.name, content: footer() }))
    })
  }, 120)
}
// Phone-side "glasses preview" box mirrors the three HUD lines.
function syncPreview() { S.pages = [S.screen === 'bots' ? '' : `${header()}\n${S.screen === 'actions' ? actionsBody() : body()}\n${footer()}`]; S.page = 0 }

// ── read-view model
function toItem(m: Pick<Msg, 'role' | 'text' | 'at'>): Item {
  const prefix = m.role === 'user' ? '» You: ' : m.role === 'system' ? '! ' : ''
  return { role: m.role, text: m.text, at: m.at, pages: paginate(prefix + m.text) }
}
const atEnd = () => !S.items.length || (S.mi === S.items.length - 1 && S.pi >= S.items[S.mi].pages.length - 1)
/** Append a message. Follows it only if the reader was already at the end; otherwise shows the "↓ n new" hint. */
function addItem(m: Pick<Msg, 'role' | 'text' | 'at'>, follow = atEnd() && !S.overlay) {
  S.items.push(toItem(m))
  if (follow || S.overlay) { S.mi = S.items.length - 1; S.pi = 0; S.overlay = '' }
  else if (S.unseenFrom === null) S.unseenFrom = S.items.length - 1
  if (S.unseenFrom !== null && S.unseenFrom <= S.mi) S.unseenFrom = S.mi + 1 < S.items.length ? S.mi + 1 : null
  refresh()
}
/** Transient body text (listening, transcribing, errors before a turn exists). Cleared by the next message or a swipe. */
function show(text: string, phase: Phase) {
  S.phase = phase
  S.overlay = paginate(text)[0]
  refresh()
}
function setPhase(phase: Phase) { S.phase = phase; refresh() }
function note(text: string, phase: Phase = 'error') { S.phase = phase; S.overlay = ''; addItem({ role: 'system', text, at: Date.now() }, true) }

function pageBy(d: number) {
  if (S.overlay && S.phase !== 'listening') { S.overlay = ''; refresh(); return }
  if (S.overlay) return
  const it = S.items[S.mi]; if (!it) return
  let { mi, pi } = S
  if (d > 0) { if (pi < it.pages.length - 1) pi++; else if (mi < S.items.length - 1) { mi++; pi = 0 } }
  else { if (pi > 0) pi--; else if (mi > 0) { mi--; pi = S.items[mi].pages.length - 1 } }
  if (mi === S.mi && pi === S.pi) return
  S.mi = mi; S.pi = pi
  if (S.unseenFrom !== null && S.mi >= S.unseenFrom) S.unseenFrom = S.mi + 1 < S.items.length ? S.mi + 1 : null
  if (atEnd()) markSeen(S.bot)
  refresh()
}

// ───────────────────────── actions ─────────────────────────
let openSeq = 0
/** Open the READ view of a conversation (history + anything that arrived while away). Never starts the mic. */
async function openBot(name: string, opts: { quiet?: boolean } = {}) {
  const seq = ++openSeq
  const lastSeen = S.seen[name] ?? 0
  S.bot = name
  await store.set('bot', name)
  setScreen('chat')
  S.phase = 'idle'
  S.items = []; S.mi = 0; S.pi = 0; S.unseenFrom = null
  S.overlay = opts.quiet ? '' : `${name}\n\nLoading conversation…`
  await rebuild()
  ui.render(S)
  ui.loadHistory(name)
  let msgs: Msg[] = []
  try { msgs = (await api.history(name)).messages } catch (e) { if (!opts.quiet) show(`Could not load history:\n${(e as Error).message}`, 'error') }
  if (seq !== openSeq || S.bot !== name) return
  const keep = msgs.slice(-40)
  const pending = S.items // messages added while loading (quick action / stream) stay at the end
  S.items = [...keep.map(toItem), ...pending.filter((p) => !keep.some((k) => k.at === p.at && k.text === p.text))]
  if (!S.items.length) { S.overlay = `${name}\n\nNo messages yet.\nTap to talk, or hold to talk.`; refresh(); return }
  // Start at the first unread bot message, else at the most recent message.
  const firstUnread = S.items.findIndex((m) => m.role === 'bot' && m.at > lastSeen)
  if (pending.length) { S.mi = S.items.length - pending.length; S.pi = 0 }
  else { S.mi = firstUnread >= 0 ? firstUnread : S.items.length - 1; S.pi = 0 }
  S.overlay = ''
  if (firstUnread >= 0 && firstUnread < S.items.length - 1 && !pending.length) S.unseenFrom = firstUnread + 1
  if (atEnd()) markSeen(name)
  refresh()
  if (!opts.quiet) pullPassive(name)
}
/** Messages the bot sent on its own while we were away: ask the relay once (it records them in history). */
async function pullPassive(name: string) {
  if (inflight || S.bot !== name || S.screen !== 'chat') return
  try {
    const r = await api.check(name, 0)
    if (r.reply && S.bot === name && S.screen === 'chat' && !inflight) {
      addItem({ role: 'bot', text: r.reply, at: Date.now() })
      ui.addMessage({ role: 'bot', text: r.reply, at: Date.now() })
    }
  } catch { /* busy or offline: the next open/poll will catch up */ }
}
async function openBotList() {
  if (S.phase === 'listening') await stopMic(false)
  if (S.screen === 'chat' && atEnd()) await markSeen(S.bot)
  setScreen('bots')
  const i = S.convs.findIndex((c) => c.name === S.bot)
  S.sel = i >= 0 ? i + 1 : 0
  await rebuild()
  ui.render(S)
  loadConvs()
}
async function openActions() {
  if (S.phase === 'listening') await stopMic(false)
  setScreen('actions')
  S.asel = Math.min(S.asel, Math.max(0, S.actions.length - 1))
  await rebuild()
  loadActions()
}
async function fireAction(a: Action) {
  if (inflight) { note(`Still waiting for ${S.bot}'s reply.\nTry again when it is done.`, S.phase); return }
  await sendPrompt(a.text, a.bot)
}

async function startMic() {
  if (S.phase === 'listening' || S.phase === 'thinking' || S.phase === 'streaming' || S.phase === 'transcribing' || S.phase === 'sending') return
  pcmChunks = []; pcmBytes = 0
  const ok = await bridge.audioControl(true, S.micSource)
  if (ok === false) { show('Could not start the microphone (permission?)', 'error'); return }
  show(`Listening… (${S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses'} mic)\n\nTap again or release to send.\nDouble-tap to cancel.`, 'listening')
}
async function stopMic(send = true) {
  if (S.phase !== 'listening') return
  await bridge.audioControl(false)
  const pcm = new Uint8Array(pcmBytes)
  let o = 0
  for (const c of pcmChunks) { pcm.set(c, o); o += c.length }
  pcmChunks = []; pcmBytes = 0
  if (!send) { S.overlay = ''; setPhase('idle'); return }
  if (pcm.length < 16000) { show('Too short. Tap and speak, then tap again.', 'idle'); return }
  show('Transcribing…', 'transcribing')
  try {
    const { text, provider, fallbackFrom } = await api.stt(pcm)
    if (fallbackFrom?.length) ui.toast(`Speech-to-text: ${fallbackFrom.join(', ')} failed, used ${provider}`)
    if (!text) { show('Did not catch that. Tap to try again.', 'idle'); return }
    await sendPrompt(text)
  } catch (e) { S.overlay = ''; note(`Speech-to-text failed:\n${(e as Error).message}`) }
}

let inflight = false
export async function sendPrompt(text: string, bot = S.bot) {
  if (inflight) { ui.toast('Still waiting for the previous reply'); return }
  inflight = true
  S.lastPrompt = text
  try {
    if (bot !== S.bot || S.screen !== 'chat') await openBot(bot, { quiet: true })
    S.overlay = ''
    S.phase = 'sending'
    addItem({ role: 'user', text, at: Date.now() }, true)
    ui.addMessage({ role: 'user', text, at: Date.now() })
    const t0 = Date.now()
    let streamed = false, got = 0
    try {
      await chatStream(bot, text, (e) => {
        streamed = true
        if (e.type === 'status') setPhase('thinking')
        else if (e.type === 'message') {
          got++
          S.phase = 'streaming'
          addItem({ role: 'bot', text: e.text, at: Date.now() })
          ui.addMessage({ role: 'bot', text: e.text, at: Date.now() })
          if (S.screen === 'chat' && S.bot === bot && atEnd()) markSeen(bot)
          console.log(`msg ${e.index} at ${e.ms} ms`)
        } else if (e.type === 'done') {
          if (!got) addItem({ role: 'system', text: e.status === 'running' ? 'Still working. Menu → Check for reply.' : '(no reply text)', at: Date.now() })
          else if (e.status === 'running') addItem({ role: 'system', text: 'Still working. Menu → Check for reply.', at: Date.now() })
          setPhase('reply') // the reader stays where they are; nothing jumps
          console.log(`turn done in ${e.ms} ms, ${e.messages} msgs`)
        } else if (e.type === 'error') {
          throw Object.assign(new Error(e.error), { status: e.status })
        }
      })
      if ((S.phase as Phase) !== 'reply') setPhase('reply') // stream ended without "done"
    } catch (e) {
      const err = e as Error & { status?: number }
      if (streamed || err.status === 409) throw err
      // Fallback: non-streaming /chat (+ /check polling)
      setPhase('thinking')
      const reply = await askAndWait(bot, text)
      ui.addMessage({ role: 'bot', text: reply, at: Date.now() })
      S.phase = 'reply'
      addItem({ role: 'bot', text: reply, at: Date.now() })
    }
    console.log(`reply in ${Date.now() - t0} ms`)
    loadConvs()
  } catch (e) {
    const err = e as Error & { status?: number }
    note(err.status === 409 ? `${bot} is busy with an earlier message.\nWait for it to finish, or Menu → Check for reply.` : `Error: ${err.message}`)
  } finally { inflight = false }
}
async function checkReply() {
  if (inflight) { ui.toast('Waiting for reply…'); return }
  setPhase('thinking')
  try {
    const r = await api.check(S.bot, 20)
    if (r.reply) { S.phase = 'reply'; addItem({ role: 'bot', text: r.reply, at: Date.now() }); ui.addMessage({ role: 'bot', text: r.reply, at: Date.now() }) }
    else note(r.status === 'running' ? 'Still working…' : 'Nothing new.', 'idle')
  } catch (e) { note(`Error: ${(e as Error).message}`) }
}
async function interrupt() {
  try { await api.interrupt(S.bot); note('Interrupted.', 'idle') } catch (e) { note(`Error: ${(e as Error).message}`) }
}
async function toggleMicSource() {
  S.micSource = S.micSource === AudioInputSource.Glasses ? AudioInputSource.Phone : AudioInputSource.Glasses
  await store.set('mic', S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses')
  ui.toast(`Mic: ${S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses'}`)
  if (S.screen === 'chat') show(`Mic: ${S.micSource === AudioInputSource.Phone ? 'phone' : 'glasses'}`, S.phase === 'listening' ? 'idle' : S.phase)
}

// ───────────────────────── events ─────────────────────────
const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? e.eventType ?? OsEventTypeList.CLICK_EVENT : null)
let cleanedUp = false
function cleanup() { if (cleanedUp) return; cleanedUp = true; bridge.audioControl(false); unsubscribe() }
const TAP_GUARD_MS = 700 // a tap right after a screen change is the same tap that opened it

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
    else if (id === 6) openActions()
    return
  }
  const sys = typeOf(event.sysEvent), txt = typeOf(event.textEvent), lst = typeOf(event.listEvent)
  const t = sys ?? txt ?? lst
  if (t === null) return

  if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) { cleanup(); return }
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { rebuild(); return }
  if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT) { if (S.phase === 'listening') stopMic(false); return }
  const fresh = Date.now() - S.screenAt < TAP_GUARD_MS

  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Root page = bot list → system exit dialog (required by QA). Listening → cancel. Elsewhere → back to the list.
    if (S.screen === 'bots') bridge.shutDownPageContainer(1)
    else if (S.phase === 'listening') stopMic(false)
    else openBotList()
    return
  }

  if (S.screen === 'bots') {
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return moveSel(-1)
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return moveSel(1)
    if (t === OsEventTypeList.CLICK_EVENT && !fresh) {
      const r = listRows()[S.sel]
      if (r?.kind === 'actions') openActions()
      else if (r) openBot(r.c.name)
    }
    return
  }
  if (S.screen === 'actions') {
    const n = S.actions.length
    if (t === OsEventTypeList.SCROLL_TOP_EVENT && S.asel > 0) { S.asel--; refresh() }
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT && S.asel < n - 1) { S.asel++; refresh() }
    if (t === OsEventTypeList.CLICK_EVENT && !fresh && S.actions[S.asel]) fireAction(S.actions[S.asel])
    return
  }

  // read view: swipe = read, tap = talk, hold = push-to-talk
  if (t === OsEventTypeList.SCROLL_TOP_EVENT) return pageBy(-1)
  if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return pageBy(1)
  if (t === OsEventTypeList.LONG_PRESS_EVENT) { startMic(); return }
  if (t === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { stopMic(true); return }
  if (t === OsEventTypeList.CLICK_EVENT) {
    if (fresh) return
    if (S.phase === 'listening') stopMic(true)
    else if (inflight || S.phase === 'transcribing') ui.toast('Waiting for reply…')
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
    await loadActions()
  },
  onSaveActions: async (list) => {
    const r = await api.saveActions(list)
    await setActions(r.actions)
    return r.actions
  },
  onFireAction: (a) => fireAction(a),
  cfg,
})

async function setActions(list: Action[]) {
  S.actions = list
  await store.set('actions', JSON.stringify(list))
  S.asel = Math.min(S.asel, Math.max(0, list.length - 1))
  ui.renderActions(S)
  if (S.screen === 'bots') refreshList()
  else if (S.screen === 'actions') refresh()
}
async function loadActions() {
  if (!cfg.token) { ui.renderActions(S); return }
  try { await setActions((await api.actions()).actions) }
  catch (e) { console.warn('actions (using cached copy)', (e as Error).message); ui.renderActions(S) }
}

async function loadConvs() {
  try {
    const r = await api.conversations()
    const selRow = listRows()[S.sel]
    const selName = selRow?.kind === 'conv' ? selRow.c.name : null
    S.convs = r.conversations
    S.bots = r.conversations.map((c) => ({ name: c.name, id: c.id }))
    if (!S.bots.find((b) => b.name === S.bot)) S.bot = r.default
    const i = S.convs.findIndex((c) => c.name === selName)
    S.sel = selRow?.kind === 'actions' ? 0 : i >= 0 ? i + 1 : Math.min(S.sel, S.convs.length)
    ui.setStatus('ok', `Relay connected · ${S.bots.length} bots`)
  } catch (e) {
    ui.setStatus('error', `Relay: ${(e as Error).message}`)
  }
  if (S.screen === 'bots') refreshList()
  else ui.render(S)
}
const loadBots = loadConvs
// Keep previews / unread dots fresh while the list is showing; in the read view, pick up messages
// the bot sent on its own (relay /check, never while a turn of ours is in flight).
window.setInterval(() => {
  if (!cfg.token || document.hidden) return
  if (S.screen === 'bots') loadConvs()
  else if (S.screen === 'chat' && !inflight && (S.phase === 'idle' || S.phase === 'reply' || S.phase === 'error')) pullPassive(S.bot)
}, 30_000)
await rebuild()
await loadConvs()
await loadActions()
