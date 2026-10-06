#!/usr/bin/env bash
# Usage: tools/stream-test.sh "<message>" <bot> [url]
#   Streams POST /chat/stream with per-event timestamps. url defaults to RELAY_PUBLIC_URL from .env
#   (use http://127.0.0.1:8799 with the mock setup, see README "Testing without a real bot").
#   This SENDS A REAL MESSAGE to <bot> unless you point it at the mock relay.
cd "$(dirname "$0")/.." && set -a && . ./.env && set +a
[ -n "${2:-}" ] || { echo "usage: $0 \"<message>\" <bot> [url]" >&2; exit 1; }
URL=${3:-$RELAY_PUBLIC_URL}
start=$(date +%s%3N)
curl -sN -m 660 -X POST "$URL/chat/stream" -H "authorization: Bearer $RELAY_TOKEN" -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"bot":sys.argv[2],"text":sys.argv[1]}))' "$1" "$2")" -w '\nHTTP %{http_code}\n' |
  while IFS= read -r l; do [ -n "$l" ] && echo "$(( $(date +%s%3N) - start ))ms  ${l:0:300}"; done
