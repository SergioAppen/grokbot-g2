// Background sync + /events test against the MOCK stack (./run.sh mock, ideally with SYNC_ACTIVE_MS=3000).
// Usage: node tools/sync-test.mjs   (reads RELAY_TOKEN from .env; refuses anything but the mock relay on :8799)
import { readFileSync } from "node:fs";
const RELAY = "http://127.0.0.1:8799", MOCK = "http://127.0.0.1:3199";
const TOKEN = readFileSync(".env", "utf8").match(/^RELAY_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const mockBots = JSON.parse(readFileSync("test/mock-data/bots.json", "utf8")).map((b) => b.name).sort();
const live = (await (await fetch(`${RELAY}/bots`, { headers: H })).json()).bots.map((b) => b.name).sort();
if (JSON.stringify(live) !== JSON.stringify(mockBots)) { console.error("not the mock relay; refusing"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail).slice(0, 220) : ""}`); };
const j = async (path, init) => (await fetch(RELAY + path, { headers: H, ...init })).json();
const inject = (body) => fetch(`${MOCK}/mock/proactive`, { method: "POST", body: JSON.stringify(body) });
const hist = async (bot) => (await j(`/history?bot=${bot}`)).messages;

// SSE reader (fetch stream, like the app)
function sse(lastId) {
  const ac = new AbortController(), events = []; let last = lastId ?? "";
  (async () => {
    const r = await fetch(`${RELAY}/events`, { headers: { authorization: H.authorization, ...(lastId ? { "last-event-id": lastId } : {}) }, signal: ac.signal });
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(f)?.[1], data = /^data: (.*)$/m.exec(f)?.[1], id = /^id: (.*)$/m.exec(f)?.[1];
        if (id) last = id; if (ev) events.push({ ev, id, data: data ? JSON.parse(data) : null }); } } } catch {}
  })();
  return { events, close: () => ac.abort(), last: () => last };
}
const waitFor = async (pred, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = pred(); if (v) return v; await sleep(200); } return null; };

const s1 = sse();
check("hello event", !!(await waitFor(() => s1.events.find((e) => e.ev === "hello"))));
const before = (await hist("Research")).length;
await inject({ agent: "Research", text: "Routine: weekly paper digest is ready." });
const m1 = await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.bot === "Research" && e.data.msg.text.includes("paper digest")));
check("proactive message arrives as SSE message (origin sync)", m1?.data.origin === "sync", m1?.data);
check("unread event follows", !!(await waitFor(() => s1.events.find((e) => e.ev === "unread" && e.data.bot === "Research" && e.data.unread >= 1))));
await sleep(4000);
const h1 = await hist("Research");
check("stored once in history", h1.filter((m) => m.text.includes("paper digest")).length === 1 && h1.length === before + 1, { before, after: h1.length });
await inject({ agent: "Research", text: "Should I add the two new papers to your reading list?" });
const q = await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.text.startsWith("Should I add")));
check("question flagged attn", q?.data.msg.attn === true);
await inject({ agent: "Research", kind: "card" });
const card = await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.text.startsWith("[card or file")));
check("card (no text) shown as placeholder + attn", card?.data.msg.attn === true);
const nCards = async () => (await hist("Research")).filter((m) => m.text.startsWith("[card or file")).length;
await inject({ agent: "Research", kind: "card-answered", reply: "Thanks, going with the free test first." });
check("card answered in the app: follow-up reply arrives", !!(await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.text.startsWith("Thanks, going with")))));
check("answered card (updatedSeq bump) is not duplicated", (await nCards()) === 1, { cards: await nCards() });
await inject({ agent: "Research", kind: "attachment" });
const att = await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.role === "user" && e.data.msg.text.startsWith("[image or file")));
check("user-attachment shown as a placeholder user line", !!att && !att.data.msg.attn);
await inject({ agent: "Research", kind: "user", text: "Typed in the Grok Bot app", reply: "Reply to the app message." });
const u = await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.role === "user" && e.data.msg.text === "Typed in the Grok Bot app"));
check("user message typed in the app is synced", !!u);
check("its reply too", !!(await waitFor(() => s1.events.find((e) => e.ev === "message" && e.data.msg.text === "Reply to the app message."))));

// earlierReplies: a message lands while nobody reads, then the glasses send -> stream shows it as "earlier", stored once
await inject({ agent: "Assistant", text: "Earlier note from a routine: parcel delivered." });
const sr = await fetch(`${RELAY}/chat/stream`, { method: "POST", headers: H, body: JSON.stringify({ bot: "Assistant", text: "hello from the sync test" }) });
const txt = await sr.text();
check("stream emits earlier event with the routine note", /event: earlier\ndata: .*parcel delivered/.test(txt));
check("no sync-origin message for Assistant during the stream", !s1.events.some((e) => e.ev === "message" && e.data.bot === "Assistant" && e.data.origin === "sync"));
await sleep(8000); // let the poller merge the turn
const ha = await hist("Assistant");
const dup = Object.entries(ha.reduce((a, m) => ((a[m.role + m.text] = (a[m.role + m.text] ?? 0) + 1), a), {})).filter(([, n]) => n > 1);
check("no duplicates after the poller merged the streamed turn", dup.length === 0, dup);
check("relay-recorded messages adopted their seq", ha.filter((m) => m.text.includes("two meetings today") && m.seq).length === 1);
check("bot-status events while the relay streamed", s1.events.some((e) => e.ev === "bot-status" && e.data.bot === "Assistant" && e.data.busy === true));

// resume with Last-Event-ID
const lastId = s1.last(); s1.close(); await sleep(300);
await inject({ agent: "Finance", text: "Card payment of 42 EUR at the grocery store." });
await sleep(7000);
const s2 = sse(lastId);
check("missed event replayed after reconnect (Last-Event-ID)", !!(await waitFor(() => s2.events.find((e) => e.ev === "message" && e.data.msg.text.includes("42 EUR")), 5000)));
const s3 = sse("deadbeef:1");
check("unknown boot id -> reset", !!(await waitFor(() => s3.events.find((e) => e.ev === "reset"), 5000)));
s3.close();

// an unread question keeps the conversation flagged even after a plain message follows it
const rq = (await j("/conversations")).conversations.find((c) => c.name === "Research");
check("unread question keeps conversation attn after later plain messages", rq.attn === true && rq.last?.attn !== true, { attn: rq.attn, last: rq.last });
// seen -> unread 0
const seen = await j("/seen", { method: "POST", body: JSON.stringify({ bot: "Research" }) });
check("POST /seen clears unread", seen.unread === 0, seen);
const conv = (await j("/conversations")).conversations.find((c) => c.name === "Research");
check("/conversations carries unread + attn (cleared by /seen)", conv.unread === 0 && conv.attn === false, { unread: conv.unread, attn: conv.attn });

// 429 backoff
await fetch(`${MOCK}/mock/fail`, { method: "POST", body: JSON.stringify({ status: 429, n: 1 }) });
const st = await waitFor(async () => null, 0); await sleep(5000);
const status = await j("/sync/status");
check("429 from the API -> backoff", !!status.backoffUntil && /429/.test(status.lastError ?? ""), { backoffUntil: status.backoffUntil, lastError: status.lastError });
check("request rate reported", typeof status.requestsLastHour === "number", { requestsLastHour: status.requestsLastHour, intervalMs: status.intervalMs });
s2.close();
const n = results.filter(Boolean).length; console.log(`\n${n}/${results.length} passed`); process.exit(n === results.length ? 0 : 1);
