// Background sync of every bot's Grok Bot conversation into the relay history, plus the /events SSE hub.
//
// Why: the relay only saw turns that went through it. Bots also post from elsewhere (the Grok Bot desktop/mobile
// apps, routines, background completions), and the user types in those apps too. The bdk project's read-only
// `g2_peek` tool (relay/bdk/bot/tools/g2_peek.ts) returns a bot's transcript entries after a cursor the relay keeps
// (data/sync.json); it never sends and never moves grokbot__check's cursor.
//
// Poller: every SYNC_ACTIVE_MS (15 s) while a phone/glasses client is connected to /events, else SYNC_IDLE_MS
// (90 s). Bots with recent activity first; quiet bots (nothing for SYNC_QUIET_H hours) only every 4th round.
// A bot the relay is streaming a turn for is skipped. 429/5xx -> exponential backoff (and Retry-After if given).
// Requests are capped at SYNC_MAX_RPH per hour: the interval stretches to fit.
// Merge: entries -> {role,text,at,seq}; dedupe by seq; a relay-recorded message (no seq) with the same text within
// an hour adopts the seq (a joined multi-message reply adopts every seq it contains). First run per bot = backfill
// (silent: no events, no unread).
//
// /events (text/event-stream, token auth): hello | message | unread | bot-status | reset, heartbeat every 25 s,
// resume with Last-Event-ID ("<boot>:<n>"; replays the in-memory ring, else sends reset).
import type http from "node:http";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Msg = {
  role: "user" | "bot" | "system"; text: string; at: number;
  id?: string; seq?: string; useq?: string; seqs?: string[];
  src?: "relay" | "sync"; attn?: boolean; kind?: string;
};
type Entry = { seq: string; updatedSeq: string; kind: string; role?: string; type?: string; text?: string; createdAtMs: number };
type BotState = { cursor?: string; backfilled?: boolean; lastActivity?: number; lastPoll?: number; nextPoll?: number; disabled?: string; turn?: { inFlight?: boolean; queued?: number } | null };
type Opts = {
  dataDir: string; historyDir: string;
  bots: () => { name: string }[];
  bdkTool: (name: string, input: unknown, timeoutMs?: number) => Promise<any>;
  log: (...a: unknown[]) => void;
  busy: Set<string>;
  maxHistory?: number;
};

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const ACTIVE_MS = num(process.env.SYNC_ACTIVE_MS, 15_000);
const IDLE_MS = num(process.env.SYNC_IDLE_MS, 90_000);
const MAX_RPH = num(process.env.SYNC_MAX_RPH, 3600);
const QUIET_MS = num(process.env.SYNC_QUIET_H, 24) * 3600_000;
const ENABLED = process.env.SYNC !== "0";
const RESOLVE = process.env.SYNC_RESOLVE !== "0";
const FRESH_MS = 6 * 3600_000; // incremental messages older than this are merged without events
// The public entries API returns only {seq, updatedSeq, kind, role?, text?, createdAtMs}: question widgets, approval
// and secret-request cards, images and files all arrive as a `send-message` with no text (checked on real
// transcripts, v0.6.0). So they show as one read-only placeholder, flagged "needs you"; answering stays in the app.
const CARD_TEXT = "[card or file: open the Grok Bot app to see it]";
const TYPE_TEXT: Record<string, string> = { // used only if the API ever exposes a delivery type
  "auto-review-approval": "[needs your approval in the Grok Bot app]",
  approval: "[needs your approval in the Grok Bot app]",
  "secret-request": "[needs a secret in the Grok Bot app]",
};
const ATTN_TYPES = new Set(["auto-review-approval", "secret-request", "approval"]);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Heuristic "needs you": an approval/secret card, a non-text delivery, or a message whose last line asks a question. */
export function needsAttention(m: { role: string; text: string; type?: string; card?: boolean }): boolean {
  if (m.role !== "bot") return false;
  if (m.card || (m.type && ATTN_TYPES.has(m.type))) return true;
  const last = m.text.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  return /\?\s*[)"'”*_]*\s*$/.test(last);
}

export function createSync(o: Opts) {
  const MAX = o.maxHistory ?? 200;
  mkdirSync(o.historyDir, { recursive: true });
  const statePath = join(o.dataDir, "sync.json"), seenPath = join(o.dataDir, "seen.json");
  const load = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };
  const save = (p: string, v: unknown) => { writeFileSync(p + ".tmp", JSON.stringify(v)); renameSync(p + ".tmp", p); };
  const state: { bots: Record<string, BotState> } = { bots: {}, ...load(statePath) };
  const seen: Record<string, number> = load(seenPath);
  const saveState = () => save(statePath, state);
  const bs = (bot: string) => (state.bots[bot] ??= {});

  // ---------- history ----------
  const histPath = (bot: string) => join(o.historyDir, bot.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
  function history(bot: string): Msg[] {
    let h: Msg[] = [];
    try { h = JSON.parse(readFileSync(histPath(bot), "utf8")); } catch { return []; }
    for (const m of h) m.id ??= `h${m.at.toString(36)}${m.role[0]}`; // pre-0.6 entries: stable id from time + role
    return h;
  }
  function writeHistory(bot: string, h: Msg[]) { h.sort((a, b) => a.at - b.at); save(histPath(bot), h.slice(-MAX)); }
  let idn = 0;
  const newId = () => `r${Date.now().toString(36)}${(idn++).toString(36)}`;
  /** Record a message produced by a relay turn (glasses/phone chat). origin "earlier" = delivered before our message. */
  function pushHistory(bot: string, m: Msg, origin: "relay" | "earlier" = "relay") {
    const msg: Msg = { ...m, id: m.id ?? newId(), src: "relay", attn: needsAttention(m) || undefined };
    const h = history(bot); h.push(msg); writeHistory(bot, h);
    bs(bot).lastActivity = Math.max(bs(bot).lastActivity ?? 0, msg.at);
    emit("message", { bot, origin, msg: wire(msg) });
    if (msg.role === "bot") emitUnread(bot);
    return msg;
  }
  const wire = (m: Msg) => ({ id: m.id, role: m.role, text: m.text, at: m.at, attn: m.attn ? true : undefined });

  // ---------- unread (relay-side seen positions, set by the app via POST /seen) ----------
  function unread(bot: string): number {
    const since = seen[bot] ?? 0;
    return history(bot).filter((m) => m.role === "bot" && m.at > since).length;
  }
  /** Does any unread bot message look like it needs the user (card, approval, question)? */
  function unreadAttn(bot: string): boolean {
    const since = seen[bot] ?? 0;
    return history(bot).some((m) => m.role === "bot" && m.at > since && !!m.attn);
  }
  function setSeen(bot: string, at: number) {
    seen[bot] = Math.max(seen[bot] ?? 0, Math.min(at, Date.now()));
    save(seenPath, seen);
    emitUnread(bot);
  }
  const emitUnread = (bot: string) => emit("unread", { bot, unread: unread(bot), attn: unreadAttn(bot) });

  // ---------- SSE hub ----------
  const boot = Date.now().toString(36);
  let evn = 0;
  const ring: { n: number; frame: string }[] = [];
  const clients = new Set<http.ServerResponse>();
  function emit(event: string, data: unknown) {
    const n = ++evn;
    const frame = `id: ${boot}:${n}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    ring.push({ n, frame }); if (ring.length > 500) ring.shift();
    for (const res of clients) if (!res.writableEnded) res.write(frame);
  }
  function addClient(req: http.IncomingMessage, res: http.ServerResponse, headers: Record<string, string>) {
    res.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
    res.flushHeaders?.();
    const wasIdle = clients.size === 0;
    clients.add(res);
    const last = String(req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("since") ?? "");
    const m = /^([a-z0-9]+):(\d+)$/.exec(last);
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ boot, now: Date.now(), intervalMs: interval(), bots: botStatus() })}\n\n`);
    if (m && m[1] === boot && (ring.length === 0 || Number(m[2]) >= ring[0].n - 1)) {
      for (const e of ring) if (e.n > Number(m[2])) res.write(e.frame);
    } else if (last) {
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: m && m[1] === boot ? "too old" : "relay restarted" })}\n\n`);
    }
    const hb = setInterval(() => { if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`); }, 25_000);
    const done = () => { clearInterval(hb); clients.delete(res); };
    req.on("close", done); res.on("close", done);
    if (wasIdle) kick(); // a client just connected: poll soon at the active rate
  }
  const botStatus = () => Object.fromEntries(o.bots().map((b) => [b.name, { busy: o.busy.has(b.name), working: !!(bs(b.name).turn?.inFlight || (bs(b.name).turn?.queued ?? 0) > 0) }]));
  function setBusy(bot: string, busy: boolean) { emit("bot-status", { bot, busy, working: !!bs(bot).turn?.inFlight, source: "relay" }); }

  // ---------- merge ----------
  function toMsg(e: Entry): Msg | null {
    let role: Msg["role"];
    if (e.kind === "message" && e.role === "user") role = "user";
    else if (e.kind === "send-message" || (e.kind === "message" && e.role === "assistant")) role = "bot";
    else if (e.kind === "user-attachment") role = "user"; // an image/file the user sent in the app (no name exposed)
    else return null; // spend-initiation, event, feedback, voice-call, ...
    const card = e.text === undefined || e.text === "";
    if (card && role === "user" && e.kind !== "user-attachment") return null;
    const text = !card ? e.text! : role === "user" ? "[image or file sent from the Grok Bot app]" : (e.type && TYPE_TEXT[e.type]) || CARD_TEXT;
    return { id: `s${e.seq}`, seq: e.seq, useq: e.updatedSeq, role, text, at: e.createdAtMs || Date.now(), src: "sync", kind: e.kind,
      attn: needsAttention({ role, text, type: e.type, card }) || undefined };
  }
  /** Merge entries into the bot's history. Returns the messages that are new to the relay. */
  function merge(bot: string, entries: Entry[]): Msg[] {
    const h = history(bot);
    const bySeq = new Map<string, Msg>();
    for (const m of h) { if (m.seq) bySeq.set(m.seq, m); for (const s of m.seqs ?? []) bySeq.set(s, m); }
    const added: Msg[] = [];
    for (const e of entries) {
      const m = toMsg(e); if (!m) continue;
      const have = bySeq.get(m.seq!);
      if (have) {
        if (have.seq === m.seq && have.useq !== m.useq && have.src === "sync" && have.text !== m.text) { have.text = m.text; have.useq = m.useq; have.attn = m.attn; }
        continue;
      }
      const t = norm(m.text);
      const twin = h.find((r) => !r.seq && r.src !== "sync" && r.role === m.role && Math.abs(r.at - m.at) < 3600_000 &&
        (norm(r.text) === t || (m.role === "bot" && t.length >= 8 && norm(r.text).includes(t))));
      if (twin) {
        if (norm(twin.text) === t) { twin.seq = m.seq; twin.useq = m.useq; } else (twin.seqs ??= []).push(m.seq!);
        bySeq.set(m.seq!, twin);
        continue;
      }
      h.push(m); bySeq.set(m.seq!, m); added.push(m);
    }
    writeHistory(bot, h);
    return added;
  }

  // ---------- poller ----------
  const stats = { started: Date.now(), requests: [] as number[], polls: 0, errors: 0, lastError: "", backoffUntil: 0, backoffLevel: 0, round: 0, newMessages: 0 };
  const reqsLastHour = () => { const cut = Date.now() - 3600_000; while (stats.requests.length && stats.requests[0] < cut) stats.requests.shift(); return stats.requests.length; };
  function interval(): number {
    const base = clients.size > 0 ? ACTIVE_MS : IDLE_MS;
    const n = o.bots().filter((b) => !bs(b.name).disabled).length || 1;
    // Each round costs ~n requests (quiet bots every 4th round): stretch the interval to stay under MAX_RPH.
    const active = o.bots().filter((b) => (bs(b.name).lastActivity ?? 0) > Date.now() - QUIET_MS).length;
    const perRound = active + (n - active) / 4;
    return Math.max(base, Math.ceil((perRound * 3600_000) / MAX_RPH));
  }
  async function pollBot(bot: string, silent: boolean) {
    const st = bs(bot);
    const r = await o.bdkTool("g2_peek", { agent: bot, after: st.cursor ?? "-1", max_pages: st.cursor ? 3 : 20, resolve: RESOLVE }, 120_000);
    stats.polls++;
    for (let i = 0; i < (r.pages ?? 0) + (r.resolved ? 1 : 0); i++) stats.requests.push(Date.now());
    if (r.unresolved) { st.disabled = "no session id (never contacted and SYNC_RESOLVE=0)"; return; }
    if (r.created) { st.disabled = "lookup created an empty bot: check the exact name in bots.json"; o.log("sync WARNING", bot, st.disabled); return; }
    const wasWorking = !!(st.turn?.inFlight || (st.turn?.queued ?? 0) > 0);
    st.turn = r.turn ?? null;
    const working = !!(st.turn?.inFlight || (st.turn?.queued ?? 0) > 0);
    if (working !== wasWorking) emit("bot-status", { bot, busy: o.busy.has(bot), working, source: "sync" });
    const added = merge(bot, r.entries ?? []);
    st.cursor = r.latestUpdatedSeq ?? st.cursor;
    st.lastPoll = Date.now();
    const newest = (r.entries ?? []).reduce((a: number, e: Entry) => Math.max(a, e.createdAtMs || 0), 0);
    if (newest) st.lastActivity = Math.max(st.lastActivity ?? 0, newest);
    if (!st.backfilled) {
      if (!r.more) st.backfilled = true; // a long transcript backfills over several silent polls
      if (seen[bot] === undefined) { seen[bot] = Date.now(); save(seenPath, seen); } // backfill never counts as unread
      o.log("sync backfill", bot, `${(r.entries ?? []).length} entries, ${added.length} added${r.more ? ", more" : ""}`);
      if (added.length) emit("reset", { reason: "backfill", bot });
    } else if (added.length && !silent) {
      // Only recent messages are "new" (events, banner); anything older (late backlog) is merged quietly.
      const fresh = added.filter((m) => m.at > Date.now() - FRESH_MS);
      stats.newMessages += fresh.length;
      for (const m of fresh) emit("message", { bot, origin: "sync", msg: wire(m) });
      if (fresh.length < added.length) emit("reset", { reason: "backlog", bot });
      emitUnread(bot);
      o.log("sync new", bot, fresh.length, fresh.length < added.length ? `(+${added.length - fresh.length} older)` : "");
    }
    if (r.more) st.nextPoll = 0; // backlog left: continue next tick
    saveState();
  }
  let running = false, timer: NodeJS.Timeout | null = null;
  async function round() {
    if (running) return;
    running = true;
    try {
      if (Date.now() < stats.backoffUntil) return;
      stats.round++;
      const now = Date.now();
      const list = o.bots().map((b) => b.name).filter((n) => !bs(n).disabled)
        .sort((a, b) => (bs(b).lastActivity ?? 0) - (bs(a).lastActivity ?? 0));
      for (const bot of list) {
        if (o.busy.has(bot)) continue; // the relay is streaming a turn for this bot: don't disturb it
        const st = bs(bot);
        const quiet = st.backfilled && (st.lastActivity ?? 0) < now - QUIET_MS;
        if (quiet && stats.round % 4 !== 0 && st.nextPoll !== 0) continue;
        try { await pollBot(bot, false); stats.backoffLevel = Math.max(0, stats.backoffLevel - 1); }
        catch (e: any) {
          stats.errors++; stats.lastError = `${bot}: ${String(e?.message ?? e).slice(0, 160)}`;
          // The API status is in the tool's error text ("... entries 429: ..."); bdkTool's own 502 just means "tool failed".
          const code = Number(/\b(4\d\d|5\d\d):/.exec(String(e?.message))?.[1] ?? 0) || (Number(e?.status) === 502 ? 0 : Number(e?.status) || 0);
          if (code === 429 || code >= 500) {
            stats.backoffLevel = Math.min(6, stats.backoffLevel + 1);
            const retry = Number(/retry-after"?:\s*"?(\d+)/i.exec(String(e?.message))?.[1] ?? 0) * 1000;
            stats.backoffUntil = Date.now() + Math.max(retry, interval() * 2 ** stats.backoffLevel);
            o.log("sync backoff", code, Math.round((stats.backoffUntil - Date.now()) / 1000), "s", stats.lastError);
            break;
          }
          if (/not in bots\.json/.test(String(e?.message))) bs(bot).disabled = "not in bots.json";
          o.log("sync error", stats.lastError);
        }
      }
    } finally { running = false; schedule(); }
  }
  function schedule(delay = interval()) { if (timer) clearTimeout(timer); timer = setTimeout(round, delay); timer.unref?.(); }
  function kick() { if (!ENABLED) return; if (timer) clearTimeout(timer); timer = setTimeout(round, 500); }
  function start() {
    if (!ENABLED) { o.log("sync disabled (SYNC=0)"); return; }
    o.log("sync start", `active ${ACTIVE_MS / 1000}s idle ${IDLE_MS / 1000}s max ${MAX_RPH}/h`);
    schedule(3000);
  }
  function status() {
    return {
      enabled: ENABLED, clients: clients.size, intervalMs: interval(), requestsLastHour: reqsLastHour(), polls: stats.polls,
      errors: stats.errors, lastError: stats.lastError || undefined, backoffUntil: stats.backoffUntil > Date.now() ? stats.backoffUntil : undefined,
      newMessages: stats.newMessages, round: stats.round,
      bots: Object.fromEntries(o.bots().map((b) => { const s = bs(b.name); return [b.name, { backfilled: !!s.backfilled, lastPoll: s.lastPoll, lastActivity: s.lastActivity, disabled: s.disabled, working: !!s.turn?.inFlight }]; })),
    };
  }
  return { history, pushHistory, unread, unreadAttn, setSeen, seenAt: (bot: string) => seen[bot] ?? 0, addClient, setBusy, start, status, kick, merge };
}
