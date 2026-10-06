// Fake bdk tools API (POST /v1/tools/grokbot__*) for offline testing of the relay and app — no real bot is contacted.
// Per bot:
//   • an ask containing "long" gets one ~3000-character message (app/test/sample-long.txt) at +3 s; the turn ends at +4 s
//   • any other ask gets a turn of 3 messages at +3 s, +7 s and +11 s; the turn ends at +12 s
//   • with MOCK_PASSIVE=1, the first check of a bot with no turn running returns one message the bot "sent on its own"
// Port: MOCK_BDK_PORT (3199).
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const LONG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "app", "test", "sample-long.txt"), "utf8");
const TURN = [[3000, "On it, checking your calendar."], [7000, "You have two meetings today: 10:00 design review and 15:30 team sync."], [11000, "Want me to prepare notes for the design review?"]];
const PASSIVE = "Heads-up: the 15:30 team sync moved to 16:00. No action needed.";
const state = new Map(); // agent -> { t0, cursor, msgs, end, passiveDone }
const get = (a) => { if (!state.has(a)) state.set(a, { t0: 0, cursor: 0, msgs: [], end: 0, passiveDone: false }); return state.get(a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (res, status, out) => res.end(JSON.stringify({ ok: true, isError: false, result: { status, reply: out.join("\n\n") || undefined } }));
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const name = req.url.split("/").pop(), input = JSON.parse(b || "{}").input ?? {};
  if (name === "grokbot__list") return res.end(JSON.stringify({ ok: true, isError: false, result: { contacted: [] } }));
  if (name === "grokbot__interrupt") return res.end(JSON.stringify({ ok: true, isError: false, result: { ok: true } }));
  const s = get(String(input.agent ?? ""));
  if (name === "grokbot__ask") {
    const long = /long/i.test(String(input.message ?? ""));
    Object.assign(s, { t0: Date.now(), cursor: 0, msgs: long ? [[3000, LONG]] : TURN, end: long ? 4000 : 12000 });
  } else if (name === "grokbot__check" && Date.now() - s.t0 > s.end && s.cursor >= s.msgs.length) {
    // No turn running: optionally deliver one passive message.
    if (process.env.MOCK_PASSIVE === "1" && !s.passiveDone) { s.passiveDone = true; return reply(res, "finished", [PASSIVE]); }
    return reply(res, "finished", []);
  }
  const deadline = Date.now() + (input.wait_seconds ?? 0) * 1000;
  const out = [];
  for (;;) {
    const el = Date.now() - s.t0;
    while (s.cursor < s.msgs.length && s.msgs[s.cursor][0] <= el) out.push(s.msgs[s.cursor++][1]);
    if (el >= s.end && s.cursor === s.msgs.length) return reply(res, "finished", out);
    if (Date.now() >= deadline) return reply(res, "running", out);
    await sleep(400);
  }
}).listen(Number(process.env.MOCK_BDK_PORT ?? 3199), "127.0.0.1");
