// Relay client. Relay = relay/server.ts behind your HTTPS tunnel (Tailscale Funnel or a Cloudflare named tunnel).
export type Bot = { name: string; id?: string; contacted?: boolean; lastContactAt?: string }
export type Msg = { role: 'user' | 'bot' | 'system'; text: string; at: number }
export type ChatResult = { bot: string; status: 'finished' | 'running'; reply: string; latencyMs?: number }

export type Conversation = {
  name: string; id?: string; count: number
  last: { role: Msg['role']; text: string; at: number } | null
  avatar: string; hudAvatar: string
}

export type Action = { id: string; label: string; bot: string; text: string }
export const ACTION_LIMITS = { max: 50, label: 24, text: 2000 }

// Speech-to-text settings (relay GET/PUT /settings). Key values are write-only: the relay only ever returns set/source/last4.
export type SttProvider = 'elevenlabs' | 'grok' | 'whisper'
export type KeyState = { set: boolean; source: 'app' | 'env' | null; last4: string | null }
export type SttSettings = {
  provider: SttProvider; fallback: boolean; order: SttProvider[]
  providers: {
    elevenlabs: { configured: boolean; key: KeyState; model: string }
    grok: { configured: boolean; key: KeyState; endpoint: string }
    whisper: { configured: boolean; backend: string; model: string }
  }
  checks?: Partial<Record<'elevenlabs' | 'xai', 'valid' | 'invalid' | 'unknown'>>
}
export type SttUpdate = { provider?: SttProvider; fallback?: boolean; keys?: { elevenlabs?: string; xai?: string }; clear?: ('elevenlabs' | 'xai')[] }

export const cfg = { relayUrl: '', token: '' }

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 100_000): Promise<T> {
  if (!cfg.relayUrl) throw new Error('Relay URL not set (phone screen → Settings)')
  if (!cfg.token) throw new Error('Relay token not set (phone screen → Settings)')
  const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + path, {
    ...init,
    headers: { authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status, body: j })
  return j as T
}

export const api = {
  pair: async (code: string) => {
    const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok || !j.token) throw new Error(j.error ?? `HTTP ${r.status}`)
    return j.token as string
  },
  health: () => fetch(cfg.relayUrl.replace(/\/$/, '') + '/health').then((r) => r.json()),
  bots: () => call<{ bots: Bot[]; default: string }>('/bots', {}, 20_000),
  conversations: () => call<{ conversations: Conversation[]; default: string }>('/conversations', {}, 20_000),
  history: (bot: string) => call<{ messages: Msg[] }>(`/history?bot=${encodeURIComponent(bot)}`, {}, 20_000),
  // wait 85s keeps us under Cloudflare's ~100 s proxy timeout; longer turns come back "running"
  chat: (bot: string, text: string) =>
    call<ChatResult>('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bot, text, wait: 85 }) }),
  check: (bot: string, wait = 25) =>
    call<ChatResult>('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bot, wait }) }, 60_000),
  interrupt: (bot: string) =>
    call<{ ok: boolean }>('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bot }) }, 40_000),
  actions: () => call<{ actions: Action[] }>('/actions', {}, 20_000),
  saveActions: (actions: Action[]) =>
    call<{ actions: Action[] }>('/actions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions }) }, 20_000),
  settings: () => call<SttSettings>('/settings', {}, 20_000),
  saveSettings: (u: SttUpdate) =>
    call<SttSettings>('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) }, 40_000),
  stt: (pcm: Uint8Array) =>
    call<{ text: string; provider?: SttProvider; fallbackFrom?: SttProvider[] }>('/stt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([pcm as BlobPart], { type: 'application/octet-stream' }) }, 70_000),
}

export type StreamEvent =
  | { type: 'status'; phase: string; ms: number }
  | { type: 'message'; index: number; text: string; ms: number }
  | { type: 'done'; status: 'finished' | 'running'; messages: number; ms: number }
  | { type: 'error'; error: string; status?: number }

/** POST /chat/stream and parse the SSE body incrementally (EventSource cannot POST or send headers). */
export async function chatStream(bot: string, text: string, onEvent: (e: StreamEvent) => void): Promise<void> {
  const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + '/chat/stream', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ bot, text }),
    signal: AbortSignal.timeout(11 * 60_000),
  })
  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}))
    throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status })
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      let event = 'message', data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue // heartbeat comment
      let parsed: any
      try { parsed = JSON.parse(data) } catch { continue } // ignore a malformed frame
      onEvent({ type: event, ...parsed } as StreamEvent)
    }
  }
}

/** Ask, then keep polling /check while the bot is still working (up to ~10 min). */
export async function askAndWait(bot: string, text: string, onProgress?: (partial: string) => void): Promise<string> {
  let r = await api.chat(bot, text)
  let reply = r.reply ?? ''
  const deadline = Date.now() + 10 * 60_000
  while (r.status === 'running' && Date.now() < deadline) {
    if (reply) onProgress?.(reply)
    r = await api.check(bot, 25)
    if (r.reply) reply = reply ? `${reply}\n\n${r.reply}` : r.reply
  }
  if (r.status === 'running') reply += '\n\n(still working — tap to check again)'
  return reply || '(no reply text)'
}

// Avatars need the bearer token, so they are fetched once and cached (bytes for the HUD, blob URL for <img>).
const avatarBytes = new Map<string, Promise<Uint8Array | null>>()
export function avatarData(path: string): Promise<Uint8Array | null> {
  if (!avatarBytes.has(path)) {
    avatarBytes.set(path, (async () => {
      try {
        const r = await fetch(cfg.relayUrl.replace(/\/$/, '') + path, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(20_000) })
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
      } catch { avatarBytes.delete(path); return null }
    })())
  }
  return avatarBytes.get(path)!
}
const avatarUrls = new Map<string, Promise<string>>()
export function avatarUrl(path: string): Promise<string> {
  if (!avatarUrls.has(path)) avatarUrls.set(path, avatarData(path).then((b) => (b ? URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/png' })) : '')))
  return avatarUrls.get(path)!
}

export function relTime(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
