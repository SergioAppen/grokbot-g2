// Phone-side companion UI (rendered in the Even app WebView).
import { api, avatarUrl, relTime, type Msg, type Bot, type Conversation } from './api'

type Handlers = {
  state: { bot: string; bots: Bot[]; phase: string; screen: string; pages: string[]; page: number; convs: Conversation[]; seen: Record<string, number> }
  onSend: (text: string, bot: string) => void
  onPickBot: (bot: string) => void
  onBack: () => void
  onTalk: () => void
  onCheck: () => void
  onInterrupt: () => void
  onSaveSettings: (relayUrl: string, token: string, pairCode: string) => void
  cfg: { relayUrl: string; token: string }
}
let H: Handlers
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
let messages: Msg[] = []

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
#list{flex:1;overflow-y:auto;background:var(--s);border-radius:12px}
.c{display:flex;gap:12px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}
.c:active{background:rgba(255,255,255,.05)}.c img,.c .ph{width:48px;height:48px;border-radius:50%;flex:none;background:#2a2a2a;object-fit:cover}
.c .ph{display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--d)}
.c .mid{flex:1;min-width:0}.c .top{display:flex;gap:8px;align-items:baseline}.c .nm{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c .tm{font-size:12px;color:var(--d)}.c .tm.new{color:var(--a)}.c .pv{font-size:14px;color:var(--d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c .dot{width:10px;height:10px;border-radius:50%;background:var(--a);flex:none}
.chathead{display:flex;gap:10px;align-items:center}.chathead img{width:36px;height:36px;border-radius:50%;object-fit:cover}
.chathead h1{font-size:18px}#back{padding:8px 12px}
.hidden{display:none!important}
#hud{font-family:ui-monospace,monospace;font-size:12px;color:#3CFA44;background:#000;border-radius:8px;padding:6px 8px;white-space:pre-wrap;max-height:90px;overflow:hidden}
`

export const ui = {
  mount(h: Handlers) {
    H = h
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st)
    $('app').innerHTML = `
      <section id="vlist" style="display:contents">
        <header><h1>Grok Bot · G2</h1></header>
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
      <details id="settings"><summary>Settings</summary>
        <label>Relay URL<input id="relay" placeholder="https://your-relay.example.com"></label>
        <label>Pairing code<input id="pair" inputmode="numeric" placeholder="6-digit code from ./run.sh pair"></label>
        <label>…or relay token<input id="token" type="password" placeholder="(stored on this phone)"></label>
        <button id="save">Save &amp; reconnect</button>
      </details>`
    $('back').onclick = () => h.onBack()
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
    $('save').onclick = () => h.onSaveSettings($<HTMLInputElement>('relay').value, $<HTMLInputElement>('token').value, $<HTMLInputElement>('pair').value)
  },
  setStatus(kind: 'ok' | 'error' | 'info', text: string) { for (const id of ['status', 'status2']) { const s = $(id); if (s) { s.className = kind; s.textContent = text } } },
  toast(text: string) { this.setStatus('info', text) },
  settingsSaved() { $<HTMLInputElement>('pair').value = ''; $<HTMLInputElement>('token').value = ''; ($('settings') as HTMLDetailsElement).open = false },
  render(S: Handlers['state']) {
    if (!H) return
    const inChat = S.screen === 'chat'
    $('vlist').classList.toggle('hidden', inChat)
    $('vchat').classList.toggle('hidden', !inChat)
    if (inChat) {
      $('cname').textContent = S.bot
      const c = S.convs.find((x) => x.name === S.bot)
      const img = $<HTMLImageElement>('cav')
      if (c && img.dataset.for !== c.name) { img.dataset.for = c.name; img.removeAttribute('src'); avatarUrl(c.avatar).then((u) => { if (u && img.dataset.for === c.name) img.src = u }) }
      $('talk').textContent = S.phase === 'listening' ? '■ Stop & send' : '🎙 Talk'
      $('hud').textContent = `[${S.phase}] ${S.page + 1}/${S.pages.length}\n${S.pages[S.page] ?? ''}`
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
