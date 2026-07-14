#!/usr/bin/env python3
"""Generate the shot-FX sprites (public/assets/sprites/fx_*.png).

All GRAYSCALE + alpha so the renderer's per-weapon emissiveColor does the
tinting (the old burst.png baked an orange donut into the texture — every
impact/halo rendered as a cartoon ring regardless of weapon color).

  fx_spark.png  — hard radial starburst: impact sparks + shot glow accents
  fx_glow.png   — soft radial falloff: muzzle-flash halo bloom
  fx_scorch.png — noisy dark blotch mask: bullet scorch marks + smoke puffs

Deterministic (seeded). UT99 read: sparks are SPIKY and brief, marks are dark.
"""
import math, random
from PIL import Image, ImageDraw, ImageFilter

S = 128
C = S / 2
rng = random.Random(99)


def save(img, name):
    out = 'public/assets/sprites/' + name
    img.save(out)
    print('WROTE', out)


# --- fx_spark: thin radial spikes of varying length + a small hot core -------
img = Image.new('LA', (S, S), (0, 0))
draw = ImageDraw.Draw(img)
for i in range(14):
    ang = (i / 14) * math.tau + rng.uniform(-0.12, 0.12)
    ln = rng.uniform(0.35, 1.0) * (C - 4)
    w = rng.uniform(1.2, 2.6)
    x2, y2 = C + math.cos(ang) * ln, C + math.sin(ang) * ln
    draw.line([(C, C), (x2, y2)], fill=(255, 235), width=int(w))
img = img.filter(ImageFilter.GaussianBlur(0.8))
core = ImageDraw.Draw(img)
core.ellipse([C - 7, C - 7, C + 7, C + 7], fill=(255, 255))
img = img.filter(ImageFilter.GaussianBlur(0.6))
save(img.convert('RGBA'), 'fx_spark.png')

# --- fx_glow: plain soft radial gradient --------------------------------------
img = Image.new('LA', (S, S), (0, 0))
px = img.load()
for y in range(S):
    for x in range(S):
        d = math.hypot(x - C, y - C) / C
        a = max(0.0, 1.0 - d)
        v = int(255 * (a ** 2.2))
        px[x, y] = (255, v)
save(img.convert('RGBA'), 'fx_glow.png')

# --- fx_scorch: irregular soft blotch (alpha mask; tinted dark at runtime) ---
img = Image.new('LA', (S, S), (0, 0))
draw = ImageDraw.Draw(img)
for _ in range(26):
    ang = rng.uniform(0, math.tau)
    r = rng.uniform(0, C * 0.42)
    x, y = C + math.cos(ang) * r, C + math.sin(ang) * r
    rad = rng.uniform(6, 22)
    a = rng.randint(90, 200)
    draw.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(255, a))
img = img.filter(ImageFilter.GaussianBlur(6))
# fade the blotch out toward the quad edge so it never shows a square boundary
px = img.load()
for y in range(S):
    for x in range(S):
        d = math.hypot(x - C, y - C) / C
        l, a = px[x, y]
        px[x, y] = (l, int(a * max(0.0, 1.0 - d ** 1.5)))
save(img.convert('RGBA'), 'fx_scorch.png')
