# GROK.md: self-hosting Grok Bot G2 for your user

These instructions are for a Grok Bot (or any AI agent with a shell) installing this project on **its own
computer** for **its user**, so the user can talk to their Grok Bots from Even Realities G2 glasses. They are
written to be followed literally, top to bottom, on a Linux box **without root and without apt** (a container
is fine). README.md has the background. Run the check after each step before moving on.

End state: a relay on this machine (`127.0.0.1:8787`) reachable at a stable `https://<host>.<tailnet>.ts.net`
URL through Tailscale Funnel, an `.ehpk` the user installed from Even Hub, and the phone paired with a one-time
code.

## Ground rules (always)

1. **Never print, echo, log or paste secrets.** That covers `CURSOR_API_KEY`, `ELEVENLABS_API_KEY`,
   `XAI_API_KEY`, `RELAY_TOKEN`, `BDK_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, the contents of `.env` and
   `data/secrets.json`. Read them from `.env` inside commands (`set -a; . ./.env; set +a`), redact output
   (`sed 's/=.*/=<redacted>/' .env`), and report only *where* a secret is stored. A 6-digit pairing code is not a
   secret once it is used, but it should still only go to the user.
2. **Ask for secrets through a secure secret request** (your platform's secret / credential prompt), never in
   plain chat. If the user pastes a secret into chat anyway, store it and tell them to rotate it later.
3. **The Cursor API key is relay-only.** It goes into `.env` (`CURSOR_API_KEY`) and nowhere else. The app has
   no field for it and the relay has no endpoint that reads or writes it; don't add one. STT keys (ElevenLabs,
   xAI) may be set either in `.env` or by the user in the app (**⚙ Settings → Voice**, write-only).
4. **Only kill processes you started.** Use `./run.sh stop|restart-relay|reload-relay|mock stop`, which only
   signal the process groups recorded in `run/*.pid`. Never `pkill node`, never `pkill -f` with a pattern that
   could match other agents' processes or your own shell, and never stop a Tailscale or cloudflared that you
   didn't start.
5. **Don't message bots by guesswork.** The Grok Bot backend addresses bots **by name** and silently
   **creates a new empty bot** for an unknown or misspelled name. Put only names the user confirmed, spelled
   exactly, in `bots.json`. Don't send test messages to the user's real bots unless they agree; label any you do
   send ("TEST from G2 relay setup, reply OK") and keep them to a minimum.
6. **Test with the mock first** (`./run.sh mock`). It exercises the relay, streaming, avatars, quick actions,
   STT settings and the app without contacting any bot.
7. Don't commit or upload `.env`, `bots.json`, `data/`, `qr/`, `logs/`, `tailscale/`, `.whisper-venv/` or
   `avatars-src/` anywhere (all git-ignored).
8. Things only the user can do: sign in to accounts (Tailscale, Even Hub, Cursor), approve Funnel in the tailnet
   admin, upload the `.ehpk`, install it on the phone, enter the pairing code, and test voice on real glasses.
   Prepare everything else, then give them short, exact instructions.

## What to ask the user for

| Item | How to get it | How you receive it |
|---|---|---|
| Cursor API key for the account that owns their Grok Bots | Cursor dashboard → API keys | secure secret request → `CURSOR_API_KEY` in `.env` |
| Exact names of the bots for the glasses (and the default one) | Grok Bot app, or agent `profile.json` files (step 3) | plain chat → `bots.json`, `DEFAULT_BOT` |
| STT: ElevenLabs key and/or xAI key, or OK to run Whisper locally | elevenlabs.io → API keys; console.x.ai → API keys | they can paste keys in the app later (**⚙ Settings → Voice**), or secure request → `.env` |
| Tailscale login (if this machine isn't on their tailnet) | you run `./run.sh ts-login`, it prints a login URL | send them the URL; wait until `ts-login` prints the relay URL |
| Funnel allowed for this node | Tailscale admin console (link printed by `./run.sh start` if missing) | they confirm |
| Their own package id (optional) | e.g. `com.theirname.grokbotg2` (lowercase letters, digits, dots) | `APP_PACKAGE_ID` in `.env` |
| Even Hub developer sign-in, `.ehpk` upload, install on phone | hub.evenrealities.com + Even Realities app | they do it; you give the steps (step 9) |

## Steps

### 1. Prerequisites

```bash
node -v                       # need >= 22.13
python3 -c "import PIL"       # Pillow, for avatars
curl --version | head -1
```

- **Node too old or missing, no root:** install Node 22 *next to* the system one and point `.env` at it:
  ```bash
  V=$(curl -s https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')
  mkdir -p .node && curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.gz" | tar -xz -C .node --strip-components=1
  .node/bin/node -v
  ```
  Then (after step 2 created `.env`) set `NODE_BIN_DIR=$PWD/.node/bin` in `.env`. Don't replace the system node.
- **Pillow missing:** `python3 -m pip install --user pillow` (or `uv pip install --system pillow` if pip is
  locked down).

### 2. Install

```bash
cp .env.example .env && chmod 600 .env
# if you installed Node into ./.node: echo "NODE_BIN_DIR=$PWD/.node/bin" >> .env
./run.sh setup
```

- Check: `ls relay/bdk/node_modules/@cursor/bdk app/node_modules/@evenrealities` succeeds.
- Check: `grep -c '^RELAY_TOKEN=.\+' .env` and `grep -c '^BDK_TOKEN=.\+' .env` both print `1` (values not shown).

### 3. Bots (`bots.json`) and avatars

`bots.json` is a JSON array of `{"name": "<exact bot name>", "id"?: "...", "avatarShape"?: "...", "avatarColor"?: "..."}`.
`./run.sh setup` created it from `bots.example.json` (example names: replace them).

- **If the bots are Grok Bot agents on this machine** (one folder per agent with `profile.json` and
  `avatar.*`, e.g. `/home/box/agent-data/agents/<id>/`), draft the file from their profiles. Names are copied
  byte-for-byte from `profile.json` `name`; `--only` keeps just the bots the user confirmed, in that order, and
  fails if a name doesn't match exactly:
  ```bash
  python3 tools/bots-from-agents.py /home/box/agent-data/agents                     # list what is there (stdout)
  python3 tools/bots-from-agents.py /home/box/agent-data/agents --only "Name A" "Name B" -o bots.json --force
  echo "AGENTS_DIR=/home/box/agent-data/agents" >> .env      # avatars.py then uses each agent's avatar.*
  ```
- **Otherwise** write the names by hand, exactly as the Grok Bot app shows them. For pictures, drop
  `avatars-src/<Name>.png|jpg|webp`; without one, the bot gets `avatarShape`/`avatarColor` or a monogram.
- Build the avatars (also done by `./run.sh build`):
  ```bash
  set -a; . ./.env; set +a; python3 tools/avatars.py
  ```
- Check: `ls data/avatars/` has `<Name>.png` and `<Name>.hud.png` for every bot.
- **Warning:** a misspelled or re-cased name makes the backend create a new, empty bot the first time you message
  it. Never "tidy up" names. Set `DEFAULT_BOT` in `.env` to one of the names (empty = first entry).

### 4. Configure `.env`

Set (via the secure secret request where noted):

- `CURSOR_API_KEY` (secret). Relay-only; see ground rule 3.
- `TUNNEL_MODE=tailscale-funnel` (the rest of this guide) or `cloudflare` / `none` (see README).
- `RELAY_PUBLIC_URL`: filled in at step 6 once you know the ts.net name.
- STT (optional now; the user can do it in the app): `STT_PROVIDER=elevenlabs|grok|whisper`,
  `ELEVENLABS_API_KEY`, `XAI_API_KEY` (secrets), `STT_FALLBACK=1`. See step 10.
- Optional: `APP_PACKAGE_ID=com.theirname.grokbotg2`.

Check without printing values: `grep -o '^[A-Z_]*=.' .env` lists the keys that have a value.

### 5. Mock test (no bots contacted)

```bash
./run.sh mock                    # mock bdk :3199 + relay :8799, example chats in test/mock-data/
BOT=$(python3 -c 'import json;print(json.load(open("test/mock-data/bots.json"))[0]["name"])')
tools/stream-test.sh "hello" "$BOT" http://127.0.0.1:8799
set -a; . ./.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/settings                                   # 401
curl -s -H "authorization: Bearer $RELAY_TOKEN" http://127.0.0.1:8799/settings | head -c 400; echo        # no key values
./run.sh mock stop
```

- Check: `message` events at about 4, 8 and 12 s, then `done` and `HTTP 200`.
- Check: `/settings` shows `provider`, `order` and per key only `set` / `source` / `last4`.

### 6. Tailscale Funnel (stable public HTTPS URL)

**a. Get the binaries.** If `tailscale version` works and a system `tailscaled` is running, use that and skip
to (c) with `TAILSCALE_BIN=tailscale` (add `TAILSCALE_SUDO=1` if the CLI needs `sudo -n`). Otherwise, and
always when `apt-get install tailscale` fails (no root, or the Debian mirror / pkgs repo is unreachable), use the
official static binaries. They need no root and no packages:

```bash
V=$(curl -s 'https://pkgs.tailscale.com/stable/?mode=json' | python3 -c 'import json,sys;print(json.load(sys.stdin)["TarballsVersion"])')
ARCH=amd64        # arm64 on ARM machines
mkdir -p tailscale/state
curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${V}_${ARCH}.tgz" | tar -xz -C tailscale --strip-components=1
./tailscale/tailscale version
```

**b. Tell `run.sh` to run its own userspace `tailscaled`** (no TUN device, no root). Add to `.env`:

```bash
cat >> .env <<EOF
TAILSCALE_BIN=$PWD/tailscale/tailscale
TAILSCALED_BIN=$PWD/tailscale/tailscaled
TAILSCALE_STATE_DIR=$PWD/tailscale/state
TAILSCALED_FLAGS=--tun=userspace-networking
TAILSCALE_HOSTNAME=grokbot-g2
EOF
```

`run.sh` then starts `tailscaled --state=$TAILSCALE_STATE_DIR/tailscaled.state --statedir=$TAILSCALE_STATE_DIR
--socket=$TAILSCALE_STATE_DIR/tailscaled.sock --tun=userspace-networking` (log: `logs/tailscaled.log`, pid:
`run/tailscaled.pid`) and talks to it via that socket. `--statedir` is required: without it Funnel can't store
its HTTPS certificate and the URL fails with a TLS error. Manual equivalent for any CLI call:
`./tailscale/tailscale --socket=tailscale/state/tailscaled.sock status`.

**c. Log in (user action).**

```bash
./run.sh ts-login
```

It starts `tailscaled` if needed, runs `tailscale up --hostname=$TAILSCALE_HOSTNAME` in the background and
prints a `https://login.tailscale.com/…` link (within ~10 s). Until the user signs in, `./run.sh status` shows
`tailscale: running, NOT logged in` and `./run.sh start` stops with a hint instead of starting anything. Send the link to the user; they sign in and approve the machine.
Run `./run.sh ts-login` again: once logged in it prints `Relay URL: https://<host>.<tailnet>.ts.net`.

- Find the hostname any time: `./tailscale/tailscale --socket=tailscale/state/tailscaled.sock status --json |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'`.
- Put it in `.env`: `RELAY_PUBLIC_URL=https://<host>.<tailnet>.ts.net` (no trailing slash).

**d. Funnel.** `./run.sh start` (step 8) runs `tailscale funnel --bg $RELAY_PORT` when Funnel isn't already
proxying to `127.0.0.1:$RELAY_PORT`. If the tailnet doesn't allow Funnel/HTTPS yet, the CLI prints an admin
link; `run.sh` shows it (and stops after 25 s instead of hanging; details in `logs/funnel.log`). The user opens
it, enables HTTPS certificates and Funnel for the node, then you rerun `./run.sh start`. Check with
`./run.sh status`: it shows `tailscale: up` and the `https://… proxy http://127.0.0.1:8787` line.

`./run.sh start` always brings up both `tailscaled` (if `TAILSCALED_BIN` is set) and Funnel, so after a reboot a
single `./run.sh start` is enough. `./run.sh stop` leaves Tailscale running; to stop the `tailscaled` that
`run.sh` started: `kill -- -$(cat run/tailscaled.pid)` (only that process group).

### 7. App manifest whitelist (`app/app.json`)

The Even app only lets the WebView `fetch()` hosts listed in `app/app.json` →
`permissions[name=network].whitelist`. It must contain **exactly** `RELAY_PUBLIC_URL` (same scheme and host, no
trailing slash, no path).

- `./run.sh build` injects it for you: it rewrites the whitelist to `[RELAY_PUBLIC_URL]`, sets `package_id`
  from `APP_PACKAGE_ID` (if set), writes `VITE_RELAY_URL` (the default relay URL shown in the app's Settings)
  to `app/.env.production`, builds `app/dist` and packs `app/grokbot-g2.ehpk`.
- Check after the build:
  `python3 -c 'import json;m=json.load(open("app/app.json"));print([p["whitelist"] for p in m["permissions"] if p["name"]=="network"])'`
  prints `[['https://<host>.<tailnet>.ts.net']]`.
- **If the URL ever changes** (new hostname, Cloudflare instead of Funnel…): update `RELAY_PUBLIC_URL`, bump
  `version` in `app/app.json`, `./run.sh build`, and the user must **re-upload and reinstall** the `.ehpk`. The
  old build keeps calling the old URL.

### 8. Build and start

```bash
./run.sh build
./run.sh start
./run.sh status
```

- Check: `local /health` and `public /health` both print `{"ok":true}`.
- Check: `curl -s -o /dev/null -w '%{http_code}\n' "$RELAY_PUBLIC_URL/conversations"` prints `401`.
- Check (token not printed): `set -a; . ./.env; set +a; curl -s "$RELAY_PUBLIC_URL/conversations" -H "authorization: Bearer $RELAY_TOKEN" | head -c 300`
  lists the bots from `bots.json`.

### 9. Even Hub: upload and install (user actions, you guide)

1. **Developer account.** The user signs in at https://hub.evenrealities.com/login with the **same account**
   as the Even Realities phone app, then force-quits and reopens the phone app. That enables Developer Mode (a
   developer section appears top-right in the Even Hub tab). There is no toggle.
2. **Project / package id.** In the portal they create a project for the package id in `app/app.json`
   (`package_id`, from `APP_PACKAGE_ID`). It must be globally unique, lowercase letters/digits and dots only,
   and is permanent once released. If the upload says the id is taken, pick another, set `APP_PACKAGE_ID`,
   `./run.sh build`. (`cd app && npx evenhub pack app.json dist -o /tmp/check.ehpk -c` checks availability
   up front, but only after `npx evenhub login` with the user's Even Hub account; without it, it prints
   `Not authenticated`. Let the user type their own credentials, or skip the check.)
3. **Give them the file:** `app/grokbot-g2.ehpk` (copy it to their computer or tell them the path).
4. **Choose how to install:**

   | Mode | Portal | Phone | Survives a locked phone? |
   |---|---|---|---|
   | **Beta build** (recommended for daily use) | **Beta groups** → create `self-test` with their own email → **Builds** → upload the `.ehpk` → push it to `self-test` | Even Realities app → Even Hub → **Me → Beta tester** → Install | Yes (same lifecycle as a released app) |
   | Private build | project → **Private builds** → upload | **Me → Apps → Private builds** → Install | Only briefly (Even's docs: fails their 5-minute lock test) |
   | QR sideload (dev only) | none | Even Hub developer section → **Scan QR** → `qr/qr-app.png` (the relay serves `app/dist` at `/app/`) | No: it stops as soon as the phone locks or the WebView backgrounds |

   Portal and menu names follow Even's docs at the time of writing (hub.evenrealities.com/docs → Test →
   Private Testing / Beta Testing); if they changed, follow the current docs.
5. **First launch.** On the glasses or phone, open *Grok Bot G2*. The phone screen shows the **Settings** screen
   (opened automatically when not paired; later via the **⚙** button on the conversation list): **Relay URL** is prefilled with `RELAY_PUBLIC_URL`; run `./run.sh pair`, send
   the user the 6-digit code (valid 10 min, single use); they type it into **Pairing code** and tap **Save &
   reconnect**. Check: `logs/relay.log` shows `pair ok`, then authed requests and no `auth fail`.
6. For every later app change: bump `version` in `app/app.json`, `./run.sh build`, re-upload, reinstall.
   Relay-only changes need just `./run.sh reload-relay` (no re-upload, no re-pairing).

### 10. Speech-to-text

Providers (one setting picks; fallback tries the others that are configured, elevenlabs → grok → whisper):

| `STT_PROVIDER` / app picker | Needs | Notes |
|---|---|---|
| `elevenlabs` (default) | ElevenLabs key | Most accurate in our tests, ~0.5–1 s |
| `grok` | xAI key | xAI REST `POST https://api.x.ai/v1/stt` (multipart, `file` last), fastest ~0.2–0.5 s |
| `whisper` | `./run.sh whisper` | Local, free, audio never leaves the machine; slow on a busy CPU |

- **Whisper (no compiler, no root):** `./run.sh whisper` creates `./.whisper-venv` (with `uv` if installed,
  else `python3 -m venv`), installs `faster-whisper` and downloads the `base` model to `data/whisper-models`
  (~600 MB disk total). Check: it ends with `whisper ready`. Then `./run.sh reload-relay`.
- **Keys:** either in `.env` (`ELEVENLABS_API_KEY`, `XAI_API_KEY`, then `./run.sh reload-relay`) or the user
  pastes them in the app: phone → **⚙ Settings → Voice** (visible once paired) → password field → **Save voice
  settings**. The relay checks the key with the provider first (ElevenLabs `GET /v1/user`, xAI `GET /v1/models`)
  and refuses a rejected key. Saved keys show as `Saved ✓ ···last4` with **Replace** / **Clear**; their values
  are never shown again, never logged and never sent to the glasses. They are stored in `data/secrets.json`
  (mode 600) and override `.env`.
- **Test a provider without bots:**
  ```bash
  tools/stt-test.sh elevenlabs        # or grok | whisper | auto; add a file and a URL to test the mock:
  tools/stt-test.sh grok test/stt-sample.wav http://127.0.0.1:8799
  ```
  Expect `{"text":"Hello from the G2 glasses. What is two plus two? …","provider":"…","latencyMs":…}`.
- **Audio format:** the glasses send raw 16 kHz s16le mono PCM; the relay wraps it in a WAV header for every
  provider, so nothing to configure.

### 11. Live checks against real bots (only with the user's OK)

- **You can't test against yourself.** While you (the setting-up bot) are working on this task, your own turn
  is running, so a message to *your* name returns `409 … still working on an earlier message` and nothing is
  sent. Test against a different bot the user names, or use the mock.
- One clearly labelled message: `tools/stream-test.sh "TEST from G2 relay setup, please reply OK" <ExactBotName>`.
  A `409` means that bot is busy; don't retry in a loop.

## Testing in the simulator (Linux, headless)

Needs `xvfb-run` and, for pairing, `xdotool`. The simulator binary comes with the app's dev dependencies
(`app/node_modules/@evenrealities/sim-linux-x64`, installed by `./run.sh setup`).

```bash
./run.sh mock                     # the simulator talks to the mock relay, never to real bots
(cd app && npm run build)         # the mock relay serves app/dist at /app/
tools/sim.sh start                # simulator on display :99, automation API on :9898, opens http://127.0.0.1:8799/app/
tools/sim-pair.sh                 # writes a pairing code for the mock and types it into the phone UI
curl -s localhost:9898/api/screenshot/webview -o /tmp/phone.png                      # phone screen
curl -s localhost:9898/api/screenshot/glasses -o /tmp/hud.png && python3 tools/hudview.py /tmp/hud.png   # -> /tmp/hud_view.png
curl -s -X POST localhost:9898/api/input -H 'content-type: application/json' -d '{"action":"down"}'   # up|down|click|double_click
tools/sim.sh stop; ./run.sh mock stop
```

- Glasses screenshots keep brightness in the alpha channel; `tools/hudview.py` writes a viewable `_view.png`.
- `tools/sim.sh start` opens `http://127.0.0.1:8799/app/#relay=http://127.0.0.1:8799`; the `#relay=` part makes
  the app use the mock relay even if `./run.sh build` baked your real relay URL into `app/.env.production`.
- Add `?debug` to log every HUD update to the console (`GET localhost:9898/api/console?since_id=0`):
  `tools/sim.sh start 'http://127.0.0.1:8799/app/?debug#relay=http://127.0.0.1:8799'`.
- In the mock, a message containing "long" returns one ~3000-character reply (pagination test); others get a
  3-message reply over 12 s.

Known simulator limits:

- **The microphone doesn't start** ("Could not start the microphone"), so voice can't be tested there; test
  STT with `tools/stt-test.sh` and voice on real glasses.
- **Swipes and taps only arrive through the event-capture container.** The app declares a blank full-screen
  container with `isEventCapture=1` first on every page; if you change layouts, keep exactly one, or
  `/api/input` up/down/click do nothing.
- Text containers take at most 999 bytes in the simulator (1000 chars on hardware create/rebuild).
- A JavaScript `confirm()` (e.g. *Clear* key, *Delete* action) blocks the WebView and screenshots until you press
  Return: `DISPLAY=:99 XAUTHORITY=$(pgrep -a -x Xvfb | grep ' :99 ' | grep -o '/tmp/xvfb-run[^ ]*') xdotool key Return`.
- Native `<select>` popups don't appear in webview screenshots; pick options with the arrow keys.
- `tools/sim-pair.sh` clicks fixed coordinates of the default 600×800 phone window (an unpaired app opens on the
  Settings screen: *Pairing code* at webview y≈193, *Save & reconnect* at y≈316); if you change the Settings
  layout, update them.
- The token is not kept across simulator restarts; run `tools/sim-pair.sh` again.

### Phone UI test (WebKit + Chromium, keyboard simulated)

The simulator is one fixed 600×800 Chromium window and cannot show an iPhone keyboard. For layout work on the
phone screen use `tools/phone-test.sh` (mock stack running): it bundles `app/test/phone-harness.ts` (mounts
`ui.ts` + `api.ts` without the Even bridge), serves it on a free loopback port and runs `app/test/phone-ui.e2e.cjs`
in Playwright WebKit and Chromium at 390×844 and 375×667. The keyboard is simulated by halving the viewport; the
test checks that *+ Add action* puts the new editor first with its label focused and visible, that Save, the
message field, the voice key fields and the chat composer stay visible with the keyboard up, that Settings is its
own screen, that there are no JS errors, and that `?debug` shows an uncaught error as an on-screen banner.
Expect `N/N passed`; screenshots go to `test/sim/phone_*.png`.

- It only runs against the mock relay (loopback URL and the bot names of `test/mock-data/bots.json`); it ignores
  `RELAY_TOKEN`/`RELAY_PORT` from your shell on purpose. Overrides: `PHONE_TEST_RELAY`, `PHONE_TEST_TOKEN`.
- Playwright is installed once into `run/phone-test/` (git-ignored, `PLAYWRIGHT_VERSION`, default 1.63.0).
  On a Linux host without root that lacks WebKit's system libraries, headless WebKit (WPE) usually only misses
  `libevent-2.1`: `apt-get download libevent-2.1-7t64 && dpkg-deb -x libevent*.deb x`, copy
  `x/usr/lib/x86_64-linux-gnu/libevent-2.1.so.7*` into `~/.cache/ms-playwright/webkit-*/minibrowser-wpe/sys/lib/`
  and run with `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`; or `ENGINES=chromium tools/phone-test.sh`.
- Real iOS differs from this simulation: the WKWebView keyboard shrinks only `visualViewport`, not the layout
  viewport. The app handles both (`#app` is fixed to `visualViewport.height`/`offsetTop`, focused fields are
  scrolled to the centre), but confirm layout changes on a phone.
- On the phone, uncaught errors appear as a red banner when the app URL has `?debug` or the user ticks
  **Settings → Show app errors on screen (debug)**.

## Day-2 operations

- After a relay code or `bots.json` change: `./run.sh reload-relay` (relay only) or `./run.sh restart-relay`
  (relay + bdk). The URL stays the same, no re-pairing.
- App changes: bump `version` in `app/app.json`, `./run.sh build`, ask the user to re-upload and reinstall.
- New phone or lost token: `./run.sh pair`. To revoke all phones, put a new random `RELAY_TOKEN` in `.env`,
  `./run.sh restart-relay`, then re-pair.
- Rotate the Cursor key: edit `CURSOR_API_KEY` in `.env`, `./run.sh restart-relay`.
- After a reboot: `./run.sh start`. If the host has systemd or cron, offer an `@reboot` entry, but ask first.
- Logs: `logs/relay.log` (incl. `settings …` audit lines without values), `logs/bdk.log`, `logs/tailscaled.log`.
- Health any time: `./run.sh status`.

## Using it (tell the user)

- Glasses: tap a conversation to **read** it (history first, starting at the first unread message). Swipe ▲▼ to
  page through messages; **tap** to talk (tap again to send), **double-tap** to go back (or cancel while
  listening), **hold** for push-to-talk. The footer always shows the gestures. `↓ n new` means messages arrived
  below where you are reading.
- Quick actions: phone → **⚡ Quick actions** to add/edit/reorder/delete (label ≤ 24, message ≤ 2000, ≤ 50
  actions); glasses → conversation list → **Quick actions** → tap one to send it. Stored in `data/actions.json`.
  Never fire a quick action yourself against real bots while testing; use the mock.
- Voice settings: phone → **⚙** (conversation list) → **Settings → Voice**: provider, fallback switch, ElevenLabs and xAI keys
  (write-only). The Cursor key is not there by design.

## Final acceptance checklist

Run these and report each result to the user:

| # | Check | How | Expected |
|---|---|---|---|
| 1 | Public health | `curl -s -o /dev/null -w '%{http_code}\n' "$RELAY_PUBLIC_URL/health"` | `200` |
| 2 | Auth enforced | `curl -s -o /dev/null -w '%{http_code}\n' "$RELAY_PUBLIC_URL/conversations"` (and `/settings`) | `401` |
| 3 | Mock stream | step 5 (`./run.sh mock` + `tools/stream-test.sh … http://127.0.0.1:8799`) | 3 `message` events, `done`, `HTTP 200` |
| 4 | STT | `tools/stt-test.sh auto` | transcript of `test/stt-sample.wav` |
| 5 | Pairing | user enters the code from `./run.sh pair` | `pair ok` in `logs/relay.log`, phone says *Paired ✓* |
| 6 | Glasses list | user opens the app on the glasses | conversation list with avatars renders |
| 7 | Long message | user (or simulator + mock) opens a long reply | header `p 1/N`, swipes reach the last page, nothing cut off |
| 8 | Quick action | phone → ⚡ → *+ Add action* (new editor opens at the top, label focused) → add one for a bot the user picks; glasses → Quick actions → tap (mock in the simulator first) | reply streams into that bot's read view (409 = bot busy, nothing sent) |
| 9 | Voice | user: read view → tap, speak, tap | transcript is sent and the reply appears |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `public /health` unreachable, local OK | Tunnel down: `./run.sh status`; `logs/tailscaled.log`, `logs/funnel.log` (or `logs/cloudflared.log`) |
| TLS error on the `ts.net` URL | tailscaled has no state dir for certs: it must run with `--statedir` (`TAILSCALE_STATE_DIR`) |
| `Tailscale is not logged in` | `./run.sh ts-login`, send the link to the user |
| `Could not enable Funnel` | the tailnet admin must enable HTTPS + Funnel for the node (link in the message / `logs/funnel.log`) |
| `apt-get install tailscale` fails | use the static binaries (step 6a); no root needed |
| App says NOT PAIRED / 401 | Pair again; the app's Relay URL must equal `RELAY_PUBLIC_URL` |
| Phone: a field or the new quick action is hidden behind the keyboard, or a button does nothing | Ask the user to tick **⚙ Settings → Show app errors on screen (debug)** and report the red banner; reproduce with `tools/phone-test.sh` |
| App can't reach the relay at all | Whitelist mismatch: rebuild after changing `RELAY_PUBLIC_URL`, re-upload (step 7) |
| `409 … still working on an earlier message` | That bot is busy (or it's you, step 11); nothing was sent |
| `bdk did not come up` | `logs/bdk.log`; usually a missing/invalid `CURSOR_API_KEY` or Node < 22.13 |
| HUD text cut off / scrollbar on a page | Shouldn't happen since v0.4.0; report the message text (`app/src/paginate.ts` `HUD_LAYOUT`) |
| Quick action save fails with 400 | The message says which: label > 24, message > 2000, > 50 actions, or a bot not in `bots.json` |
| STT 503 `no … key` / `faster-whisper not installed` | Set the key (app or `.env`) or run `./run.sh whisper`; fallback skips unconfigured providers |
| Voice settings: *key rejected ✗* | The provider said 401/400 for that key; nothing was saved. Check for a truncated paste |
| Voice settings: 429 | More than 10 changes in 10 minutes from that IP; wait |
| Whisper returns empty text | Use `WHISPER_COMPUTE=float32` (default); `int8` failed on some CPUs |
| A new empty bot appeared in Grok Bot | A misspelled name in `bots.json`: fix it, `./run.sh reload-relay`, and tell the user so they can delete the extra bot |
