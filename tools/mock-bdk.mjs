// Fake bdk tools API (POST /v1/tools/grokbot__*) for offline testing of the relay and app — no real bot is contacted.
// Every ask gets a turn of 3 messages at +3 s, +7 s and +11 s; the turn ends at +12 s. Port: MOCK_BDK_PORT (3199).
import http from "node:http";
let t0 = 0, cursor = 0;
const msgs = [[3000, "On it, checking your calendar."], [7000, "You have two meetings today: 10:00 design review and 15:30 team sync."], [11000, "Want me to prepare notes for the design review?"]], END = 12000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const name = req.url.split("/").pop(), input = JSON.parse(b || "{}").input ?? {};
  if (name === "grokbot__ask") { t0 = Date.now(); cursor = 0; }
  const deadline = Date.now() + (input.wait_seconds ?? 0) * 1000;
  const out = [];
  for (;;) {
    const el = Date.now() - t0;
    while (cursor < msgs.length && msgs[cursor][0] <= el) out.push(msgs[cursor++][1]);
    if (el >= END && cursor === msgs.length) return res.end(JSON.stringify({ ok: true, isError: false, result: { status: "finished", reply: out.join("\n\n") || undefined } }));
    if (Date.now() >= deadline) return res.end(JSON.stringify({ ok: true, isError: false, result: { status: "running", reply: out.join("\n\n") || undefined } }));
    await sleep(400);
  }
}).listen(Number(process.env.MOCK_BDK_PORT ?? 3199), "127.0.0.1");
