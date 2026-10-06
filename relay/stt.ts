// Speech-to-text providers + the write-only STT settings store (provider choice and API keys).
//   elevenlabs  ElevenLabs Scribe  POST https://api.elevenlabs.io/v1/speech-to-text   (xi-api-key)
//   grok        xAI Speech to Text POST https://api.x.ai/v1/stt                       (Bearer xAI key)
//   whisper     local Whisper on this machine: faster-whisper worker (default) or whisper.cpp CLI
// Keys entered in the phone app live in $DATA_DIR/secrets.json (mode 600, atomic writes) and override the
// environment (.env). They are never logged, never returned (only "set" + last 4) and never sent to the glasses.
// CURSOR_API_KEY is deliberately NOT handled here: it stays in the relay's .env.
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const PROVIDERS = ["elevenlabs", "grok", "whisper"] as const;
export type Provider = (typeof PROVIDERS)[number];
type KeyName = "elevenlabs" | "xai";
type Stored = { provider?: Provider; fallback?: boolean; keys?: Partial<Record<KeyName, string>>; updatedAt?: number };
type Err = Error & { status?: number };
const fail = (status: number, msg: string): Err => Object.assign(new Error(msg), { status });

export function pcmToWav(pcm: Buffer, rate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export type SttOptions = { dataDir: string; root: string; log: (...a: unknown[]) => void };
export function createStt(o: SttOptions) {
  const SECRETS = process.env.SECRETS_FILE ?? join(o.dataDir, "secrets.json");
  const ENV_PROVIDER = (process.env.STT_PROVIDER ?? "elevenlabs").toLowerCase();
  const ELEVEN_MODEL = process.env.STT_MODEL ?? "scribe_v2";
  const XAI_URL = process.env.XAI_STT_URL ?? "https://api.x.ai/v1/stt";
  const WHISPER_BACKEND = (process.env.WHISPER_BACKEND ?? "faster-whisper").toLowerCase(); // faster-whisper | cpp
  const FW_PYTHON = process.env.WHISPER_PYTHON ?? join(o.root, ".whisper-venv", "bin", "python");
  const FW_MODEL = process.env.WHISPER_MODEL_NAME ?? "base";   // tiny | base | small | … (faster-whisper)
  const FW_DIR = process.env.WHISPER_MODEL_DIR ?? join(o.dataDir, "whisper-models");
  const CPP_BIN = process.env.WHISPER_BIN ?? "whisper-cli";
  const CPP_MODEL = process.env.WHISPER_MODEL ?? "";            // whisper.cpp ggml model path

  // ---------- settings store ----------
  // Cached, but re-read when the file changes on disk (e.g. someone edits or deletes it by hand).
  let cache: Stored | null = null, cacheMtime = -1;
  const load = (): Stored => {
    let m = 0;
    try { m = statSync(SECRETS).mtimeMs; } catch { m = 0; }
    if (cache && m === cacheMtime) return cache;
    try { cache = m ? JSON.parse(readFileSync(SECRETS, "utf8")) : {}; } catch { cache = {}; }
    cacheMtime = m;
    return cache!;
  };
  const save = (s: Stored) => {
    mkdirSync(dirname(SECRETS), { recursive: true });
    const tmp = `${SECRETS}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, SECRETS);
    chmodSync(SECRETS, 0o600);
    cache = s;
    try { cacheMtime = statSync(SECRETS).mtimeMs; } catch { cacheMtime = -1; }
  };
  const envKey = (k: KeyName) => (k === "elevenlabs" ? process.env.ELEVENLABS_API_KEY : process.env.XAI_API_KEY) ?? "";
  const key = (k: KeyName) => load().keys?.[k] || envKey(k);
  const keyState = (k: KeyName) => {
    const app = load().keys?.[k], v = app || envKey(k);
    return { set: !!v, source: app ? "app" : v ? "env" : null, last4: v ? v.slice(-4) : null };
  };
  const whisperAvailable = () => (WHISPER_BACKEND === "cpp" ? !!CPP_MODEL && existsSync(CPP_MODEL) : existsSync(FW_PYTHON));
  const configured = (p: Provider) => (p === "elevenlabs" ? !!key("elevenlabs") : p === "grok" ? !!key("xai") : whisperAvailable());
  const provider = (): Provider => {
    const p = load().provider ?? ENV_PROVIDER;
    return (PROVIDERS as readonly string[]).includes(p) ? (p as Provider) : "elevenlabs";
  };
  const fallbackOn = () => load().fallback ?? (process.env.STT_FALLBACK ?? "1") !== "0";
  /** Chosen provider first, then (if fallback is on) the other configured ones in the order elevenlabs → grok → whisper. */
  const order = (): Provider[] => {
    const first = provider();
    return fallbackOn() ? [first, ...PROVIDERS.filter((p) => p !== first && configured(p))] : [first];
  };

  function publicSettings() {
    return {
      provider: provider(), fallback: fallbackOn(), order: order(),
      providers: {
        elevenlabs: { configured: configured("elevenlabs"), key: keyState("elevenlabs"), model: ELEVEN_MODEL },
        grok: { configured: configured("grok"), key: keyState("xai"), endpoint: XAI_URL },
        whisper: { configured: whisperAvailable(), backend: WHISPER_BACKEND, model: WHISPER_BACKEND === "cpp" ? CPP_MODEL.split("/").pop() : FW_MODEL },
      },
    };
  }

  // Cheap key checks against the provider (no audio). "unknown" = could not tell (network, missing permission).
  async function checkKey(k: KeyName, v: string): Promise<"valid" | "invalid" | "unknown"> {
    try {
      const r = k === "elevenlabs"
        ? await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": v }, signal: AbortSignal.timeout(10_000) })
        : await fetch("https://api.x.ai/v1/models", { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) return "valid";
      if (r.status === 401) return "invalid";
      if (k === "xai" && r.status === 403) return "unknown"; // key may be restricted to other endpoints
      if (k === "elevenlabs" && r.status === 403) return "unknown"; // scoped key without user_read
      return r.status === 400 ? "invalid" : "unknown";
    } catch { return "unknown"; }
  }

  const KEY_RE = /^[A-Za-z0-9_.\-]{16,256}$/;
  /** body: { provider?, fallback?, keys?: { elevenlabs?: string, xai?: string }, clear?: ("elevenlabs"|"xai")[], validate?: boolean }
   *  Empty / missing key = unchanged. Keys are write-only. Returns public settings + per-key check results. */
  async function updateSettings(body: any, who: string) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "expected a JSON object");
    const allowed = new Set(["provider", "fallback", "keys", "clear", "validate"]);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw fail(400, `unknown field "${k.slice(0, 20)}"`);
    const next: Stored = JSON.parse(JSON.stringify(load()));
    next.keys ??= {};
    const changes: string[] = [];
    if (body.provider !== undefined) {
      if (!(PROVIDERS as readonly string[]).includes(body.provider)) throw fail(400, "provider must be elevenlabs, grok or whisper");
      if (next.provider !== body.provider) changes.push(`provider=${body.provider}`);
      next.provider = body.provider;
    }
    if (body.fallback !== undefined) {
      if (typeof body.fallback !== "boolean") throw fail(400, "fallback must be true or false");
      if (next.fallback !== body.fallback) changes.push(`fallback=${body.fallback}`);
      next.fallback = body.fallback;
    }
    const checks: Record<string, string> = {};
    if (body.clear !== undefined) {
      if (!Array.isArray(body.clear) || body.clear.some((c: unknown) => c !== "elevenlabs" && c !== "xai")) throw fail(400, 'clear must be a list of "elevenlabs" / "xai"');
      for (const c of body.clear as KeyName[]) { if (next.keys[c]) changes.push(`${c}=cleared`); delete next.keys[c]; }
    }
    if (body.keys !== undefined) {
      if (!body.keys || typeof body.keys !== "object" || Array.isArray(body.keys)) throw fail(400, "keys must be an object");
      for (const [k, v] of Object.entries(body.keys)) {
        if (k !== "elevenlabs" && k !== "xai") throw fail(400, `unknown key "${k.slice(0, 20)}" (only elevenlabs, xai)`);
        if (v === undefined || v === null || v === "") continue; // unchanged
        if (typeof v !== "string" || !KEY_RE.test(v.trim())) throw fail(400, `${k} key: 16-256 characters of A-Z a-z 0-9 _ . - expected`);
        const val = v.trim();
        if (body.validate !== false && process.env.STT_VALIDATE !== "0") { // STT_VALIDATE=0: offline/test relays skip the provider check
          checks[k] = await checkKey(k, val);
          if (checks[k] === "invalid") throw Object.assign(fail(400, `${k === "xai" ? "xAI" : "ElevenLabs"} rejected that key; nothing was saved`), { checks });
        }
        changes.push(`${k}=${next.keys[k] ? "replaced" : "set"}${checks[k] ? `(${checks[k]})` : ""}`);
        next.keys[k] = val;
      }
    }
    next.updatedAt = Date.now();
    save(next);
    prewarm();
    o.log("settings", who, changes.length ? changes.join(" ") : "no change"); // audit line: never values
    return { ...publicSettings(), checks };
  }

  // ---------- providers ----------
  async function elevenlabs(wav: Buffer, lang?: string): Promise<string> {
    const k = key("elevenlabs"); if (!k) throw fail(503, "no ElevenLabs key");
    const fd = new FormData();
    fd.append("model_id", ELEVEN_MODEL);
    if (lang) fd.append("language_code", lang);
    fd.append("tag_audio_events", "false");
    fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": k }, body: fd, signal: AbortSignal.timeout(60_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(502, `ElevenLabs STT ${r.status}: ${JSON.stringify(j.detail ?? j).slice(0, 200)}`);
    return String(j.text ?? "").trim();
  }
  // xAI Speech to Text (docs.x.ai → REST API reference → Voice → POST /v1/stt): multipart/form-data, `file` must be the
  // LAST field; WAV is auto-detected from its header (raw PCM would need audio_format=pcm + sample_rate=16000).
  async function grok(wav: Buffer, lang?: string): Promise<string> {
    const k = key("xai"); if (!k) throw fail(503, "no xAI key");
    const fd = new FormData();
    if (lang) { fd.append("language", lang); fd.append("format", "true"); }
    fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    const r = await fetch(XAI_URL, { method: "POST", headers: { authorization: `Bearer ${k}` }, body: fd, signal: AbortSignal.timeout(60_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(502, `xAI STT ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    return String(j.text ?? "").trim();
  }

  // Whisper. faster-whisper runs as one long-lived worker (model loaded once; tools/whisper-worker.py, JSON lines
  // over stdin/stdout); whisper.cpp runs its CLI per request. Either way: one transcription at a time.
  let worker: ChildProcessWithoutNullStreams | null = null, seq = 0, buf = "";
  const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Err) => void }>();
  /** Minimal environment for the Python worker: it never needs the relay's secrets (Cursor/ElevenLabs/xAI keys). */
  function whisperEnv(): NodeJS.ProcessEnv {
    const pass = ["PATH", "HOME", "LANG", "TMPDIR", "WHISPER_THREADS", "WHISPER_COMPUTE", "HF_HOME", "HF_ENDPOINT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
    const env: NodeJS.ProcessEnv = { WHISPER_MODEL_NAME: FW_MODEL, WHISPER_MODEL_DIR: FW_DIR };
    for (const k of pass) if (process.env[k]) env[k] = process.env[k];
    return env;
  }
  function startWorker() {
    if (worker && worker.exitCode === null) return worker;
    const w = spawn(FW_PYTHON, [join(o.root, "tools", "whisper-worker.py")], {
      env: whisperEnv(), stdio: ["pipe", "pipe", "pipe"],
    });
    w.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); const p = pending.get(m.id); if (!p) continue; pending.delete(m.id); m.error ? p.reject(fail(502, `whisper: ${m.error}`)) : p.resolve(m.text ?? ""); } catch { /* log noise */ }
      }
    });
    w.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) o.log("whisper-worker", s.slice(-200)); });
    w.on("exit", (code) => { o.log("whisper-worker exited", code); for (const p of pending.values()) p.reject(fail(502, "whisper worker exited")); pending.clear(); worker = null; });
    worker = w;
    return w;
  }
  let whisperQueue: Promise<unknown> = Promise.resolve();
  function whisper(wav: Buffer, lang?: string): Promise<string> {
    if (!whisperAvailable()) return Promise.reject(fail(503, WHISPER_BACKEND === "cpp" ? "WHISPER_MODEL (whisper.cpp) not set or missing" : `faster-whisper not installed (${FW_PYTHON} missing; see README)`));
    const run = async () => {
      const f = join(tmpdir(), `g2-stt-${process.pid}-${Date.now()}.wav`);
      writeFileSync(f, wav, { mode: 0o600 });
      try {
        if (WHISPER_BACKEND === "cpp") {
          const out = await new Promise<string>((resolve, reject) =>
            execFile(CPP_BIN, ["-m", CPP_MODEL, "-f", f, "-nt", "-np", "-l", lang || "auto"], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
              (err, stdout, stderr) => (err ? reject(fail(502, `whisper.cpp failed: ${String(stderr || err.message).slice(-300)}`)) : resolve(stdout))));
          return out;
        }
        const w = startWorker(), id = ++seq;
        return await new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => { pending.delete(id); reject(fail(504, "whisper timed out")); }, 180_000);
          pending.set(id, { resolve: (s) => { clearTimeout(t); resolve(s); }, reject: (e) => { clearTimeout(t); reject(e); } });
          w.stdin.write(JSON.stringify({ id, path: f, lang: lang || null }) + "\n");
        });
      } finally { rmSync(f, { force: true }); }
    };
    const p = whisperQueue.then(run, run).then((t) => t.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim()); // drop [BLANK_AUDIO]-style tags
    whisperQueue = p.catch(() => {});
    return p;
  }
  /** Load the Whisper model now when Whisper is the chosen provider (otherwise it loads lazily on first use). */
  function prewarm() { if (provider() === "whisper" && WHISPER_BACKEND !== "cpp" && whisperAvailable()) startWorker(); }

  const impl: Record<Provider, (wav: Buffer, lang?: string) => Promise<string>> = { elevenlabs, grok, whisper };
  /** Transcribe G2 audio (16 kHz s16le mono PCM, or a WAV file) with the chosen provider, falling back on failure. */
  async function transcribe(audio: Buffer, isWav: boolean, lang?: string, only?: Provider) {
    const wav = isWav ? audio : pcmToWav(audio);
    const tried: string[] = [];
    for (const p of only ? [only] : order()) {
      const t0 = Date.now();
      try {
        const text = await impl[p](wav, lang);
        return { text, provider: p, ms: Date.now() - t0, ...(tried.length ? { fallbackFrom: tried } : {}) };
      } catch (e: any) {
        tried.push(p);
        o.log("stt failed", p, String(e?.message ?? e).slice(0, 200));
        if (only || p === order().at(-1)) throw fail(e?.status ?? 502, `${String(e?.message ?? e)}${tried.length > 1 ? ` (tried: ${tried.join(", ")})` : ""}`);
      }
    }
    throw fail(503, "no speech-to-text provider configured");
  }
  return { transcribe, publicSettings, updateSettings, prewarm, provider };
}
