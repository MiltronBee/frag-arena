#!/usr/bin/env python3
"""Generate blood-impact sprites (public/assets/sprites/blood_*.png).

All GRAYSCALE + alpha so the renderer tints per droplet-class (dark burgundy
core for weight, bright crimson for the hot mist) — same convention as
make-fx-sprites.py. Deterministic (seeded). Four distinct shapes so blood reads
as blood, not red confetti (per the FX consult):

  blood_mist.png   — soft gaseous cloud: the atomized puff at the hit instant
  blood_drop.png   — crisp round droplet: the heavy micro-drops that fall
  blood_streak.png — elongated teardrop: velocity-stretched spurts
  blood_splat.png  — jagged starburst + satellites: core mark + ground pool
"""
import math
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 128
C = S / 2


def _img():
    return Image.new('LA', (S, S), (255, 0))  # white luminance, 0 alpha


def save(img, name):
    img.save(f'public/assets/sprites/{name}.png')
    print(f'wrote public/assets/sprites/{name}.png')


def radial_alpha(power=2.0, radius=0.46):
    """Soft radial alpha falloff, 1 at center -> 0 at radius*S."""
    y, x = np.ogrid[0:S, 0:S]
    d = np.sqrt((x - C) ** 2 + (y - C) ** 2) / (radius * S)
    a = np.clip(1.0 - d, 0.0, 1.0) ** power
    return a


def to_img(alpha):
    a = np.clip(alpha, 0, 1)
    lum = np.full((S, S), 255, np.uint8)
    arr = np.dstack([lum, (a * 255).astype(np.uint8)])
    return Image.fromarray(arr, 'LA')


def mist():
    rng = random.Random(11)
    a = radial_alpha(power=1.6, radius=0.5) * 0.75
    # break it up with a few soft lobes so it looks gaseous, not a clean disc
    lobes = np.zeros((S, S))
    yy, xx = np.ogrid[0:S, 0:S]
    for _ in range(9):
        cx = C + rng.uniform(-0.22, 0.22) * S
        cy = C + rng.uniform(-0.22, 0.22) * S
        r = rng.uniform(0.10, 0.22) * S
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
        lobes += np.clip(1.0 - d, 0, 1) ** 2
    a = a * (0.5 + 0.5 * np.clip(lobes, 0, 1))
    img = to_img(a).filter(ImageFilter.GaussianBlur(4.0))
    return img


def drop():
    # crisp round droplet, slightly soft edge, denser core
    a = radial_alpha(power=2.6, radius=0.34)
    a = np.clip(a * 1.15, 0, 1)
    img = to_img(a).filter(ImageFilter.GaussianBlur(1.2))
    return img


def streak():
    # elongated teardrop: fat round head at bottom, tapering tail up (motion)
    img = _img()
    d = ImageDraw.Draw(img)
    head_r = 0.16 * S
    hx, hy = C, C + 0.20 * S
    d.ellipse([hx - head_r, hy - head_r, hx + head_r, hy + head_r], fill=(255, 255))
    # tail: stacked shrinking circles toward the top
    n = 26
    for i in range(n):
        t = i / (n - 1)
        y = hy - t * 0.58 * S
        r = head_r * (1.0 - t) ** 1.4
        if r < 0.6:
            continue
        a = int(255 * (1.0 - t) ** 1.2)
        d.ellipse([C - r, y - r, C + r, y + r], fill=(255, a))
    return img.filter(ImageFilter.GaussianBlur(1.6))


def splat():
    # irregular central blob with jagged arms + satellite droplets (impact star
    # + ground pool). Denser, harder edges than mist.
    rng = random.Random(73)
    img = _img()
    d = ImageDraw.Draw(img)
    # central blob from overlapping ellipses
    for _ in range(10):
        cx = C + rng.uniform(-0.10, 0.10) * S
        cy = C + rng.uniform(-0.10, 0.10) * S
        r = rng.uniform(0.14, 0.24) * S
        d.ellipse([cx - r, cy - r, cx + r * rng.uniform(0.8, 1.2),
                   cy + r * rng.uniform(0.8, 1.2)], fill=(255, 255))
    # jagged arms
    for _ in range(11):
        ang = rng.uniform(0, 2 * math.pi)
        length = rng.uniform(0.20, 0.44) * S
        x2 = C + math.cos(ang) * length
        y2 = C + math.sin(ang) * length
        w = rng.uniform(2, 6)
        d.line([C, C, x2, y2], fill=(255, 255), width=int(w))
        # satellite droplet at the tip
        sr = rng.uniform(2, 6)
        d.ellipse([x2 - sr, y2 - sr, x2 + sr, y2 + sr], fill=(255, 255))
    return img.filter(ImageFilter.GaussianBlur(1.0))


if __name__ == '__main__':
    save(mist(), 'blood_mist')
    save(drop(), 'blood_drop')
    save(streak(), 'blood_streak')
    save(splat(), 'blood_splat')
