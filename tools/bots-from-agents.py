#!/usr/bin/env python3
"""Draft bots.json from a folder of per-agent directories (<AGENTS_DIR>/<id>/profile.json [+ avatar.*]).

    python3 tools/bots-from-agents.py /path/to/agents            # prints a draft to stdout
    python3 tools/bots-from-agents.py /path/to/agents -o bots.json --only "Name A" "Name B"

Each entry is {"name", "id", "avatarShape"?, "avatarColor"?} with the name copied byte-for-byte from profile.json.
The Grok Bot backend addresses bots BY NAME and silently creates a new empty bot for an unknown or misspelled
name, so: keep only the bots your user confirmed (--only), never retype or "fix" a name, and review the file.
Then run tools/avatars.py with AGENTS_DIR set to the same folder to use each agent's avatar.* picture.
Reads only profile.json and checks that avatar.* exists; nothing else in the agent folders is opened.
"""
import argparse, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument("agents_dir")
ap.add_argument("-o", "--out", help="write here instead of stdout (refuses to overwrite unless --force)")
ap.add_argument("--only", nargs="*", help="exact names to keep (case-sensitive), in this order")
ap.add_argument("--force", action="store_true")
a = ap.parse_args()

found = []
for d in sorted(os.listdir(a.agents_dir)):
    p = os.path.join(a.agents_dir, d, "profile.json")
    if not os.path.isfile(p):
        continue
    try:
        prof = json.load(open(p))
    except Exception as e:
        print(f"skip {d}: unreadable profile.json ({e})", file=sys.stderr); continue
    name = prof.get("name")
    if not isinstance(name, str) or not name.strip():
        print(f"skip {d}: no name in profile.json", file=sys.stderr); continue
    e = {"name": name, "id": d}
    for k in ("avatarShape", "avatarColor"):
        if prof.get(k): e[k] = prof[k]
    has_av = any(os.path.isfile(os.path.join(a.agents_dir, d, f"avatar.{x}")) for x in ("png", "jpg", "jpeg", "webp"))
    found.append((e, has_av))

names = [e["name"] for e, _ in found]
dups = {n for n in names if names.count(n) > 1}
if dups:
    print(f"WARNING: duplicate names {sorted(dups)}: the backend cannot tell them apart; keep only one", file=sys.stderr)
if a.only is not None:
    by = {e["name"]: e for e, _ in found}
    missing = [n for n in a.only if n not in by]
    if missing:
        sys.exit(f"not found (names must match profile.json exactly): {missing}\navailable: {sorted(by)}")
    out = [by[n] for n in a.only]
else:
    out = [e for e, _ in found]
for e, has_av in found:
    if e in out:
        print(f"  {e['name']!r:32} id={e['id']}  avatar.*: {'yes' if has_av else 'no (shape/monogram)'}", file=sys.stderr)
text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
if a.out:
    if os.path.exists(a.out) and not a.force:
        sys.exit(f"{a.out} exists; use --force to overwrite")
    open(a.out, "w").write(text)
    print(f"wrote {len(out)} bots to {a.out}; review the names with your user before ./run.sh restart-relay", file=sys.stderr)
else:
    sys.stdout.write(text)
