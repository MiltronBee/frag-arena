#!/usr/bin/env python3
"""Generate the dusk arena skybox (public/assets/sprites/skybox_dusk.png).

Equirectangular 1024x512. UT99-style mood: deep indigo zenith falling to a
burnt-orange horizon band, dark haze below, faint stars up top and a few dark
cloud smears. Deterministic (seeded) so rebuilds are reproducible.
"""
import math, random
from PIL import Image, ImageDraw, ImageFilter

W, H = 1024, 512
HORIZON = 0.52  # fraction of height where the horizon band sits
rng = random.Random(1999)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

ZENITH   = (10, 11, 22)     # near-black indigo
UPPER    = (24, 24, 44)     # dark violet-slate
BAND_HI  = (96, 44, 26)     # rust
BAND_HOT = (214, 118, 44)   # burnt orange glow at the horizon line
BELOW    = (16, 13, 14)     # dark ground haze
BOTTOM   = (7, 7, 9)

img = Image.new('RGB', (W, H))
px = img.load()
hy = H * HORIZON
for y in range(H):
    if y < hy:
        t = y / hy
        if t < 0.62:
            c = lerp(ZENITH, UPPER, t / 0.62)
        else:
            tt = (t - 0.62) / 0.38
            c = lerp(UPPER, BAND_HI, tt * tt)  # ease into the band
    else:
        t = (y - hy) / (H - hy)
        c = lerp(BELOW, BOTTOM, t)
    for x in range(W):
        px[x, y] = c

draw = ImageDraw.Draw(img, 'RGBA')

# hot horizon line: a thin bright band with vertical falloff
for dy in range(-10, 22):
    y = int(hy) + dy
    if 0 <= y < H:
        fall = math.exp(-(dy * dy) / (2 * 7.0 ** 2)) * (0.55 if dy > 0 else 1.0)
        c = lerp((0, 0, 0), BAND_HOT, fall)
        draw.line([(0, y), (W, y)], fill=(c[0], c[1], c[2], int(200 * fall)))

# faint stars in the upper sky
for _ in range(140):
    x = rng.randrange(W)
    y = rng.randrange(int(hy * 0.75))
    b = rng.randint(70, 170)
    draw.point((x, y), fill=(b, b, min(255, b + 20), 255))

# dark cloud smears drifting above the horizon
for _ in range(9):
    cx = rng.randrange(W)
    cy = int(hy) - rng.randint(18, 90)
    w = rng.randint(90, 260)
    h = rng.randint(6, 16)
    shade = rng.randint(14, 26)
    draw.ellipse([cx - w, cy - h, cx + w, cy + h], fill=(shade, shade, shade + 6, 120))

img = img.filter(ImageFilter.GaussianBlur(1.2))
out = 'public/assets/sprites/skybox_dusk.png'
img.save(out)
print('WROTE', out)
