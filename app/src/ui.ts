// Phone-side companion UI (rendered in the Even app WebView).
import { api, avatarUrl, relTime, ACTION_LIMITS, type Action, type Msg, type Bot, type Conversation, type SttSettings, type SttUpdate } from './api'

type Handlers = {
  state: { bot: string; bots: Bot[]; phase: string; screen: string; pages: string[]; page: number; convs: Conversation[]; seen: Record<string, number>; actions: Action[] }
  onSend: (text: string, bot: string) => void
  onPickBot: (bot: string) => void
  onBack: () => void
  onTalk: () => void
  onCheck: () => void
  onInterrupt: () => void
  onSaveSettings: (relayUrl: string, token: string, pairCode: string) => void
  onSaveActions: (actions: Action[]) => Promise<Action[]>
  onFireAction: (a: Action) => void
  cfg: { relayUrl: string; token: string }
}
let H: Handlers
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
let messages: Msg[] = []
let draft: Action[] = []      // quick-actions editor working copy
let dirty = false
let phoneActions = false       // phone is showing the Quick actions editor
let stt: SttSettings | null = null                          // last /settings snapshot (never contains key values)
const replacing: Record<string, boolean> = {}               // key rows where the user tapped "Replace"
const KEYS = [
  { k: 'elevenlabs', p: 'elevenlabs', label: 'ElevenLabs API key' },
  { k: 'xai', p: 'grok', label: 'xAI API key (Grok STT)' },
] as const
const PROVIDER_LABEL = { elevenlabs: 'ElevenLabs Scribe', grok: 'Grok STT (xAI)', whisper: 'Whisper (local, on the relay)' } as const
const CHECK_LABEL = { valid: 'key valid ✓', invalid: 'key rejected ✗', unknown: 'could not verify' } as const

const CSS = `
:root{color-scheme:dark;--t:#fff;--d:#8a8a8a;--bg:#111;--s:#1a1a1a;--in:rgba(255,255,255,.08);--a:#FEF991}
*{box-sizing:border-box}body{background:var(--bg);color:var(--t);font:16px/1.4 system-ui,-apple-system,sans-serif;margin:0}
#app{display:flex;flex-direction:column;height:100vh;padding:12px 16px;gap:10px}
header{display:flex;gap:8px;align-items:center}h1{font-size:20px;margin:0;flex:1;letter-spacing:-.02em}
select,input,textarea,button{font:inherit;color:var(--t);background:var(--in);border:0;border-radius:10px;padding:10px 12px}
button{background:var(--s);cursor:pointer}button.primary{background:var(--a);color:#111;font-weight:600}
#status,#status2{font-size:13px;color:var(--d)}.error{color:#ff7b7b!important}.ok{color:#9be29b!important}
#log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;background:var(--s);border-radius:12px;padding:10px}
.m{max-width:85%;padding:8px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.m.user{align-self:flex-end;background:#2a2a2a}.m.bot{align-self:flex-start;background:#1f2a1f}.m small{display:block;color:var(--d);font-size:11px}
#compose{display:flex;gap:8px}#compose textarea{flex:1;resize:none;height:48px}
.row{display:flex;gap:8px;flex-wrap:wrap}.row button{flex:1}
details{background:var(--s);border-radius:12px;padding:8px 12px}details input{width:100%;margin:4px 0}
#list{flex:1;min-height:0;overflow-y:auto;background:var(--s);border-radius:12px}
.c{display:flex;gap:12px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}
.c:active{background:rgba(255,255,255,.05)}.c img,.c .ph{width:48px;height:48px;border-radius:50%;flex:none;background:#2a2a2a;object-fit:cover}
.c .ph{display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--d)}
.c .mid{flex:1;min-width:0}.c .top{display:flex;gap:8px;align-items:baseline}.c .nm{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c .tm{font-size:12px;color:var(--d)}.c .tm.new{color:var(--a)}.c .pv{font-size:14px;color:var(--d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c .dot{width:10px;height:10px;border-radius:50%;background:var(--a);flex:none}
.chathead{display:flex;gap:10px;align-items:center}.chathead img{width:36px;height:36px;border-radius:50%;object-fit:cover}
.chathead h1{font-size:18px}#back{padding:8px 12px}
.hidden{display:none!important}
.qa{background:var(--s);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:6px}
.qa .r{display:flex;gap:6px}.qa .r input{flex:1;min-width:0}.qa .r select{flex:1;min-width:0}.qa textarea{width:100%;resize:vertical;min-height:56px}
.qa .r button{padding:8px 10px}#qalist{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.qa small{color:var(--d);font-size:12px}#qahint{font-size:13px;color:var(--d)}
#settings[open]{overflow-y:auto;min-height:0;flex:0 1 auto}
.stt{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}
.stt h2{font-size:15px;margin:0}.stt select{width:100%;margin-top:4px}.stt .chk{display:flex;gap:8px;align-items:center;font-size:14px}
.stt .chk input{width:auto;margin:0}.stt .key{background:var(--in);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.stt .key .r{display:flex;gap:6px;align-items:center}.stt .key .st{flex:1;font-size:13px;color:var(--d)}.stt .key .st.ok{color:#9be29b}
.stt .key button{padding:6px 10px;font-size:14px}.stt .key input{margin:0}.stt small{font-size:12px;color:var(--d)}#sttstatus{font-size:13px;color:var(--d)}
#hud{font-family:ui-monospace,monospace;font-size:12px;color:#3CFA44;background:#000;border-radius:8px;padding:6px 8px;white-space:pre-wrap;max-height:90px;overflow:hidden}
`

function qaStatus(kind: 'ok' | 'error' | 'info', text: string) { const s = $('qastatus'); if (s) { s.className = kind; s.textContent = text } }

export const ui = {
  mount(h: Handlers) {
    H = h
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st)
    $('app').innerHTML = `
      <section id="vlist" style="display:contents">
        <header><h1>Grok Bot · G2</h1><button id="qaopen">⚡ Quick actions</button></header>
        <div id="status">Connecting…</div>
        <div id="list"></div>
      </section>
      <section id="vchat" style="display:contents" class="hidden">
        <div class="chathead"><button id="back">‹ Chats</button><img id="cav" alt=""><h1 id="cname"></h1></div>
        <div id="status2"></div>
        <div id="hud" title="Glasses preview"></div>
        <div id="log"></div>
        <div class="row"><button id="talk">🎙 Talk</button><button id="check">Check reply</button><button id="stop">Interrupt</button></div>
        <div id="compose"><textarea id="text" placeholder="Type a message…"></textarea><button class="primary" id="send">Send</button></div>
      </section>
      <section id="vactions" style="display:contents" class="hidden">
        <div class="chathead"><button id="qaback">‹ Chats</button><h1>Quick actions</h1></div>
        <div id="qahint">Fixed messages you can send from the glasses without speaking: conversation list → Quick actions → tap one.</div>
        <div id="qalist"></div>
        <div class="row"><button id="qaadd">+ Add action</button><button class="primary" id="qasave">Save</button></div>
        <div id="qastatus"></div>
      </section>
      <details id="settings"><summary>Settings</summary>
        <label>Relay URL<input id="relay" placeholder="https://your-relay.example.com"></label>
        <label>Pairing code<input id="pair" inputmode="numeric" placeholder="6-digit code from ./run.sh pair"></label>
        <label>…or relay token<input id="token" type="password" placeholder="(stored on this phone)"></label>
        <button id="save">Save &amp; reconnect</button>
        <div class="stt hidden" id="stt">
          <h2>Voice · speech-to-text</h2>
          <label>Provider<select id="sttprov"></select></label>
          <label class="chk"><input type="checkbox" id="sttfb"> If it fails, try the other configured providers</label>
          <div id="sttkeys"></div>
          <button class="primary" id="sttsave">Save voice settings</button>
          <div id="sttstatus"></div>
          <small>Keys are write-only: they are stored on your relay (file mode 600), never shown again and never sent to the glasses. The Cursor API key is not set here; it stays in the relay's .env.</small>
        </div>
      </details>`
    $('back').onclick = () => h.onBack()
    $('qaopen').onclick = () => { phoneActions = true; dirty = false; draft = h.state.actions.map((a) => ({ ...a })); this.render(h.state); this.drawActions() }
    $('qaback').onclick = () => {
      if (dirty && !confirm('Discard unsaved quick-action changes?')) return
      phoneActions = false; dirty = false; this.render(h.state)
    }
    $('qaadd').onclick = () => {
      if (draft.length >= ACTION_LIMITS.max) return qaStatus('error', `At most ${ACTION_LIMITS.max} actions`)
      draft.push({ id: '', label: '', bot: h.state.bot || h.state.bots[0]?.name || '', text: '' }); dirty = true; this.drawActions()
      const last = $('qalist').lastElementChild?.querySelector('input'); (last as HTMLInputElement | null)?.focus()
    }
    $('qasave').onclick = async () => {
      const bad = draft.findIndex((a) => !a.label.trim() || !a.text.trim() || !a.bot)
      if (bad >= 0) return qaStatus('error', `Action ${bad + 1}: label, bot and message are all required`)
      qaStatus('info', 'Saving…')
      try { draft = (await h.onSaveActions(draft.map((a) => ({ ...a, label: a.label.trim(), text: a.text.trim() })))).map((a) => ({ ...a })); dirty = false; this.drawActions(); qaStatus('ok', 'Saved ✓ (the glasses list updates right away)') }
      catch (e) { qaStatus('error', `Save failed: ${(e as Error).message}`) }
    }
    $('qalist').oninput = (e) => {
      const el = e.target as HTMLInputElement; const card = el.closest('.qa') as HTMLElement | null; if (!card) return
      const a = draft[Number(card.dataset.i)]; const f = el.dataset.f as 'label' | 'bot' | 'text'
      if (a && f) { a[f] = el.value; dirty = true; if (f === 'text') { const c = card.querySelector('small'); if (c) c.textContent = `${el.value.length}/${ACTION_LIMITS.text}` } }
    }
    $('qalist').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button'); const card = b?.closest('.qa') as HTMLElement | null; if (!b || !card) return
      const i = Number(card.dataset.i), op = b.dataset.op
      if (op === 'up' && i > 0) [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]
      else if (op === 'down' && i < draft.length - 1) [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]
      else if (op === 'del') { if (!confirm(`Delete "${draft[i].label || 'this action'}"?`)) return; draft.splice(i, 1) }
      else if (op === 'send') { if (dirty) return qaStatus('error', 'Save first, then send'); phoneActions = false; this.render(h.state); h.onFireAction(draft[i]); return }
      else return
      dirty = true; this.drawActions()
    }
    $('list').onclick = (e) => { const row = (e.target as HTMLElement).closest('.c') as HTMLElement | null; if (row?.dataset.name) h.onPickBot(row.dataset.name) }
    $<HTMLInputElement>('relay').value = h.cfg.relayUrl
    if (!h.cfg.token) ($('settings') as HTMLDetailsElement).open = true
    $('send').onclick = () => {
      const t = $<HTMLTextAreaElement>('text'); const v = t.value.trim()
      if (v) { h.onSend(v, h.state.bot); t.value = '' }
    }
    $<HTMLTextAreaElement>('text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click() } }
    $('talk').onclick = () => h.onTalk()
    $('check').onclick = () => h.onCheck()
    $('stop').onclick = () => h.onInterrupt()
    $('settings').addEventListener('toggle', () => { if (($('settings') as HTMLDetailsElement).open) this.loadStt() })
    $('sttkeys').onclick = async (e) => {
      const b = (e.target as HTMLElement).closest('button'); const k = b?.dataset.k as 'elevenlabs' | 'xai' | undefined; if (!b || !k) return
      if (b.dataset.op === 'replace') { replacing[k] = !replacing[k]; this.drawStt(); if (replacing[k]) ($(`key-${k}`) as HTMLInputElement | null)?.focus(); return }
      if (b.dataset.op === 'clear') {
        if (!confirm(`Remove the ${KEYS.find((x) => x.k === k)!.label} saved from the app?`)) return
        await this.saveStt({ clear: [k] }, 'Cleared ✓')
      }
    }
    $('sttsave').onclick = () => {
      const u: SttUpdate = { provider: $<HTMLSelectElement>('sttprov').value as SttUpdate['provider'], fallback: $<HTMLInputElement>('sttfb').checked, keys: {} }
      for (const { k } of KEYS) { const v = ($(`key-${k}`) as HTMLInputElement | null)?.value.trim(); if (v) u.keys![k] = v }
      void this.saveStt(u, 'Saved ✓')
    }
    $('save').onclick = () => h.onSaveSettings($<HTMLInputElement>('relay').value, $<HTMLInputElement>('token').value, $<HTMLInputElement>('pair').value)
  },
  showActions() { $('qaopen')?.click() },
  sttStatus(kind: 'ok' | 'error' | 'info', text: string) { const s = $('sttstatus'); if (s) { s.className = kind; s.textContent = text } },
  async loadStt() {
    $('stt').classList.toggle('hidden', !H.cfg.token) // shown once paired (keeps the pairing form compact)
    if (!H.cfg.token) { stt = null; this.drawStt(); return }
    this.sttStatus('info', 'Loading…')
    try { stt = await api.settings(); this.drawStt(); this.sttStatus('info', '') }
    catch (e) { this.sttStatus('error', `Could not load voice settings: ${(e as Error).message}`) }
  },
  async saveStt(u: SttUpdate, okText: string) {
    for (const { k } of KEYS) { if (u.keys?.[k] && !/^[A-Za-z0-9_.\-]{16,256}$/.test(u.keys[k]!)) return this.sttStatus('error', `${KEYS.find((x) => x.k === k)!.label}: that does not look like an API key`) }
    this.sttStatus('info', u.keys && Object.keys(u.keys).length ? 'Checking the key with the provider…' : 'Saving…')
    try {
      stt = await api.saveSettings(u)
      for (const { k } of KEYS) replacing[k] = false
      this.drawStt()
      const checks = Object.entries(stt.checks ?? {}).map(([k, v]) => `${k === 'xai' ? 'xAI' : 'ElevenLabs'}: ${CHECK_LABEL[v as keyof typeof CHECK_LABEL]}`)
      this.sttStatus('ok', [okText, ...checks].join(' · '))
    } catch (e) {
      const c = (e as { body?: SttSettings }).body?.checks
      this.drawStt(c)
      this.sttStatus('error', (e as Error).message)
    }
  },
  /** Render the provider picker and the key rows. Inputs are always empty: saved keys are never sent back. */
  drawStt(failed?: SttSettings['checks']) {
    const sel = $<HTMLSelectElement>('sttprov'), box = $('sttkeys'); if (!sel || !box) return
    if (!stt) { sel.innerHTML = ''; box.innerHTML = ''; return }
    const st = stt
    sel.innerHTML = (Object.keys(PROVIDER_LABEL) as (keyof typeof PROVIDER_LABEL)[]).map((p) =>
      `<option value="${p}"${p === st.provider ? ' selected' : ''}>${PROVIDER_LABEL[p]}${st.providers[p].configured ? '' : ' (not set up)'}</option>`).join('')
    $<HTMLInputElement>('sttfb').checked = st.fallback
    box.innerHTML = KEYS.map(({ k, p, label }) => {
      const ks = st.providers[p].key
      const shown = !ks.set || replacing[k]
      const state = ks.set ? `Saved ✓ ···${esc(ks.last4 ?? '')} · ${ks.source === 'app' ? 'set in the app' : "from the relay's .env"}` : 'Not set'
      const chk = failed?.[k] ? ` · ${CHECK_LABEL[failed[k]!]}` : ''
      return `<div class="key"><div class="r"><b style="flex:none;font-size:14px">${label}</b></div>
        <div class="r"><span class="st${ks.set ? ' ok' : ''}">${state}${chk}</span>
          ${ks.set ? `<button data-k="${k}" data-op="replace">${replacing[k] ? 'Cancel' : 'Replace'}</button>` : ''}
          ${ks.source === 'app' ? `<button data-k="${k}" data-op="clear">Clear</button>` : ''}</div>
        ${shown ? `<input id="key-${k}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" placeholder="${ks.set ? 'Paste the new key' : 'Paste key'}">` : ''}</div>`
    }).join('') + `<small>Order now: ${st.order.map((p) => PROVIDER_LABEL[p].split(' (')[0]).join(' → ')}${st.providers.whisper.configured ? '' : ' · Whisper is not installed on the relay (see README)'}</small>`
  },
  setStatus(kind: 'ok' | 'error' | 'info', text: string) { for (const id of ['status', 'status2']) { const s = $(id); if (s) { s.className = kind; s.textContent = text } } },
  toast(text: string) { this.setStatus('info', text) },
  settingsSaved() { $<HTMLInputElement>('pair').value = ''; $<HTMLInputElement>('token').value = ''; ($('settings') as HTMLDetailsElement).open = false },
  render(S: Handlers['state']) {
    if (!H) return
    const inChat = S.screen === 'chat' && !phoneActions
    $('vlist').classList.toggle('hidden', inChat || phoneActions)
    $('vchat').classList.toggle('hidden', !inChat)
    $('vactions').classList.toggle('hidden', !phoneActions)
    if (phoneActions) return
    if (inChat) {
      $('cname').textContent = S.bot
      const c = S.convs.find((x) => x.name === S.bot)
      const img = $<HTMLImageElement>('cav')
      if (c && img.dataset.for !== c.name) { img.dataset.for = c.name; img.removeAttribute('src'); avatarUrl(c.avatar).then((u) => { if (u && img.dataset.for === c.name) img.src = u }) }
      $('talk').textContent = S.phase === 'listening' ? '■ Stop & send' : '🎙 Talk'
      $('hud').textContent = S.pages[S.page] ?? ''
    } else this.drawList(S)
  },
  drawList(S: Handlers['state']) {
    const list = $('list'); if (!list) return
    const unread = (c: Conversation) => !!c.last && c.last.role === 'bot' && c.last.at > (S.seen[c.name] ?? 0)
    const sig = JSON.stringify(S.convs.map((c) => [c.name, c.last?.at, unread(c)])) + Math.floor(Date.now() / 60000)
    if (list.dataset.sig === sig) return
    list.dataset.sig = sig
    list.innerHTML = S.convs.map((c) => {
      const u = unread(c)
      const prev = c.last ? `${c.last.role === 'user' ? 'You: ' : ''}${c.last.text}` : 'No messages yet'
      const letter = esc((c.name.match(/[A-Za-z]/)?.[0] ?? '?').toUpperCase())
      return `<div class="c" data-name="${esc(c.name)}"><div class="ph" data-av="${esc(c.avatar)}">${letter}</div>
        <div class="mid"><div class="top"><span class="nm">${esc(c.name)}</span><span class="tm${u ? ' new' : ''}">${c.last ? relTime(c.last.at) : ''}</span></div>
        <div class="pv">${esc(prev)}</div></div>${u ? '<span class="dot" title="new messages"></span>' : ''}</div>`
    }).join('')
    // Swap monogram placeholders for the real avatars once fetched (token-auth, cached as blob URLs).
    list.querySelectorAll<HTMLElement>('.ph[data-av]').forEach((ph) => {
      avatarUrl(ph.dataset.av!).then((u) => { if (!u || !ph.isConnected) return; const img = document.createElement('img'); img.src = u; img.alt = ''; ph.replaceWith(img) })
    })
  },
  /** New actions from the relay: refresh the editor unless the user has unsaved edits. */
  renderActions(S: Handlers['state']) {
    const q = $('qaopen'); if (q) q.textContent = `⚡ Quick actions${S.actions.length ? ` (${S.actions.length})` : ''}`
    if (!phoneActions || dirty) return
    draft = S.actions.map((a) => ({ ...a })); this.drawActions()
  },
  drawActions() {
    const list = $('qalist'); if (!list) return
    const bots = H.state.bots.map((b) => b.name)
    list.innerHTML = draft.length ? draft.map((a, i) => {
      const opts = [...new Set([...bots, a.bot].filter(Boolean))].map((b) => `<option${b === a.bot ? ' selected' : ''}>${esc(b)}</option>`).join('')
      return `<div class="qa" data-i="${i}">
        <div class="r"><input data-f="label" maxlength="${ACTION_LIMITS.label}" placeholder="Label on the glasses (≤${ACTION_LIMITS.label})" value="${esc(a.label)}">
          <select data-f="bot">${opts}</select></div>
        <textarea data-f="text" maxlength="${ACTION_LIMITS.text}" placeholder="Message sent to the bot">${esc(a.text)}</textarea>
        <div class="r"><small>${a.text.length}/${ACTION_LIMITS.text}</small><span style="flex:1"></span>
          <button data-op="up" title="Move up">▲</button><button data-op="down" title="Move down">▼</button>
          <button data-op="send" title="Send now">Send</button><button data-op="del" title="Delete">Delete</button></div></div>`
    }).join('') : '<div id="qahint">No quick actions yet. Tap “+ Add action”.</div>'
  },
  addMessage(m: Msg) { messages.push(m); this.drawLog() },
  async loadHistory(bot: string) {
    try { messages = (await api.history(bot)).messages } catch { messages = [] }
    this.drawLog()
  },
  drawLog() {
    const log = $('log'); if (!log) return
    log.innerHTML = messages.map((m) => `<div class="m ${m.role}">${esc(m.text)}<small>${new Date(m.at).toLocaleTimeString()}</small></div>`).join('')
    log.scrollTop = log.scrollHeight
  },
}
