// Ping checks against the MOCK relay only (./run.sh mock): rate limit, busy (409 + since), relay history.
// Usage: node tools/ping-test.mjs   (reads RELAY_TOKEN from .env; refuses anything but the mock relay on :8799)
import { readFileSync } from "node:fs";
const RELAY = "http://127.0.0.1:8799";
const TOKEN = readFileSync(".env", "utf8").match(/^RELAY_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const mockBots = JSON.parse(readFileSync("test/mock-data/bots.json", "utf8")).map((b) => b.name).sort().join(",");
const relayBots = (await (await fetch(`${RELAY}/bots`, { headers: H })).json()).bots.map((b) => b.name).sort().join(",");
if (mockBots !== relayBots) { console.error("refusing: :8799 is not the mock relay"); process.exit(2); }
const results = [];
const check = (name, ok, info) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${info === undefined ? "" : " " + JSON.stringify(info)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PING = "Any update? Give me a short status.";
const stream = (bot, text, ping) => fetch(`${RELAY}/chat/stream`, { method: "POST", headers: H, body: JSON.stringify({ bot, text, ...(ping ? { ping: true } : {}) }) });

// 1. a ping is a normal streamed turn
const r1 = await stream("Planner", PING, true);
const t1 = await r1.text();
check("ping streams a reply (200, message + done)", r1.status === 200 && /event: message/.test(t1) && /event: done/.test(t1), r1.status);
// 2. a second ping within 30 s is refused before anything is sent
const before = (await (await fetch(`${RELAY}/history?bot=Planner`, { headers: H })).json()).messages.length;
const r2 = await stream("Planner", PING, true);
const j2 = await r2.json();
check("second ping within 30 s -> 429 with retryAfter", r2.status === 429 && j2.retryAfter > 0 && j2.retryAfter <= 30, j2);
const after = (await (await fetch(`${RELAY}/history?bot=Planner`, { headers: H })).json()).messages.length;
check("refused ping records nothing", after === before, { before, after });
// 3. a normal message is not rate limited by the ping gate (only the busy check applies)
const r3 = await stream("Planner", "normal message after a ping", false);
await r3.text();
check("normal message right after a ping is allowed", r3.status === 200, r3.status);
// 4. ping a bot that is busy (a turn running): 409 with working + since, nothing recorded
const busyTurn = stream("Coder", "start a turn", false); // mock turn runs ~12 s
await sleep(1500);
const hb = (await (await fetch(`${RELAY}/history?bot=Coder`, { headers: H })).json()).messages.length;
const r4 = await stream("Coder", PING, true);
const j4 = await r4.json();
check("ping while busy -> 409 with working + since", r4.status === 409 && j4.working === true && typeof j4.since === "number", j4);
const ha = (await (await fetch(`${RELAY}/history?bot=Coder`, { headers: H })).json()).messages.length;
check("busy ping records nothing", ha === hb, { hb, ha });
await (await busyTurn).text();
// 5. once idle, the ping goes through (the busy ping did not count against the 30 s limit)
const r5 = await stream("Coder", PING, true);
await r5.text();
check("after the turn ends the ping is sent (a refused ping does not count)", r5.status === 200, r5.status);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
