#!/usr/bin/env bash
# Grok Bot G2 — self-hosted relay. All settings come from .env (copy .env.example).
#
#   ./run.sh setup          check Node, npm ci (relay/bdk + app + relay), create .env secrets if missing
#   ./run.sh start          ensure the tunnel (TUNNEL_MODE; starts our own tailscaled + Funnel if configured),
#                           (re)start bdk + relay, print status
#   ./run.sh ts-login       start our own tailscaled if configured and print the Tailscale login link / relay URL
#   ./run.sh restart-relay  restart bdk + relay only (tunnel untouched)
#   ./run.sh reload-relay   restart the relay only (bdk + tunnel untouched; e.g. after a git pull)
#   ./run.sh stop           stop bdk + relay (+ cloudflared if this script started it)
#   ./run.sh status         process status + public /health
#   ./run.sh pair           print a one-time 6-digit pairing code (valid 10 min) for the phone app
#   ./run.sh build          avatars + app build (relay URL baked in) + .ehpk + QR codes
#   ./run.sh mock [stop]    offline test stack: mock bdk (:3199) + relay (:8799) with example history
#   ./run.sh whisper        optional: install local Whisper STT (faster-whisper in ./.whisper-venv) + download the model
#
# Every process is started with setsid and tracked in run/<name>.pid; stop only kills those groups.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
mkdir -p logs run

[ -f .env ] || { [ "${1:-}" = setup ] || { echo "No .env — run: cp .env.example .env && ./run.sh setup" >&2; exit 1; }; }
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# Node 22.13+ (NODE_BIN_DIR lets you point at a local install without touching the system node)
[ -n "${NODE_BIN_DIR:-}" ] && export PATH="$NODE_BIN_DIR:$PATH"
RELAY_PORT=${RELAY_PORT:-8787}; BDK_PORT=${BDK_PORT:-3100}
TUNNEL_MODE=${TUNNEL_MODE:-tailscale-funnel}
DATA_DIR=${DATA_DIR:-$ROOT/data}; export DATA_DIR
export BOTS_FILE=${BOTS_FILE:-$ROOT/bots.json}
mkdir -p "$DATA_DIR"

launch() { local name=$1; shift; setsid nohup "$@" >> "logs/$name.log" 2>&1 < /dev/null & echo $! > "run/$name.pid"; }
alive() { [ -f "run/$1.pid" ] && kill -0 "$(cat "run/$1.pid")" 2>/dev/null; }
stop_one() { if alive "$1"; then kill -- -"$(cat "run/$1.pid")" 2>/dev/null || kill "$(cat "run/$1.pid")" 2>/dev/null || true; fi; rm -f "run/$1.pid"; }

check_node() {
  command -v node >/dev/null || { echo "node not found (need 22.13+; set NODE_BIN_DIR in .env)" >&2; exit 1; }
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
    || { echo "Node $(node -v) is too old: need 22.13+ (set NODE_BIN_DIR in .env)" >&2; exit 1; }
}
setenv() { # setenv KEY VALUE — set/replace in .env without echoing the value
  python3 - "$1" "$2" <<'PY'
import re, sys, os
k, v = sys.argv[1], sys.argv[2]; p = ".env"
s = open(p).read() if os.path.exists(p) else ""
s = re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s + ("" if s.endswith("\n") or not s else "\n") + f"{k}={v}\n"
open(p, "w").write(s)
PY
}
setup() {
  check_node
  [ -f .env ] || cp .env.example .env
  chmod 600 .env
  set -a; . ./.env; set +a
  for k in RELAY_TOKEN BDK_TOKEN; do
    if [ -z "${!k:-}" ]; then setenv "$k" "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"; echo "generated $k (stored in .env)"; fi
  done
  [ -f bots.json ] || { cp bots.example.json bots.json; echo "created bots.json from bots.example.json — edit it to your bots' EXACT names"; }
  (cd relay/bdk && npm ci --no-audit --no-fund)
  (cd relay && npm ci --no-audit --no-fund)
  (cd app && npm ci --no-audit --no-fund)
  echo "setup done. Next: edit bots.json and .env (RELAY_PUBLIC_URL, CURSOR_API_KEY, STT…), then ./run.sh build && ./run.sh start"
}

# ---------- tunnels ----------
ts() { local bin=${TAILSCALE_BIN:-tailscale}; local a=(); [ -n "${TAILSCALE_SOCKET:-}" ] && a=(--socket="$TAILSCALE_SOCKET")
       if [ "${TAILSCALE_SUDO:-0}" = 1 ]; then sudo -n "$bin" "${a[@]}" "$@"; else "$bin" "${a[@]}" "$@"; fi; }
# Own tailscaled (no root/apt needed): TAILSCALED_BIN + TAILSCALE_STATE_DIR; its socket defaults to the state dir.
[ -n "${TAILSCALE_STATE_DIR:-}" ] && [ -z "${TAILSCALE_SOCKET:-}" ] && export TAILSCALE_SOCKET="$TAILSCALE_STATE_DIR/tailscaled.sock"
ts_running() { ts status --json >/dev/null 2>&1; }   # daemon reachable (logged in or not)
ts_logged_in() { ts status >/dev/null 2>&1; }
ts_dns() { ts status --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null; }
start_tailscaled() {
  ts_running && return 0
  if [ -n "${TAILSCALED_BIN:-}" ] && [ -n "${TAILSCALE_STATE_DIR:-}" ]; then
    # --statedir is required for Funnel HTTPS certs (without it: "no TailscaleVarRoot" -> TLS internal error).
    echo "starting tailscaled…"
    mkdir -p "$TAILSCALE_STATE_DIR"
    local pre=(); [ "${TAILSCALE_SUDO:-0}" = 1 ] && pre=(sudo -n)
    "${pre[@]}" setsid nohup "$TAILSCALED_BIN" --state="$TAILSCALE_STATE_DIR/tailscaled.state" --statedir="$TAILSCALE_STATE_DIR" \
      --socket="$TAILSCALE_SOCKET" ${TAILSCALED_FLAGS:-} >> logs/tailscaled.log 2>&1 < /dev/null &
    echo $! > run/tailscaled.pid
    for i in $(seq 1 30); do ts_running && return 0; sleep 1; done
    echo "tailscaled did not start; see logs/tailscaled.log" >&2; exit 1
  fi
}
ts_login() {  # ./run.sh ts-login: start tailscaled if needed and print the login URL for the user
  start_tailscaled
  if ts_logged_in; then echo "Tailscale is logged in. Relay URL: https://$(ts_dns)"; return 0; fi
  : > logs/tailscale-login.log
  ( ts up --hostname="${TAILSCALE_HOSTNAME:-grokbot-g2}" >> logs/tailscale-login.log 2>&1 < /dev/null & )
  for i in $(seq 1 30); do grep -qo 'https://login.tailscale.com/[^ ]*' logs/tailscale-login.log && break; ts_logged_in && break; sleep 1; done
  if ts_logged_in; then echo "Tailscale is logged in. Relay URL: https://$(ts_dns)"; return 0; fi
  local url; url=$(grep -o 'https://login.tailscale.com/[^ ]*' logs/tailscale-login.log | head -1)
  [ -n "$url" ] || { echo "no login URL yet; see logs/tailscale-login.log" >&2; exit 1; }
  echo "Send this login link to the user (it signs this machine into their tailnet): $url"
  echo "Then run ./run.sh ts-login again: it prints the relay URL (put it in RELAY_PUBLIC_URL)."
}
ensure_tailscale() {
  start_tailscaled
  ts_logged_in || { echo "Tailscale is not logged in: run ./run.sh ts-login (or 'tailscale up') and open the login link." >&2; exit 1; }
  if ! ts funnel status 2>/dev/null | grep -q "127.0.0.1:$RELAY_PORT"; then
    # If Funnel/HTTPS is not enabled for the tailnet yet, the CLI prints an admin link and waits: show it instead of hanging.
    if ! timeout 25 bash -c "$(declare -f ts); ts funnel --bg $RELAY_PORT" > logs/funnel.log 2>&1; then
      local url; url=$(grep -o 'https://login.tailscale.com/[^ ]*' logs/funnel.log | head -1)
      echo "Could not enable Funnel.${url:+ The tailnet admin must allow it here: $url}" >&2
      echo "(details: logs/funnel.log; then run ./run.sh start again)" >&2; exit 1
    fi
  fi
}
ensure_cloudflare() {
  # Named tunnel only (quick tunnels change URL every run, which breaks the packaged app's whitelist).
  # Either CLOUDFLARE_TUNNEL_TOKEN (dashboard-managed tunnel; passed via env, not argv) or CLOUDFLARE_TUNNEL=<name>
  # (locally-managed, after `cloudflared tunnel login/create/route dns`).
  alive cloudflared && return 0
  command -v "${CLOUDFLARED_BIN:-cloudflared}" >/dev/null || { echo "cloudflared not found" >&2; exit 1; }
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" launch cloudflared "${CLOUDFLARED_BIN:-cloudflared}" tunnel --no-autoupdate run
  elif [ -n "${CLOUDFLARE_TUNNEL:-}" ]; then
    launch cloudflared "${CLOUDFLARED_BIN:-cloudflared}" tunnel --no-autoupdate run --url "http://127.0.0.1:$RELAY_PORT" "$CLOUDFLARE_TUNNEL"
  else echo "TUNNEL_MODE=cloudflare needs CLOUDFLARE_TUNNEL_TOKEN or CLOUDFLARE_TUNNEL in .env" >&2; exit 1; fi
}
ensure_tunnel() {
  case "$TUNNEL_MODE" in
    tailscale-funnel) ensure_tailscale;;
    cloudflare) ensure_cloudflare;;
    none) ;;
    *) echo "unknown TUNNEL_MODE=$TUNNEL_MODE (tailscale-funnel|cloudflare|none)" >&2; exit 1;;
  esac
}

# ---------- services ----------
start_bdk() {
  [ -n "${CURSOR_API_KEY:-}" ] || { echo "CURSOR_API_KEY missing in .env" >&2; exit 1; }
  # bdk binds 127.0.0.1 only; its bearer token protects it from other local processes.
  ( cd relay/bdk; setsid nohup npx bdk serve --dir . --mode single --port "$BDK_PORT" \
      --bearer-token "$BDK_TOKEN" --no-playground >> "$ROOT/logs/bdk.log" 2>&1 < /dev/null & echo $! > "$ROOT/run/bdk.pid" ) > /dev/null 2>&1
  for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$BDK_PORT/v1/tools" && return 0; sleep 1; done
  echo "bdk did not come up; see logs/bdk.log" >&2; return 1
}
start_relay() { launch relay node --experimental-strip-types --no-warnings relay/server.ts; sleep 1; alive relay || { echo "relay failed; see logs/relay.log" >&2; return 1; }; }
status() {
  for p in bdk relay cloudflared mock-bdk mock-relay; do
    if alive $p; then echo "$p: running (pgid $(cat run/$p.pid))"; elif [[ $p != mock* && $p != cloudflared ]]; then echo "$p: stopped"; fi
  done
  if [ "$TUNNEL_MODE" = tailscale-funnel ]; then
    if ts_logged_in; then echo "tailscale: up"; ts funnel status 2>/dev/null | grep -E "https://|proxy" | sed 's/^/  /'
    elif ts_running; then echo "tailscale: running, NOT logged in (./run.sh ts-login)"; else echo "tailscale: DOWN"; fi
  fi
  printf "local  /health: "; curl -s -m 5 "http://127.0.0.1:$RELAY_PORT/health" || printf "unreachable"; echo
  [ -n "${RELAY_PUBLIC_URL:-}" ] && { printf "public /health: "; curl -s -m 15 "$RELAY_PUBLIC_URL/health" || printf "unreachable"; echo; }
  return 0
}
pair() {
  local code; code=$(python3 -c "import secrets;print(f'{secrets.randbelow(10**6):06d}')")
  ( umask 077; python3 -c "import json,time,sys;json.dump({'code':sys.argv[1],'exp':int(time.time()*1000)+600000},open(sys.argv[2],'w'))" "$code" "$DATA_DIR/pair.json" )
  echo "Pairing code (valid 10 min, single use): $code"
  echo "Phone: Grok Bot G2 → Settings → Pairing code → Save & reconnect"
}
build() {
  check_node
  local U=${RELAY_PUBLIC_URL:?RELAY_PUBLIC_URL missing in .env}; U=${U%/}
  python3 tools/avatars.py
  python3 - "$U" "${APP_PACKAGE_ID:-}" <<'PY'
import json, sys
p = "app/app.json"; m = json.load(open(p))
for perm in m["permissions"]:
    if perm["name"] == "network": perm["whitelist"] = [sys.argv[1]]
if sys.argv[2]: m["package_id"] = sys.argv[2]
json.dump(m, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
  echo "VITE_RELAY_URL=$U" > app/.env.production   # default relay URL baked into the app (no secrets)
  (cd app && npm run build --silent && npx evenhub pack app.json dist -o grokbot-g2.ehpk)
  mkdir -p qr
  node tools/qr.mjs "$U/app/" qr/qr-app.png
  echo "built app/grokbot-g2.ehpk (relay $U); dev QR: qr/qr-app.png"
}
whisper() {
  # Local, free speech-to-text. CPU only, no compiler needed (prebuilt wheels). ~450 MB venv + ~145 MB "base" model.
  local py=$ROOT/.whisper-venv/bin/python model=${WHISPER_MODEL_NAME:-base} dir=${WHISPER_MODEL_DIR:-$DATA_DIR/whisper-models}
  if [ ! -x "$py" ]; then
    if command -v uv >/dev/null; then uv venv -q --python 3.12 .whisper-venv && uv pip install -q --python "$py" faster-whisper
    else python3 -m venv .whisper-venv && "$py" -m pip install -q faster-whisper; fi
  fi
  echo "downloading/loading the '$model' model into $dir …"
  WHISPER_MODEL_DIR="$dir" "$py" -c "import os,sys;from faster_whisper import WhisperModel;WhisperModel(sys.argv[1],device='cpu',compute_type=os.environ.get('WHISPER_COMPUTE','float32'),download_root=sys.argv[2]);print('whisper ready')" "$model" "$dir"
  echo "Pick it with STT_PROVIDER=whisper in .env or in the app (Settings → Voice), then ./run.sh reload-relay"
}
mock() {
  if [ "${1:-}" = stop ]; then stop_one mock-relay; stop_one mock-bdk; echo "mock stopped"; return; fi
  check_node
  mkdir -p "$ROOT/test/mock-data"
  [ -f "$ROOT/test/mock-data/bots.json" ] || cp bots.example.json "$ROOT/test/mock-data/bots.json"
  python3 tools/mock-history.py "$ROOT/test/mock-data/history"
  BOTS_FILE="$ROOT/test/mock-data/bots.json" DATA_DIR="$ROOT/test/mock-data" python3 tools/avatars.py >/dev/null
  stop_one mock-relay; stop_one mock-bdk
  MOCK_PASSIVE="${MOCK_PASSIVE:-1}" launch mock-bdk node tools/mock-bdk.mjs
  BOTS_FILE="$ROOT/test/mock-data/bots.json" DATA_DIR="$ROOT/test/mock-data" RELAY_PORT=8799 BDK_PORT=3199 TUNNEL_MODE=none \
    launch mock-relay node --experimental-strip-types --no-warnings relay/server.ts
  sleep 1.5; printf "mock relay http://127.0.0.1:8799 /health: "; curl -s http://127.0.0.1:8799/health; echo
  echo "Try: tools/stream-test.sh \"hello\" Assistant http://127.0.0.1:8799   (no real bot is contacted)"
}
case "${1:-start}" in
  setup) setup;;
  start) check_node; ensure_tunnel; stop_one relay; stop_one bdk; start_bdk; start_relay; status;;
  restart-relay) check_node; stop_one relay; stop_one bdk; start_bdk; start_relay; status;;
  reload-relay) check_node; stop_one relay; start_relay; status;;
  stop) stop_one relay; stop_one bdk; stop_one cloudflared; status;;
  status) status;;
  pair) pair;;
  build) build;;
  mock) shift; mock "${1:-}";;
  whisper) whisper;;
  ts-login) ts_login;;
  *) echo "usage: $0 [setup|start|ts-login|restart-relay|reload-relay|stop|status|pair|build|mock [stop]|whisper]"; exit 1;;
esac
