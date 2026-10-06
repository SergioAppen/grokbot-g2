#!/usr/bin/env bash
# Transcribe a WAV/PCM file through the relay's /stt, e.g. to check a provider or key.
#   tools/stt-test.sh [provider|auto] [file] [relay-url]
#   provider: elevenlabs | grok | whisper | auto (= the configured provider + fallback; default)
#   file:     default test/stt-sample.wav ("Hello from the G2 glasses. What is two plus two? Reply with just the number.")
#   relay:    default http://127.0.0.1:$RELAY_PORT (use http://127.0.0.1:8799 for ./run.sh mock)
# Reads RELAY_TOKEN from .env without printing it. Prints the JSON reply: {text, provider, latencyMs, fallbackFrom?}
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
P=${1:-auto}; F=${2:-test/stt-sample.wav}; U=${3:-http://127.0.0.1:${RELAY_PORT:-8787}}
Q=""; [ "$P" != auto ] && Q="?provider=$P"
curl -sS -m 200 -X POST -H "authorization: Bearer $RELAY_TOKEN" -H 'content-type: application/octet-stream' \
  --data-binary @"$F" "$U/stt$Q"; echo
