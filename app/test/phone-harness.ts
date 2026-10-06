// Phone-screen UI in a normal browser (no Even app bridge), for layout/keyboard tests against the MOCK relay.
// Build: npx esbuild test/phone-harness.ts --bundle --format=esm --outfile=<dir>/harness.js ; open <dir>/index.html#relay=http://127.0.0.1:8799&token=<RELAY_TOKEN>
// Only ui.ts + api.ts are loaded; glasses actions (talk, send, quick-action fire) are no-ops here.
import { ui } from '../src/ui'
import { api, cfg, type Action } from '../src/api'

const h = new URLSearchParams(location.hash.slice(1))
cfg.relayUrl = h.get('relay') || location.origin
cfg.token = h.get('token') || ''
const S = { bot: '', bots: [] as any[], phase: 'idle', screen: 'bots', pages: [] as string[], page: 0, convs: [] as any[], seen: {} as Record<string, number>, actions: [] as Action[] }
const w = window as any
w.__harness = { S, ui, errors: [] as string[] }
window.addEventListener('error', (e) => w.__harness.errors.push(String(e.message)))
window.addEventListener('unhandledrejection', (e) => w.__harness.errors.push(String((e as PromiseRejectionEvent).reason)))

ui.mount({
  state: S,
  onSend: () => ui.toast('(harness: send is a no-op)'),
  onPickBot: (b) => { S.bot = b; S.screen = 'chat'; ui.render(S); ui.loadHistory(b) },
  onBack: () => { S.screen = 'bots'; ui.render(S) },
  onTalk: () => {}, onCheck: () => {}, onInterrupt: () => {},
  onSaveSettings: async () => {},
  onSaveActions: async (list) => { const r = await api.saveActions(list); S.actions = r.actions; ui.renderActions(S); return r.actions },
  onFireAction: () => ui.toast('(harness: fire is a no-op)'),
  cfg,
})
;(async () => {
  try {
    S.convs = (await api.conversations()).conversations
    S.bots = (await api.bots()).bots
    S.actions = (await api.actions()).actions
    ui.setStatus('ok', `Relay connected · ${S.bots.length} bots`)
    ui.renderActions(S); ui.render(S)
    w.__harness.ready = true
  } catch (e) { ui.setStatus('error', `Relay: ${(e as Error).message}`); w.__harness.ready = true }
})()
