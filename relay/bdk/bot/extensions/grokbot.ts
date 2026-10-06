import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import cursorGrokBotAgents from "@cursor/bdk/extensions/cursor-grokbot-agents";

// Allowlist = the names in bots.json (exact spelling as shown in the Grok Bot app).
// The Grok Bot backend looks bots up BY NAME and creates a new, empty bot for an unknown name,
// so list names exactly as they appear in Grok Bot. run.sh passes BOTS_FILE; the fallback
// assumes `bdk serve` runs with relay/bdk as its working directory.
const botsFile = process.env.BOTS_FILE ?? resolve(process.cwd(), "../../bots.json");
const bots: { name: string }[] = JSON.parse(readFileSync(botsFile, "utf8"));

export default cursorGrokBotAgents({
  agents: bots.map((b) => b.name),
  // Faster transcript polling so /chat/stream can surface each bot message within ~1-2 s.
  pollIntervalMs: 400,
});
