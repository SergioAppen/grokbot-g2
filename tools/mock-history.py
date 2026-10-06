#!/usr/bin/env python3
"""Write generic example conversations (timestamps relative to now) for the mock stack / screenshots.
Usage: tools/mock-history.py <history-dir>"""
import json, os, sys, time
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
now = int(time.time() * 1000); m = 60_000
data = {
    "Assistant": [("user", "What's on my calendar today?", -9 * m),
                  ("bot", "Two meetings: 10:00 design review and 15:30 team sync.", -8 * m)],
    "Finance":   [("user", "How much did I spend this week?", -3 * 60 * m),
                  ("bot", "About 410 so far, mostly groceries and transport.", -170 * m)],
    "Writer":    [("bot", "The draft blog post is ready for your review.", -26 * 60 * m)],
    "Planner":   [("user", "Move the Friday review to Monday", -50 * 60 * m)],
    "Research":  [("bot", "Summary of the three papers is saved to your notes.", -4 * 24 * 60 * m)],
}
for name, msgs in data.items():
    with open(os.path.join(out, f"{name}.json"), "w") as f:
        json.dump([{"role": r, "text": t, "at": now + d} for r, t, d in msgs], f)
print(f"wrote {len(data)} example conversations to {out}")
