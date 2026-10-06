#!/usr/bin/env bash
# Phone-UI layout/keyboard test in headless WebKit + Chromium against the MOCK stack (start it first: ./run.sh mock).
# Builds app/test/phone-harness.ts (mounts the phone UI without the Even bridge), serves it on a free local port,
# runs app/test/phone-ui.e2e.cjs, writes screenshots to test/sim/phone_*.png. Playwright is installed once into
# run/phone-test/ (git-ignored). Linux hosts without the WebKit system libs: see GROK.md "Phone UI test".
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD; PT=$ROOT/run/phone-test; H=$PT/h; PWV=${PLAYWRIGHT_VERSION:-1.63.0}
# Deliberately NOT the generic RELAY_* env vars (a shell that sourced the real .env would point this at the real
# relay): only PHONE_TEST_RELAY / PHONE_TEST_TOKEN override the mock defaults, and only loopback URLs are accepted.
RELAY=${PHONE_TEST_RELAY:-http://127.0.0.1:8799}
TOKEN=${PHONE_TEST_TOKEN:-$( [ -f .env ] && sed -n 's/^RELAY_TOKEN=//p' .env | tr -d '\r' | head -1 )}
case "$RELAY" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-loopback relay $RELAY (mock stack only)"; exit 1;; esac
curl -fsS -o /dev/null "$RELAY/health" || { echo "relay not reachable at $RELAY (run ./run.sh mock first)"; exit 1; }
# Must be the mock relay: its bot names must equal test/mock-data/bots.json (written by ./run.sh mock).
[ -f test/mock-data/bots.json ] || { echo "test/mock-data/bots.json missing (run ./run.sh mock first)"; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$RELAY/bots" 2>/dev/null | python3 -c '
import json, sys
live = sorted(b["name"] for b in json.load(sys.stdin)["bots"])
mock = sorted(b["name"] for b in json.load(open("test/mock-data/bots.json")))
sys.exit(0 if live == mock else 1)' 2>/dev/null || { echo "$RELAY is not the mock relay (or the token was rejected); refusing"; exit 1; }
mkdir -p "$H"
[ -d "$PT/node_modules/playwright" ] || { npm i --prefix "$PT" --no-audit --no-fund "playwright@$PWV" >/dev/null; (cd "$PT" && npx playwright install webkit chromium); }
app/node_modules/.bin/esbuild app/test/phone-harness.ts --bundle --format=esm --target=es2020 --log-level=warning --outfile="$H/harness.js"
cp app/test/phone-harness.html "$H/index.html"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$H" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 0.5
HARNESS_URL="http://127.0.0.1:$PORT/index.html" RELAY="$RELAY" RELAY_TOKEN="$TOKEN" OUT="${OUT:-$ROOT/test/sim}" \
  NODE_PATH="$PT/node_modules" node app/test/phone-ui.e2e.cjs
