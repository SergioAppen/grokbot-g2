#!/usr/bin/env bash
# Pair the headless simulator (tools/sim.sh, mock stack from `./run.sh mock`) with a fresh one-time code:
# writes the code for the mock relay, then types it into the phone UI's Settings with xdotool.
# Coordinates match the simulator's default 600x800 phone window at (104,100).
cd "$(dirname "$0")/.."
PAIR_FILE=${PAIR_FILE:-test/mock-data/pair.json}
export DISPLAY=:99 XAUTHORITY=$(pgrep -a -x Xvfb | grep ' :99 ' | grep -o '/tmp/xvfb-run[^ ]*')
CODE=$(python3 -c "import secrets;print(f'{secrets.randbelow(10**6):06d}')")
( umask 077; python3 -c "import json,time,sys;json.dump({'code':sys.argv[1],'exp':int(time.time()*1000)+600000},open(sys.argv[2],'w'))" "$CODE" "$PAIR_FILE" )
xdotool mousemove 404 740 click 1; sleep 0.5; xdotool mousemove 404 740 click 1; sleep 0.3
xdotool type --delay 60 "$CODE"; sleep 0.3; xdotool mousemove 210 859 click 1; sleep 4; echo "pair attempted (check the phone screenshot)"
