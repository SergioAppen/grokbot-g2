#!/usr/bin/env python3
# Flatten simulator glasses screenshots (green + alpha = brightness) onto black, 2x, for viewing.
import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p).convert("RGBA"); bg = Image.new("RGBA", im.size, (0, 0, 0, 255)); bg.alpha_composite(im)
    bg.convert("RGB").resize((im.width * 2, im.height * 2), Image.NEAREST).save(p.replace(".png", "_view.png"))
