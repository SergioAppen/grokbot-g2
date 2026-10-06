import { defineAgent } from "@cursor/bdk";

// The relay calls the Grok Bot extension's tools directly over bdk serve's HTTP API
// (POST /v1/tools/grokbot__ask|check|interrupt|list); no extra tools are needed.
export default defineAgent({
  tools: [],
});
