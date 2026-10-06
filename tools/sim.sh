#!/usr/bin/env bash
# Headless Even Hub simulator (Linux x64; needs xvfb-run, plus xdotool for sim-pair.sh) with the automation API on :9898.
#   tools/sim.sh start [url]   default url: the mock relay's copy of the app, http://127.0.0.1:8799/app/#relay=http://127.0.0.1:8799
#                              (#relay= makes the app use the mock even if app/.env.production bakes in your real relay URL)
#   tools/sim.sh stop
# Automation API: GET /api/screenshot/glasses | /api/screenshot/webview, POST /api/input {"action":"up|down|click|double_click"}
# Glasses screenshots keep brightness in the alpha channel: run tools/hudview.py on them for a viewable PNG.
cd "$(dirname "$0")/.."
mkdir -p run test/sim/home
SIM=$PWD/app/node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator
case "$1" in
  start) HOME=$PWD/test/sim/home setsid xvfb-run -n 99 -s "-screen 0 1400x1000x24" "$SIM" --no-glow --automation-port 9898 "${2:-http://127.0.0.1:8799/app/#relay=http://127.0.0.1:8799}" > logs/sim.log 2>&1 < /dev/null &
         echo $! > run/sim.pid
         for i in $(seq 1 40); do curl -s localhost:9898/api/ping >/dev/null && break; sleep 1; done; echo "sim up (pgid $(cat run/sim.pid))";;
  stop)  [ -f run/sim.pid ] && kill -- -"$(cat run/sim.pid)" 2>/dev/null; rm -f run/sim.pid; echo stopped;;
  *) echo "usage: $0 start [url] | stop";;
esac
