// Grok Bot G2 relay. Run with: node --experimental-strip-types relay/server.ts   (Node 22.13+)
// Endpoints (all JSON unless noted; all require "Authorization: Bearer $RELAY_TOKEN" except
// GET /health, GET /app/* (static app) and POST /pair (one-time pairing code -> token)):
//   GET  /health                      -> {ok}
//   GET  /bots                        -> {bots:[{name,id,contacted?,lastContactAt?}], default}
//   POST /chat   {bot,text,wait?}     -> {status:"finished"|"running", reply, bot, latencyMs}
//   POST /check  {bot,wait?}          -> same shape; for replies still "running"
//   POST /interrupt {bot}             -> {ok}
//   GET  /history?bot=NAME            -> {messages:[{role,text,at}]}
//   GET  /conversations               -> {conversations:[{name,id,last:{role,text,at}|null,count,avatar,hudAvatar}]} newest first
//   GET  /avatars/NAME.png | NAME.hud.png  (96 px colour for the phone | 40 px 4-bit grey for the HUD)
//   POST /stt  body = raw PCM s16le 16 kHz mono (application/octet-stream) or audio/wav -> {text, latencyMs}
//   POST /chat/stream {bot,text}      -> text/event-stream: status | message {index,text,ms} | done | error
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path: string, only?: string[]) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (only && !only.includes(k)) continue;
    if (process.env[k]) continue;
    process.env[k] = raw.replace(/^['"]|['"]$/g, "");
  }
}
loadEnvFile(join(ROOT, ".env"));
// Optional: pull ELEVENLABS_API_KEY from another env file you already have (never logged).
if (process.env.ELEVENLABS_ENV_FILE) loadEnvFile(process.env.ELEVENLABS_ENV_FILE, ["ELEVENLABS_API_KEY"]);

const PORT = Number(process.env.RELAY_PORT ?? 8787);
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";
const BDK_URL = `http://127.0.0.1:${process.env.BDK_PORT ?? 3100}`;
const BDK_TOKEN = process.env.BDK_TOKEN ?? "";
const BOTS_FILE = process.env.BOTS_FILE ?? join(ROOT, "bots.json");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
const ELEVEN = () => process.env.ELEVENLABS_API_KEY ?? "";
const STT_PROVIDER = (process.env.STT_PROVIDER ?? "elevenlabs").toLowerCase(); // elevenlabs | whisper | none
const STT_MODEL = process.env.STT_MODEL ?? "scribe_v1";                         // ElevenLabs model id
const WHISPER_BIN = process.env.WHISPER_BIN ?? "whisper-cli";                   // whisper.cpp CLI
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "";                          // e.g. models/ggml-base.bin
const TUNNEL_MODE = (process.env.TUNNEL_MODE ?? "tailscale-funnel").toLowerCase(); // tailscale-funnel | cloudflare | none
const HISTORY_DIR = process.env.HISTORY_DIR ?? join(DATA_DIR, "history");
const AVATAR_DIR = process.env.AVATAR_DIR ?? join(DATA_DIR, "avatars"); // built by tools/avatars.py
mkdirSync(HISTORY_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
if (!RELAY_TOKEN) throw new Error("RELAY_TOKEN missing in .env");

type Bot = { name: string; id?: string };
const bots = (): Bot[] => JSON.parse(readFileSync(BOTS_FILE, "utf8"));
const DEFAULT_BOT = process.env.DEFAULT_BOT || bots()[0]?.name || "";
const findBot = (name: string) => bots().find((b) => b.name === name) ?? bots().find((b) => b.name.toLowerCase() === name.toLowerCase());

function log(...a: unknown[]) { console.log(new Date().toISOString(), ...a); }

// ---------- history ----------
type Msg = { role: "user" | "bot" | "system"; text: string; at: number };
const histPath = (bot: string) => join(HISTORY_DIR, bot.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
function history(bot: string): Msg[] { try { return JSON.parse(readFileSync(histPath(bot), "utf8")); } catch { return []; } }
function pushHistory(bot: string, m: Msg) { const h = history(bot); h.push(m); writeFileSync(histPath(bot), JSON.stringify(h.slice(-200))); }

// ---------- quick actions (predefined messages, edited on the phone, fired from the glasses) ----------
type Action = { id: string; label: string; bot: string; text: string };
const ACTIONS_FILE = process.env.ACTIONS_FILE ?? join(DATA_DIR, "actions.json");
const ACTIONS_EXAMPLE = join(ROOT, "actions.example.json");
const ACTION_LIMITS = { max: 50, label: 24, text: 2000 };
function loadActions(): Action[] {
  try { return JSON.parse(readFileSync(ACTIONS_FILE, "utf8")).actions ?? []; } catch {}
  // First run: seed from actions.example.json, keeping only actions whose bot exists.
  try { return validateActions(JSON.parse(readFileSync(ACTIONS_EXAMPLE, "utf8")).actions ?? [], true); } catch { return []; }
}
/** Validate a client-supplied list. Throws a 400 with a readable message; `lenient` drops bad entries instead. */
function validateActions(input: unknown, lenient = false): Action[] {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!Array.isArray(input)) throw bad("actions must be an array");
  if (input.length > ACTION_LIMITS.max) throw bad(`at most ${ACTION_LIMITS.max} actions`);
  const out: Action[] = [], ids = new Set<string>();
  input.forEach((a: any, i: number) => {
    try {
      if (!a || typeof a !== "object") throw bad(`action ${i + 1}: not an object`);
      const label = String(a.label ?? "").replace(/\s+/g, " ").trim();
      const text = String(a.text ?? "").replace(/\r\n?/g, "\n").trim();
      const b = findBot(String(a.bot ?? ""));
      if (!label) throw bad(`action ${i + 1}: label required`);
      if ([...label].length > ACTION_LIMITS.label) throw bad(`action ${i + 1}: label longer than ${ACTION_LIMITS.label} characters`);
      if (!text) throw bad(`action ${i + 1}: message required`);
      if ([...text].length > ACTION_LIMITS.text) throw bad(`action ${i + 1}: message longer than ${ACTION_LIMITS.text} characters`);
      if (!b) throw bad(`action ${i + 1}: unknown bot "${String(a.bot ?? "").slice(0, 40)}"`);
      let id = /^[A-Za-z0-9_-]{1,40}$/.test(String(a.id ?? "")) ? String(a.id) : "";
      while (!id || ids.has(id)) id = Math.random().toString(36).slice(2, 10);
      ids.add(id);
      out.push({ id, label, bot: b.name, text });
    } catch (e) { if (!lenient) throw e; }
  });
  return out;
}
function saveActions(list: Action[]) {
  mkdirSync(dirname(ACTIONS_FILE), { recursive: true });
  const tmp = `${ACTIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ actions: list, updatedAt: Date.now() }, null, 2));
  renameSync(tmp, ACTIONS_FILE);
}

// ---------- BDK tool calls ----------
async function bdkTool(name: string, input: unknown, timeoutMs = 660_000) {
  const r = await fetch(`${BDK_URL}/v1/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${BDK_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || j.isError) {
    const msg = j.result?.content?.map?.((c: any) => c?.text).filter(Boolean).join(" ")
      || (typeof j.result === "string" ? j.result : "") || j.message || j.error?.message || j.error || `bdk ${r.status}`;
    const clean = String(msg).replace(/^Tool "[^"]+" failed: /, "");
    // "still working on an earlier message; nothing was sent" -> 409 so clients know to /check instead
    throw Object.assign(new Error(clean), { status: /still working|nothing was sent/.test(clean) ? 409 : r.ok ? 502 : r.status });
  }
  return j.result;
}
function replyText(res: any): string {
  if (typeof res?.reply === "string") return res.reply;
  if (Array.isArray(res?.replies)) return res.replies.map((x: any) => x?.text ?? x).join("\n\n");
  return "";
}

// ---------- STT (ElevenLabs Scribe or local whisper.cpp) ----------
function pcmToWav(pcm: Buffer, rate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function transcribe(audio: Buffer, isWav: boolean, lang?: string): Promise<string> {
  const wav = isWav ? audio : pcmToWav(audio);
  if (STT_PROVIDER === "whisper") return transcribeWhisper(wav, lang);
  if (STT_PROVIDER !== "elevenlabs") throw Object.assign(new Error("speech-to-text disabled (STT_PROVIDER=none)"), { status: 503 });
  if (!ELEVEN()) throw Object.assign(new Error("No ELEVENLABS_API_KEY available"), { status: 503 });
  const fd = new FormData();
  fd.append("model_id", STT_MODEL);
  if (lang) fd.append("language_code", lang);
  fd.append("tag_audio_events", "false");
  fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": ELEVEN() }, body: fd, signal: AbortSignal.timeout(60_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`ElevenLabs STT ${r.status}: ${JSON.stringify(j.detail ?? j).slice(0, 200)}`), { status: 502 });
  return String(j.text ?? "").trim();
}
// whisper.cpp: expects 16 kHz mono 16-bit WAV, which is exactly what the glasses send (wrapped above).
let whisperBusy: Promise<unknown> = Promise.resolve(); // one transcription at a time (CPU/RAM bound)
function transcribeWhisper(wav: Buffer, lang?: string): Promise<string> {
  if (!WHISPER_MODEL || !existsSync(WHISPER_MODEL)) {
    return Promise.reject(Object.assign(new Error("WHISPER_MODEL not set or missing (see README: whisper.cpp)"), { status: 503 }));
  }
  const run = async () => {
    const f = join(tmpdir(), `g2-stt-${process.pid}-${Date.now()}.wav`);
    writeFileSync(f, wav);
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", f, "-nt", "-np", "-l", lang || "auto"],
          { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => (err ? reject(Object.assign(new Error(`whisper failed: ${String(stderr || err.message).slice(-300)}`), { status: 502 })) : resolve(stdout))));
      return out.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(); // drop [BLANK_AUDIO]-style tags
    } finally { rmSync(f, { force: true }); }
  };
  const p = whisperBusy.then(run, run);
  whisperBusy = p.catch(() => {});
  return p;
}

// ---------- HTTP ----------
const CORS = {
  "access-control-allow-origin": "*", // Even app WebView origin is not fixed; auth is the bearer token
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, X-Lang",
  "access-control-max-age": "86400",
};
function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readBody(req: http.IncomingMessage, max = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
const busy = new Set<string>();

// ---------- rate limiting (the relay is reachable from the public internet through the tunnel) ----------
// Fixed-window counters per client IP and bucket.
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  authfail: { max: 10, windowMs: 10 * 60_000 },
  authfail_global: { max: 200, windowMs: 10 * 60_000 }, // all IPs together // 10 bad tokens / 10 min → locked out for the rest of the window
  all: { max: 120, windowMs: 60_000 },
  chat: { max: 15, windowMs: 60_000 },
  stt: { max: 20, windowMs: 60_000 },
  static: { max: 120, windowMs: 60_000 },
};
const counters = new Map<string, { n: number; reset: number }>();
function clientIp(req: http.IncomingMessage) {
  // The relay only listens on 127.0.0.1, so the socket peer is the tunnel. Trust exactly one proxy hop:
  if (TUNNEL_MODE === "cloudflare") {
    // cloudflared sets Cf-Connecting-Ip from Cloudflare's edge.
    const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
    if (cf) return cf;
  } else if (TUNNEL_MODE === "tailscale-funnel") {
    // Funnel (Go reverse proxy) appends the real client IP as the LAST X-Forwarded-For entry;
    // earlier entries are client-supplied and spoofable.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop() ?? "";
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "?";
}
function hit(bucket: string, ip: string, peek = false): boolean {
  const L = LIMITS[bucket], k = bucket + "|" + ip, now = Date.now();
  let c = counters.get(k);
  if (!c || c.reset <= now) { c = { n: 0, reset: now + L.windowMs }; counters.set(k, c); }
  if (peek) return c.n < L.max;
  c.n++;
  return c.n <= L.max;
}
setInterval(() => { const now = Date.now(); for (const [k, c] of counters) if (c.reset <= now) counters.delete(k); }, 60_000).unref();
const TOKEN_BUF = Buffer.from(`Bearer ${RELAY_TOKEN}`);
function authed(req: http.IncomingMessage) {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  return got.length === TOKEN_BUF.length && timingSafeEqual(got, TOKEN_BUF);
}

// Static glasses app (app/dist), handy for QR sideloading from the same origin during development.
const APP_DIST = join(ROOT, "app", "dist");
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml", json: "application/json" };
function serveStatic(res: http.ServerResponse, rel: string) {
  const safe = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const file = join(APP_DIST, safe);
  if (!file.startsWith(APP_DIST) || !existsSync(file)) { res.writeHead(404, CORS); return res.end("not found"); }
  res.writeHead(200, { ...CORS, "content-type": MIME[file.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": safe === "index.html" ? "no-store" : "public, max-age=3600" });
  res.end(readFileSync(file));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const t0 = Date.now();
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    const ip = clientIp(req);
    const isStatic = req.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname.startsWith("/app/") || url.pathname === "/health");
    if (!hit(isStatic ? "static" : "all", ip)) return send(res, 429, { error: "rate limited" });
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) { res.writeHead(302, { location: "/app/" }); return res.end(); }
    if (req.method === "GET" && url.pathname.startsWith("/app/")) return serveStatic(res, url.pathname.slice(5) || "index.html");
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/pair") {
      // One-time pairing: `./run.sh pair` writes $DATA_DIR/pair.json {code, exp}. A correct code returns the token once.
      if (!hit("authfail", ip, true) || !hit("authfail_global", "*", true)) return send(res, 429, { error: "too many attempts; try later" });
      const body = JSON.parse((await readBody(req, 4096)).toString() || "{}");
      const pf = join(DATA_DIR, "pair.json");
      let pair: any = null; try { pair = JSON.parse(readFileSync(pf, "utf8")); } catch {}
      const ok = pair && Date.now() < pair.exp && typeof body.code === "string" && body.code.trim() === pair.code;
      if (!ok) { hit("authfail", ip); hit("authfail_global", "*"); log("pair fail", ip); return send(res, 401, { error: "invalid or expired code" }); }
      writeFileSync(pf, JSON.stringify({ used: Date.now() }));
      log("pair ok", ip);
      return send(res, 200, { token: RELAY_TOKEN });
    }
    if (!authed(req)) {
      // A valid token always passes; bad tokens are counted and, past the limit, refused with 429.
      if (!hit("authfail", ip, true) || !hit("authfail_global", "*", true)) return send(res, 429, { error: "too many failed auth attempts; try later" });
      hit("authfail", ip); hit("authfail_global", "*"); log("auth fail", ip, req.method, url.pathname);
      return send(res, 401, { error: "unauthorized" });
    }
    if ((url.pathname === "/chat" || url.pathname === "/chat/stream") && !hit("chat", ip)) return send(res, 429, { error: "chat rate limited" });
    if (url.pathname === "/stt" && !hit("stt", ip)) return send(res, 429, { error: "stt rate limited" });

    if (req.method === "GET" && url.pathname === "/bots") {
      let contacted: any[] = [];
      try { contacted = (await bdkTool("grokbot__list", {}, 15_000)).contacted ?? []; } catch {}
      const list = bots().map((b) => {
        const c = contacted.find((x) => x.name === b.name);
        return { ...b, contacted: !!c, lastContactAt: c?.lastContactAt };
      });
      return send(res, 200, { bots: list, default: DEFAULT_BOT, source: "bots.json (+ BDK contacted list)" });
    }
    if (req.method === "GET" && url.pathname === "/conversations") {
      const avatarVer = (n: string, k: string) => { try { return Math.floor(statSync(join(AVATAR_DIR, `${n}${k}.png`)).mtimeMs / 1000); } catch { return 0; } };
      const list = bots().map((b, i) => {
        const h = history(b.name), m = h[h.length - 1];
        return {
          name: b.name, id: b.id, order: i, count: h.length,
          last: m ? { role: m.role, text: m.text.replace(/\s+/g, " ").slice(0, 160), at: m.at } : null,
          // ?v=<mtime> so a regenerated avatar is not served from the WebView's HTTP cache
          avatar: `/avatars/${encodeURIComponent(b.name)}.png?v=${avatarVer(b.name, "")}`,
          hudAvatar: `/avatars/${encodeURIComponent(b.name)}.hud.png?v=${avatarVer(b.name, ".hud")}`,
        };
      });
      list.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || a.order - b.order);
      return send(res, 200, { conversations: list, default: DEFAULT_BOT });
    }
    if (req.method === "GET" && url.pathname.startsWith("/avatars/")) {
      const m = /^\/avatars\/([^/]+?)(\.hud)?\.png$/.exec(url.pathname);
      const b = m && findBot(decodeURIComponent(m[1]));
      const file = b && join(AVATAR_DIR, `${b.name}${m![2] ?? ""}.png`);
      if (!file || !existsSync(file)) return send(res, 404, { error: "no avatar" });
      res.writeHead(200, { ...CORS, "content-type": "image/png", "cache-control": "private, max-age=86400" });
      return res.end(readFileSync(file));
    }
    if (req.method === "GET" && url.pathname === "/history") {
      const b = findBot(url.searchParams.get("bot") ?? DEFAULT_BOT);
      if (!b) return send(res, 404, { error: "unknown bot" });
      return send(res, 200, { bot: b.name, messages: history(b.name) });
    }
    if (url.pathname === "/actions") {
      if (req.method === "GET") return send(res, 200, { actions: loadActions(), limits: ACTION_LIMITS });
      if (req.method === "PUT") {
        let body: any;
        try { body = JSON.parse((await readBody(req, 512 * 1024)).toString() || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
        const list = validateActions(body.actions);
        saveActions(list);
        log("actions saved", list.length);
        return send(res, 200, { actions: list, limits: ACTION_LIMITS });
      }
      return send(res, 405, { error: "GET or PUT" });
    }
    if (req.method === "POST" && url.pathname === "/stt") {
      const audio = await readBody(req);
      if (audio.length < 3200) return send(res, 400, { error: "audio too short" });
      const isWav = audio.subarray(0, 4).toString() === "RIFF";
      const text = await transcribe(audio, isWav, url.searchParams.get("lang") ?? (req.headers["x-lang"] as string) ?? undefined);
      log("stt", audio.length, "bytes", Date.now() - t0, "ms");
      return send(res, 200, { text, latencyMs: Date.now() - t0 });
    }
    if (req.method === "POST" && url.pathname === "/chat/stream") {
      // Server-Sent Events over a POST (read it with fetch() + ReadableStream).
      // Granularity = one event per bot message (Grok Bot "send-message" entries); the SDK has no token deltas.
      // Mechanism: grokbot__ask with wait 0 (send + one look), then grokbot__check with a short wait in a loop;
      // each check returns only messages not yet consumed, until the turn settles.
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString() || "{}");
      const b = findBot(String(body.bot ?? DEFAULT_BOT));
      if (!b) return send(res, 404, { error: `unknown bot "${body.bot}"` });
      const text = String(body.text ?? "").trim();
      if (!text) return send(res, 400, { error: "text required" });
      if (busy.has(b.name)) return send(res, 409, { error: "bot busy with a previous message; poll /check" });
      busy.add(b.name);
      const t0 = Date.now();
      // Send first (wait 0 = send + one look) so "bot busy"/errors come back as a normal HTTP status.
      let r: any;
      try { r = await bdkTool("grokbot__ask", { agent: b.name, message: text, wait_seconds: 0 }, 60_000); }
      catch (e: any) { busy.delete(b.name); return send(res, e?.status === 409 ? 409 : 502, { error: String(e?.message ?? e) }); }
      res.writeHead(200, { ...CORS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
      res.flushHeaders?.();
      const ev = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const hb = setInterval(() => { if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`); }, 15_000);
      let n = 0;
      const emit = (reply: string) => {
        if (!reply) return;
        // Tools join multiple deliveries with a blank line; we cannot split reliably, so emit as one message per poll result.
        n++; pushHistory(b.name, { role: "bot", text: reply, at: Date.now() });
        ev("message", { index: n, text: reply, ms: Date.now() - t0 });
        log("stream msg", b.name, n, Date.now() - t0, "ms");
      };
      try {
        pushHistory(b.name, { role: "user", text, at: Date.now() });
        ev("status", { phase: "sent", ms: 0 });
        emit(replyText(r));
        const deadline = Date.now() + 10 * 60_000;
        // A check returns at its deadline (or when the turn settles), so the wait bounds per-message latency (~2 s).
        // A check that never sees the turn busy needs 4 idle polls to settle, which may not fit in 2 s, so every
        // 3rd consecutive empty poll uses a 5 s wait to let a finished turn be confirmed.
        let empty = 0;
        while (r.status === "running" && Date.now() < deadline) {
          r = await bdkTool("grokbot__check", { agent: b.name, wait_seconds: empty > 0 && empty % 3 === 0 ? 5 : 2 }, 60_000);
          const t = replyText(r);
          empty = t ? 0 : empty + 1;
          emit(t); // keeps polling even if the phone disconnected, so history stays complete
        }
        ev("done", { status: r.status, messages: n, ms: Date.now() - t0 });
        log("stream done", b.name, r.status, n, "msgs", Date.now() - t0, "ms");
      } catch (e: any) {
        ev("error", { error: String(e?.message ?? e), status: e?.status });
      } finally {
        clearInterval(hb); busy.delete(b.name); res.end();
      }
      return;
    }
    if (req.method === "POST" && ["/chat", "/check", "/interrupt"].includes(url.pathname)) {
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString() || "{}");
      const b = findBot(String(body.bot ?? DEFAULT_BOT));
      if (!b) return send(res, 404, { error: `unknown bot "${body.bot}" (add it to bots.json with the exact Grok Bot name)` });
      const wait = Math.max(0, Math.min(600, Number(body.wait ?? 85)));
      if (url.pathname === "/interrupt") {
        await bdkTool("grokbot__interrupt", { agent: b.name, reason: "Interrupted from the G2 glasses app" }, 30_000);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/chat") {
        const text = String(body.text ?? "").trim();
        if (!text) return send(res, 400, { error: "text required" });
        if (busy.has(b.name)) return send(res, 409, { error: "bot busy with a previous message; poll /check" });
        busy.add(b.name);
        try {
          pushHistory(b.name, { role: "user", text, at: Date.now() });
          const r = await bdkTool("grokbot__ask", { agent: b.name, message: text, wait_seconds: wait });
          const reply = replyText(r);
          if (reply) pushHistory(b.name, { role: "bot", text: reply, at: Date.now() });
          log("chat", b.name, r.status, Date.now() - t0, "ms");
          return send(res, 200, { bot: b.name, status: r.status, reply, latencyMs: Date.now() - t0 });
        } finally { busy.delete(b.name); }
      }
      if (busy.has(b.name)) return send(res, 200, { bot: b.name, status: "running", reply: "", latencyMs: 0, note: "turn in progress (streaming)" });
      const r = await bdkTool("grokbot__check", { agent: b.name, wait_seconds: Math.min(wait, 60) });
      const reply = replyText(r);
      if (reply) pushHistory(b.name, { role: "bot", text: reply, at: Date.now() });
      return send(res, 200, { bot: b.name, status: r.status, reply, latencyMs: Date.now() - t0 });
    }
    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    log("error", url.pathname, e?.message);
    return send(res, e?.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => log(`relay listening on 127.0.0.1:${PORT} (stt=${STT_PROVIDER}, tunnel=${TUNNEL_MODE})`));
