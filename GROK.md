# GROK.md: self-hosting Grok Bot G2 for your user

These instructions are for a Grok Bot (or any AI agent with a shell) installing this project on **its own
computer** for **its user**, so the user can talk to their Grok Bots from Even Realities G2 glasses. Read
README.md for background. Follow the steps in order and run the verification check after each one.

## Ground rules (always)

1. **Never print, echo, log or paste secrets.** That covers `CURSOR_API_KEY`, `ELEVENLABS_API_KEY`,
   `RELAY_TOKEN`, `BDK_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN` and the contents of `.env`. Read them from `.env`
   inside commands (`set -a; . ./.env; set +a`), redact output (`sed 's/=.*/=<redacted>/' .env`), and report only
   *where* a secret is stored. A 6-digit pairing code is not a secret once it is used, but it should still only
   go to the user.
2. **Ask for secrets through a secure secret request** (your platform's secret / credential prompt), never in
   plain chat. If the user pastes a secret into chat anyway, store it in `.env` and tell them to rotate it later.
3. **Only kill processes you started.** Use `./run.sh stop|restart-relay`, which only signals the process
   groups in `run/*.pid`. Never `pkill node`, never `pkill -f` with a pattern that could match other agents'
   processes or your own shell, and never stop the user's Tailscale or cloudflared services.
4. **Don't message bots by guesswork.** The Grok Bot backend addresses bots **by name** and silently
   **creates a new empty bot** for an unknown or misspelled name. Put only names the user confirmed, spelled
   exactly, in `bots.json`. Don't send test messages to the user's real bots unless they agree; label any you do
   send (e.g. "TEST from G2 relay setup, reply OK") and keep them to a minimum.
5. **Test with the mock first** (`./run.sh mock`). It exercises the relay, streaming, avatars and the app without
   contacting any bot.
6. Don't commit or upload `.env`, `bots.json`, `data/`, `qr/`, `logs/` or `avatars-src/` anywhere.
7. Things only the user can do: sign in to accounts, approve the Tailscale/Cloudflare login, upload the `.ehpk`
   in Even Hub, install it on their phone, and enter the pairing code. Prepare everything else, then give them
   short, exact instructions.

## What to ask the user for

| Item | How to get it | How you receive it |
|---|---|---|
| Cursor API key for the account that owns their Grok Bots | Cursor dashboard → API keys | secure secret request → `CURSOR_API_KEY` in `.env` |
| Exact names of the bots they want on the glasses (and which one is default) | They read them off the Grok Bot app | plain chat is fine → `bots.json`, `DEFAULT_BOT` |
| STT choice: ElevenLabs key **or** OK to run whisper.cpp locally | elevenlabs.io → API keys | secure secret request → `ELEVENLABS_API_KEY` |
| Tunnel choice: Tailscale Funnel (default) or a Cloudflare named tunnel + domain | | plain chat |
| Tailscale login (if not already on a tailnet) | you run `tailscale up`, which prints a login URL | send them the URL to open; wait until `tailscale status` works |
| Funnel permission in their tailnet policy | Tailscale admin → Access controls / Funnel | they confirm |
| Cloudflare tunnel token (if Cloudflare) | Zero Trust → Networks → Tunnels → create → public hostname → `http://127.0.0.1:8787` | secure secret request → `CLOUDFLARE_TUNNEL_TOKEN` |
| Optional: their own package id (e.g. `com.theirname.grokbotg2`) and avatar pictures | | `APP_PACKAGE_ID`, `avatars-src/<Name>.png` |
| Even Hub developer sign-in, `.ehpk` upload, install on phone | hub.evenrealities.com + Even Realities app | they do it; you give the steps |

## Steps

1. **Prerequisites.** Check with `node -v` (need ≥ 22.13), `python3 -c "import PIL"`, `curl --version`.
   - If the system node is older, install Node 22 *alongside* it (for example, unpack the official tarball into
     `./.node`) and set `NODE_BIN_DIR=$PWD/.node/bin` in `.env`. Don't replace the system node; other tools may
     depend on it.
   - If Pillow is missing: `python3 -m pip install --user pillow`.
2. **Install.**
   ```bash
   cp .env.example .env && chmod 600 .env
   ./run.sh setup
   ```
   - Check: `relay/bdk/node_modules/@cursor/bdk` and `app/node_modules` exist.
   - Check: `.env` has non-empty `RELAY_TOKEN`/`BDK_TOKEN`. Verify with
     `grep -c '^RELAY_TOKEN=.\+' .env`, without printing the value.
3. **Configure.** Write the confirmed bot names into `bots.json` and the secrets into `.env` (via the secure
   request). Set `STT_PROVIDER`, `TUNNEL_MODE` and `RELAY_PUBLIC_URL`.
   - For whisper: build https://github.com/ggml-org/whisper.cpp (`cmake -B build && cmake --build build -j`),
     download a model (`models/download-ggml-model.sh base`), and set `WHISPER_BIN` / `WHISPER_MODEL`.
4. **Mock test (no bots contacted).**
   ```bash
   ./run.sh mock
   tools/stream-test.sh "hello" "$(python3 -c 'import json;print(json.load(open("test/mock-data/bots.json"))[0]["name"])')" http://127.0.0.1:8799
   ./run.sh mock stop
   ```
   - Check: you see `message` events at about 4, 8 and 12 s, then `done`.
5. **Tunnel.**
   - Tailscale: `tailscale status`. If logged out, run `tailscale up` and give the user the login URL.
     `RELAY_PUBLIC_URL` is `https://<this-machine>.<tailnet>.ts.net` (see `tailscale status --json`, `Self.DNSName`).
   - Cloudflare: the user creates the tunnel and public hostname; you only store the token.
6. **Build and start.**
   ```bash
   ./run.sh build
   ./run.sh start
   ./run.sh status
   ```
   - Check: both `local /health` and `public /health` print `{"ok":true}`.
   - Check: `curl -s -o /dev/null -w '%{http_code}\n' "$RELAY_PUBLIC_URL/conversations"` prints `401` (auth works).
   - Check: an authed request lists the bots without printing the token:
     `set -a; . ./.env; set +a; curl -s "$RELAY_PUBLIC_URL/conversations" -H "authorization: Bearer $RELAY_TOKEN" | head -c 300`
7. **Optional live check (only with the user's OK).** Send one clearly labelled test to a bot they name:
   `tools/stream-test.sh "TEST from G2 relay setup, please reply OK" <ExactBotName>`.
   A `409` means the bot is busy with another turn and nothing was sent; try later, don't retry in a loop.
8. **Hand over to the user:**
   - The file to upload: `app/grokbot-g2.ehpk` (copy it to their machine, or tell them where it is).
   - Upload steps: hub.evenrealities.com → their app → **Private builds** (or a **Beta group** for lock-screen
     robustness) → upload. Then on the phone: Even Realities app → Even Hub → **Me → Apps → Private builds** (or
     **Beta tester**) → Install.
   - Pairing: run `./run.sh pair` and send them the 6-digit code (valid 10 min, single use). On the phone screen
     they open **Settings → Pairing code → Save & reconnect**.
   - Check: `logs/relay.log` shows `pair ok` and then authed requests (no `auth fail`).

## Day-2 operations

- Restart after a relay or bots.json change: `./run.sh restart-relay` (the URL stays the same, no re-pairing).
- App changes: bump `version` in `app/app.json`, `./run.sh build`, and ask the user to re-upload and reinstall.
- New phone or lost token: `./run.sh pair`. To revoke all phones, put a new random `RELAY_TOKEN` in `.env`,
  run `./run.sh restart-relay`, then re-pair.
- After a reboot: `./run.sh start`. If the host has systemd or cron, offer to add an `@reboot` entry that runs
  it, but ask first.
- Logs: `logs/relay.log`, `logs/bdk.log`. Rotate or truncate them if they grow; they contain no secrets but do
  contain bot names and timings.
- Health check you can run any time: `./run.sh status`.

## Using it (tell the user)

- Glasses: tap a conversation to **read** it (history first, starting at the first unread message). Swipe ▲▼ to
  page through messages; **tap** to talk (tap again to send), **double-tap** to go back (or cancel while
  listening), **hold** for push-to-talk. The footer always shows the gestures. `↓ n new` means messages arrived
  below where you are reading.
- Quick actions: phone → **⚡ Quick actions** to add/edit/reorder/delete (label ≤ 24, message ≤ 2000, ≤ 50
  actions); glasses → conversation list → **Quick actions** → tap one to send it. Stored in `data/actions.json`
  (seeded from `actions.example.json` on first run). Never fire a quick action yourself against real bots while
  testing; use `./run.sh mock`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `public /health` unreachable, local OK | Tunnel down: `tailscale funnel status`, or `logs/cloudflared.log` |
| TLS error on the `ts.net` URL | tailscaled has no state dir for certs: run it with `--statedir` (`TAILSCALE_STATE_DIR`) |
| App says NOT PAIRED / 401 | Pair again; check that the app's relay URL matches `RELAY_PUBLIC_URL` (Settings) |
| `409 … still working on an earlier message` | Bot busy (maybe in the desktop app); nothing was sent |
| `bdk did not come up` | `logs/bdk.log`; usually a missing/invalid `CURSOR_API_KEY` or Node < 22.13 |
| HUD text cut off / scrollbar on a page | Should not happen since v0.4.0 (measured-width pagination); report the message text. `app/src/paginate.ts` `HUD_LAYOUT` holds the margins |
| Quick action save fails with 400 | The message says which action: label > 24, message > 2000, > 50 actions, or a bot not in `bots.json` |
| STT 503 | `STT_PROVIDER` / key / `WHISPER_MODEL` path not set |
| A new empty bot appeared in Grok Bot | A misspelled name in `bots.json`: fix the name, `./run.sh restart-relay`, and tell the user so they can delete the extra bot |
