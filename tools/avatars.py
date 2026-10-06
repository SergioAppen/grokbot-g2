#!/usr/bin/env python3
"""Build small avatars for every bot in bots.json -> data/avatars/<name>.png (96px colour, phone)
and <name>.hud.png (40px 4-bit greyscale, Floyd-Steinberg dithered, for the G2 HUD).

Source, per bot, first match wins:
  1. avatars-src/<name>.(png|jpg|jpeg|webp)      — an image you drop in yourself (AVATAR_SRC_DIR to change)
  2. $AGENTS_DIR/<id>/avatar.(png|jpg|jpeg|webp)  — optional: a per-agent data folder that holds the bot's avatar
     and a profile.json (only avatar.* and profile.json are read). Set AGENTS_DIR only if you have such a folder.
  3. avatarShape + avatarColor from bots.json (or that profile.json) — a simple coloured shape with the initial
     (shapes: blob, tablet, cloud, pebble, wedge, teardrop, hex, squircle; colours: see COLORS)
  4. a monogram.
With AGENTS_DIR, the agent folder is matched by id, falling back to profile.json "name".
"""
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS = os.environ.get("AGENTS_DIR", "")
SRC = os.environ.get("AVATAR_SRC_DIR", os.path.join(ROOT, "avatars-src"))
OUT = os.environ.get("AVATAR_DIR", os.path.join(os.environ.get("DATA_DIR", os.path.join(ROOT, "data")), "avatars"))
os.makedirs(OUT, exist_ok=True)
COLORS = {"red": "#ef4444", "orange": "#f97316", "yellow": "#eab308", "green": "#22c55e", "cyan": "#06b6d4",
          "blue": "#3b82f6", "violet": "#8b5cf6", "magenta": "#d946ef", "brown": "#a16207", "": "#64748b"}
FONT = next((f for f in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                         "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"] if os.path.exists(f)), None)

def profiles():
    out = {}
    if not AGENTS or not os.path.isdir(AGENTS): return out
    for d in os.listdir(AGENTS):
        p = os.path.join(AGENTS, d, "profile.json")
        if os.path.isfile(p):
            try: out[d] = json.load(open(p))
            except Exception: pass
    return out

def shape_poly(shape, s):
    c = s / 2; r = s * 0.40
    pts = lambda n, rot=0, rr=r: [(c + rr * math.cos(rot + 2 * math.pi * i / n), c + rr * math.sin(rot + 2 * math.pi * i / n)) for i in range(n)]
    if shape == "hex": return pts(6, math.pi / 6)
    if shape == "wedge": return [(c - r, c + r * .8), (c + r, c + r * .8), (c, c - r)]
    if shape == "teardrop":
        return [(c + r * math.sin(t) * (1 - math.cos(t)) * .75 * 1.3, c + r * -math.cos(t) * 1.0) for t in [i * 2 * math.pi / 60 for i in range(60)]]
    if shape == "blob":
        return [(c + r * (1 + .12 * math.sin(3 * t)) * math.cos(t), c + r * (1 + .12 * math.sin(3 * t)) * math.sin(t)) for t in [i * 2 * math.pi / 90 for i in range(90)]]
    if shape == "cloud": return None
    return None

def draw_shape(shape, color, name, s=192, mono=False):
    # mono=True: HUD version (black background, lit shape, dark letter) since the G2 only shows brightness
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.ellipse([0, 0, s - 1, s - 1], fill="#000" if mono else "#1f2937")
    col = "#fff" if mono else COLORS.get(color, COLORS[""]); c = s / 2; r = s * .40
    poly = shape_poly(shape, s)
    if poly: d.polygon(poly, fill=col)
    elif shape == "cloud":
        for (dx, dy, rr) in [(-.18, .05, .22), (.18, .05, .22), (0, -.1, .27), (0, .12, .2)]:
            d.ellipse([c + dx * s - rr * s, c + dy * s - rr * s, c + dx * s + rr * s, c + dy * s + rr * s], fill=col)
    elif shape == "tablet": d.rounded_rectangle([c - r * .7, c - r, c + r * .7, c + r], radius=s * .08, fill=col)
    elif shape == "squircle": d.rounded_rectangle([c - r, c - r, c + r, c + r], radius=s * .16, fill=col)
    elif shape == "pebble": d.ellipse([c - r, c - r * .75, c + r, c + r * .75], fill=col)
    else: d.ellipse([c - r, c - r, c + r, c + r], fill=col)  # unknown / no shape -> disc
    letter = next((ch for ch in name if ch.isalpha()), "?").upper()
    font = ImageFont.truetype(FONT, int(s * .42)) if FONT else ImageFont.load_default()
    if mono: d.text((c, c), letter, fill="#000", font=font, anchor="mm")
    else: d.text((c, c), letter, fill="white", font=font, anchor="mm", stroke_width=max(1, s // 64), stroke_fill="#111")
    return im

def from_image(path, s=192):
    im = Image.open(path); im = ImageOps.exif_transpose(im).convert("RGBA")
    w, h = im.size; side = min(w, h)
    # centre crop; landscape art (1280x720) keeps its middle, portrait keeps the upper part (faces)
    left = (w - side) // 2; top = 0 if h > w else (h - side) // 2
    return im.crop((left, top, left + side, top + side)).resize((s, s), Image.LANCZOS)

def circle(im):
    s = im.size[0]; m = Image.new("L", (s * 4, s * 4), 0); ImageDraw.Draw(m).ellipse([0, 0, s * 4 - 1, s * 4 - 1], fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m.resize(im.size, Image.LANCZOS)); return out

def hud(im, s=40):
    # Flatten on black (black = off on the G2), boost contrast, quantise to 16 grey levels with dithering.
    bg = Image.new("RGBA", im.size, (0, 0, 0, 255)); bg.alpha_composite(circle(im))
    g = bg.convert("L").resize((s, s), Image.LANCZOS)
    # Lit pixels glow on the G2; a mostly-white picture (e.g. a screenshot) becomes a solid blob, so invert it.
    inside = [g.getpixel((x, y)) for x in range(s) for y in range(s) if (x - s / 2 + .5) ** 2 + (y - s / 2 + .5) ** 2 < (s / 2 - 1) ** 2]
    if sum(inside) / len(inside) > 150:
        g = ImageOps.invert(g); ImageDraw.Draw(g).ellipse([0, 0, s - 1, s - 1], outline=0)
        m = Image.new("L", (s, s), 0); ImageDraw.Draw(m).ellipse([0, 0, s - 1, s - 1], fill=255); g = Image.composite(g, Image.new("L", (s, s), 0), m)
    g = ImageOps.autocontrast(g, cutoff=2)
    pal = Image.new("P", (1, 1)); pal.putpalette(sum([[i * 17] * 3 for i in range(16)], []) + [0] * (256 - 16) * 3)
    return g.convert("RGB").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG).convert("L")

def main():
    bots = json.load(open(os.environ.get("BOTS_FILE", os.path.join(ROOT, "bots.json"))))
    profs = profiles(); report = {}
    for b in bots:
        name = b["name"]; aid = b.get("id")
        if aid not in profs:
            aid = next((k for k, p in profs.items() if p.get("name") == name), aid)
        exts = ("png", "jpg", "jpeg", "webp")
        src = next((os.path.join(SRC, f"{name}.{e}") for e in exts if os.path.isfile(os.path.join(SRC, f"{name}.{e}"))), None)
        if not src and AGENTS:
            d = os.path.join(AGENTS, aid or "-")
            src = next((os.path.join(d, f"avatar.{e}") for e in exts if os.path.isfile(os.path.join(d, f"avatar.{e}"))), None)
        p = dict(profs.get(aid, {}))
        for k in ("avatarShape", "avatarColor"):
            if b.get(k): p[k] = b[k]
        shape = (p.get("avatarShape", ""), p.get("avatarColor", ""))
        if src: im, how = from_image(src), "avatar image"
        elif p: im, how = draw_shape(*shape, name), f"shape {shape[0] or 'disc'}/{shape[1] or 'grey'}"
        else: im, how = draw_shape("", "", name), "monogram"
        circle(im).resize((96, 96), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"), optimize=True)
        hud_im = im if src else draw_shape(*shape, name, mono=True)
        hud(hud_im).save(os.path.join(OUT, f"{name}.hud.png"), optimize=True)
        report[name] = {"source": how, "agentDir": aid if AGENTS and aid != b.get("id") else None}
    json.dump(report, open(os.path.join(OUT, "index.json"), "w"), indent=1)
    for k, v in report.items(): print(f"{k:12s} {v['source']}" + (f"  (id in bots.json didn't match; found by name: {v['agentDir']})" if v["agentDir"] else ""))

main()
