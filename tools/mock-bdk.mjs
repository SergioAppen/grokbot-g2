// Fake bdk tools API (POST /v1/tools/<tool>) for offline testing of the relay and app — no real bot is contacted.
// Each bot has a transcript (entries with seq/updatedSeq/kind/role/text/createdAtMs, like the Grok Bot API) seeded
// from MOCK_HISTORY_DIR (the mock relay's history, so the relay's first sync backfill has to dedupe it).
//   • grokbot__ask: appends the user message; a message containing "long" gets one ~3000-character reply at +3 s
//     (turn ends at +4 s), anything else a turn of 3 messages at +3/+7/+11 s (ends at +12 s). Bot messages that
//     arrived since the caller last read come back as earlierReplies (like the real extension).
//   • grokbot__check: messages since the caller's read position; "running" while a turn is in flight.
//   • g2_peek: read-only transcript entries after a cursor (pages of 200), the turn state, never moves the check cursor.
//   • "Proactive" bot messages (as if from a routine or another device) every MOCK_PROACTIVE_MS (default 0 = off),
//     rotating through: a plain note, a question, a card (no text), a user message typed "in the app"
//     followed by a reply. POST /mock/proactive {agent, text?, kind?: "card"|"user"|"attachment"|"card-answered"}
//     injects one immediately. Cards follow the real API (v0.6.0 capture): a question widget, approval, secret
//     request, image or file is a `send-message` entry with NO text and no other fields; answering it in the app adds
//     no user entry, it only bumps the card's updatedSeq ("card-answered"). An image/file sent by the user is a
//     `user-attachment` entry, also without text. Entries come back in updatedSeq order, one global counter.
//     POST /mock/fail {status: 429, n: 2} makes the next n g2_peek calls fail (backoff test).
//   • with MOCK_PASSIVE=1, the first check of a bot with no turn running returns one message the bot "sent on its own".
// Port: MOCK_BDK_PORT (3199).
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const LONG = readFileSync(join(HERE, "..", "app", "test", "sample-long.txt"), "utf8");
const TURN = [[3000, "On it, checking your calendar."], [7000, "You have two meetings today: 10:00 design review and 15:30 team sync."], [11000, "Want me to prepare notes for the design review?"]];
const PASSIVE = "Heads-up: the 15:30 team sync moved to 16:00. No action needed.";
const PROACTIVE = [
  { text: "Routine done: your daily summary is ready. 3 new emails, nothing urgent." },
  { text: "Your 18:40 train is delayed by 25 minutes. Should I move dinner to 20:00?" },
  { kind: "card" },
  { kind: "user", text: "Remind me to call the bank tomorrow at 9", reply: "Done: reminder set for tomorrow at 9:00." },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seqN = 0;
const bots = new Map(); // agent -> { entries, readPos, turnEnd, passiveDone }
function bot(a) {
  if (!bots.has(a)) bots.set(a, { entries: [], readPos: 0, turnEnd: 0, passiveDone: false });
  return bots.get(a);
}
function add(a, kind, role, text, at = Date.now()) {
  const s = ++seqN;
  const e = { seq: String(s), updatedSeq: String(s), kind, ...(role ? { role } : {}), ...(text !== undefined ? { text } : {}), createdAtMs: at };
  bot(a).entries.push(e);
  return e;
}
// Seed from the relay's mock history (oldest first, all bots interleaved by time, like one global sequence).
const HIST = process.env.MOCK_HISTORY_DIR;
if (HIST) {
  const all = [];
  for (const f of readdirSync(HIST).filter((f) => f.endsWith(".json"))) {
    try { for (const m of JSON.parse(readFileSync(join(HIST, f), "utf8"))) all.push({ a: f.slice(0, -5), m }); } catch {}
  }
  all.sort((x, y) => x.m.at - y.m.at);
  for (const { a, m } of all) {
    if (m.role === "user") add(a, "message", "user", m.text, m.at);
    else if (m.role === "bot") add(a, "send-message", undefined, m.text, m.at);
  }
  for (const b of bots.values()) b.readPos = b.entries.length; // the relay "has read" everything in its history
}
const deliveries = (b, from) => b.entries.slice(from).filter((e) => e.kind === "send-message" && e.text).map((e) => e.text);
const working = (b) => Date.now() < b.turnEnd;
const ok = (res, result) => res.end(JSON.stringify({ ok: true, isError: false, result }));
let pi = 0;
let peekFail = { status: 0, n: 0 }; // POST /mock/fail {status, n}: the next n g2_peek calls fail like the real API would
function proactive(a, p = PROACTIVE[pi++ % PROACTIVE.length]) {
  if (p.kind === "card") add(a, "send-message", undefined, undefined);
  else if (p.kind === "attachment") add(a, "user-attachment", undefined, undefined);
  else if (p.kind === "card-answered") { // answered in the Grok Bot app: no user message, the card's updatedSeq moves
    const c = [...bot(a).entries].reverse().find((e) => e.kind === "send-message" && e.text === undefined);
    if (c) c.updatedSeq = String(++seqN);
    if (p.reply) setTimeout(() => add(a, "send-message", undefined, p.reply), 1000);
  }
  else if (p.kind === "user") { add(a, "message", "user", p.text); setTimeout(() => add(a, "send-message", undefined, p.reply ?? "OK."), 2000); }
  else add(a, "send-message", undefined, p.text);
  console.log("proactive", a, p.kind ?? "text");
}
const PMS = Number(process.env.MOCK_PROACTIVE_MS ?? 0);
if (PMS > 0) { let k = 0; setInterval(() => { const names = [...bots.keys()]; if (names.length) proactive(names[k++ % Math.min(3, names.length)]); }, PMS); }

http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.url === "/mock/fail") { const j = JSON.parse(body || "{}"); peekFail = { status: Number(j.status ?? 429), n: Number(j.n ?? 1) }; return res.end(JSON.stringify({ ok: true })); }
  if (req.url === "/mock/proactive") {
    const j = JSON.parse(body || "{}");
    proactive(String(j.agent ?? "Assistant"), j.kind || j.text ? { kind: j.kind, text: j.text, reply: j.reply } : undefined);
    return res.end(JSON.stringify({ ok: true }));
  }
  const name = req.url.split("/").pop(), input = JSON.parse(body || "{}").input ?? {};
  if (name === "grokbot__list") return ok(res, { contacted: [] });
  if (name === "grokbot__interrupt") { bot(String(input.agent ?? "")).turnEnd = 0; return ok(res, { ok: true }); }
  const a = String(input.agent ?? ""), b = bot(a);
  if (name === "g2_peek") {
    if (peekFail.n > 0) { peekFail.n--; return res.end(JSON.stringify({ ok: true, isError: true, result: { content: [{ type: "text", text: `Grok Bot API GET /v0/grokbot/sessions/…/entries ${peekFail.status}: mock failure` }] } })); }
    const after = Number(input.after ?? -1);
    const page = b.entries.filter((e) => Number(e.updatedSeq) > after).sort((x, y) => Number(x.updatedSeq) - Number(y.updatedSeq)).slice(0, 200);
    const latest = page.length ? page[page.length - 1].updatedSeq : String(after < 0 ? (b.entries.at(-1)?.updatedSeq ?? "-1") : after);
    return ok(res, { agent: a, latestUpdatedSeq: latest, turn: { idle: !working(b), inFlight: working(b), queued: 0 }, entries: page,
      pages: 1, more: b.entries.some((e) => Number(e.updatedSeq) > Number(latest)), rate: {}, resolved: false });
  }
  if (name === "grokbot__ask") {
    if (working(b)) return res.end(JSON.stringify({ ok: true, isError: true, result: { content: [{ type: "text", text: `"${a}" is still working on an earlier message; nothing was sent.` }] } }));
    const earlier = deliveries(b, b.readPos);
    add(a, "message", "user", String(input.message ?? ""));
    b.readPos = b.entries.length;
    const long = /long/i.test(String(input.message ?? ""));
    const turn = long ? [[3000, LONG]] : TURN;
    b.turnEnd = Date.now() + (long ? 4000 : 12000);
    for (const [ms, text] of turn) setTimeout(() => add(a, "send-message", undefined, text), ms);
    const deadline = Date.now() + (input.wait_seconds ?? 0) * 1000;
    const from = b.readPos;
    while (working(b) && Date.now() < deadline) await sleep(300);
    const out = deliveries(b, from); b.readPos = b.entries.length;
    return ok(res, { status: working(b) ? "running" : "finished", reply: out.join("\n\n") || undefined, earlierReplies: earlier.length ? earlier : undefined });
  }
  if (name === "grokbot__check") {
    if (!working(b) && b.readPos >= b.entries.length && process.env.MOCK_PASSIVE === "1" && !b.passiveDone) {
      b.passiveDone = true; add(a, "send-message", undefined, PASSIVE);
    }
    const deadline = Date.now() + (input.wait_seconds ?? 0) * 1000;
    const from = b.readPos;
    for (;;) {
      const got = deliveries(b, from);
      if ((got.length && !working(b)) || !working(b) || Date.now() >= deadline) {
        b.readPos = b.entries.length;
        return ok(res, { status: working(b) ? "running" : "finished", reply: got.join("\n\n") || undefined });
      }
      if (got.length) { b.readPos = b.entries.length; return ok(res, { status: "running", reply: got.join("\n\n") }); }
      await sleep(300);
    }
  }
  res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "unknown tool" }));
}).listen(Number(process.env.MOCK_BDK_PORT ?? 3199), "127.0.0.1");
