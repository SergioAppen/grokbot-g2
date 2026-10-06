// g2_peek: READ-ONLY look at a Grok Bot's conversation transcript, for the G2 relay's background sync.
//
// - Reads `GET /v0/grokbot/sessions/{id}/entries?afterUpdatedSeq=<after>` (the route grokbot__check polls) with the
//   serve host's Cursor credential, after a cursor the RELAY keeps. It never touches the grokbot__* read cursor
//   (so /chat streaming and grokbot__check are unaffected) and never sends anything.
// - Session lookup never creates a bot: the id comes from the grokbot contacts this principal already has (bots the
//   relay talked to) or from an earlier lookup. Only with `resolve: true`, and only for a name listed in bots.json,
//   it calls `POST /v0/grokbot/sessions {name}` (get-or-create by exact name, the same call grokbot__ask makes);
//   a response that looks freshly created is reported as `created: true` and the id is not used.
// - Returns every entry kind (user messages typed in the app, bot deliveries, events) with the delivery type
//   (`message.type`, e.g. text | auto-review-approval | secret-request) when the API exposes it.
//
// Uses @cursor/bdk internals by path: keep "@cursor/bdk" pinned (package.json) and re-check on upgrade.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { cursorExternalApiUrl, resolveApiKeySync } from "../../node_modules/@cursor/bdk/dist/internal/cursor/credentials.js";
import { listContacts } from "../../node_modules/@cursor/bdk/dist/extensions/cursor-grokbot-agents/lib/contacts.js";

const BOTS_FILE = process.env.BOTS_FILE ?? resolve(process.cwd(), "../../bots.json"); // run.sh serves from relay/bdk
const MAX_TEXT = 20_000;
const sessions = new Map<string, string>(); // exact bot name -> session id (process cache)
const RATE_HEADERS = /^(x-ratelimit|ratelimit|retry-after|x-rate-limit)/i;

function allowed(name: string): string | undefined {
  const list: { name: string }[] = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
  return list.find((b) => b.name === name)?.name;
}

async function api(method: string, path: string, body?: unknown) {
  const key = resolveApiKeySync({})?.apiKey;
  if (!key) throw new Error("no Cursor credential on the serve host");
  const r = await fetch(`${cursorExternalApiUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "x-cursor-client-type": "agent-serve",
      "x-request-id": randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const rate: Record<string, string> = {};
  r.headers.forEach((v, k) => { if (RATE_HEADERS.test(k)) rate[k] = v; });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = String(j.error ?? j.message ?? msg); } catch {}
    throw Object.assign(new Error(`Grok Bot API ${method} ${path.replace(/sessions\/[^/]+/, "sessions/…")} ${r.status}: ${msg}`), { status: r.status, rate });
  }
  return { json: JSON.parse(text), rate, status: r.status };
}

function typeOf(e: any): string | undefined {
  const m = e?.message;
  if (m && typeof m === "object" && typeof m.type === "string") return m.type;
  if (typeof e?.type === "string") return e.type;
  return undefined;
}
function textOf(e: any): string | undefined {
  if (typeof e?.text === "string") return e.text;
  const c = e?.message?.content;
  if (typeof c === "string") return c;
  return undefined;
}

const STD = new Set(["seq", "updatedSeq", "kind", "role", "text", "createdAtMs"]);
/** JSON-safe copy with long strings cut and depth/size bounded. */
function capped(v: any, max: number, depth = 0): any {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => capped(x, max, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, capped(x, max, depth + 1)]));
}
/** Non-standard entry fields (card / widget / attachment payloads) passed through for the relay, bounded. */
function extraOf(e: any): any {
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(e ?? {})) if (!STD.has(k)) o[k] = v;
  return Object.keys(o).length ? capped(o, 4000) : undefined;
}

export default defineTool({
  description: "Read-only: transcript entries of a Grok Bot after a cursor (for the G2 relay sync). Never sends.",
  effect: "read",
  inputSchema: z.object({
    agent: z.string().min(1).max(80),
    after: z.string().max(64).default("-1"),
    max_pages: z.number().int().min(1).max(20).default(1),
    resolve: z.boolean().default(false),
    raw: z.boolean().default(false), // diagnostics: also return each raw entry (strings capped)
  }),
  async execute(input, ctx) {
    const name = allowed(input.agent);
    if (!name) throw new Error(`"${input.agent.slice(0, 40)}" is not in bots.json`);
    let sessionId = sessions.get(name) ?? (await listContacts(ctx)).find((c) => c.name === name)?.sessionId;
    let rate: Record<string, string> = {};
    let resolved = false;
    if (!sessionId) {
      if (!input.resolve) return { agent: name, unresolved: true };
      const t0 = Date.now();
      const s = await api("POST", "/v0/grokbot/sessions", { name });
      rate = s.rate;
      if (s.json.latestUpdatedSeq === "-1" && Number(s.json.createdAtMs) >= t0 - 60_000) {
        return { agent: name, created: true, resolved: true, note: "lookup returned a new, empty bot: check the exact name in bots.json" };
      }
      sessionId = String(s.json.id);
      resolved = true;
    }
    sessions.set(name, sessionId);
    const entries: any[] = [];
    let cursor = input.after, turn: any = null, pages = 0, more = false;
    for (; pages < input.max_pages; ) {
      const r = await api("GET", `/v0/grokbot/sessions/${encodeURIComponent(sessionId)}/entries?afterUpdatedSeq=${encodeURIComponent(cursor)}`);
      pages++; rate = r.rate; turn = r.json.turn;
      const page: any[] = Array.isArray(r.json.entries) ? r.json.entries : [];
      for (const e of page) {
        const text = textOf(e);
        entries.push({
          seq: String(e.seq), updatedSeq: String(e.updatedSeq ?? e.seq), kind: String(e.kind ?? ""), role: e.role,
          type: typeOf(e), createdAtMs: Number(e.createdAtMs ?? 0),
          text: text === undefined ? undefined : text.slice(0, MAX_TEXT), truncated: text !== undefined && text.length > MAX_TEXT ? true : undefined,
          wake: typeof e.wake === "string" ? e.wake : undefined,
          keys: Object.keys(e).filter((k) => !["seq", "updatedSeq", "kind", "role", "text", "createdAtMs"].includes(k)),
          extra: extraOf(e),
          raw: input.raw ? capped(e, 4000) : undefined,
        });
      }
      const next = String(r.json.latestUpdatedSeq ?? cursor);
      more = page.length > 0 && next !== cursor;
      cursor = next;
      if (!more) break;
    }
    return { agent: name, latestUpdatedSeq: cursor, turn, entries, pages, more, rate, resolved };
  },
});
