#!/usr/bin/env python3
"""Force generated remaster candidates to tile seamlessly.

Gemini's "must tile" prompt is unreliable — img2img output usually has a visible
wrap seam, which in-game becomes a grid line every tile (the repetition we are
trying to kill). This re-imposes tileability deterministically.

Method (offset-then-heal): rolling the image by exactly half moves every
original edge to the centre and makes the NEW wrap edges adjacent-in-original,
so they match perfectly — the discontinuity is now the centre cross, which we
heal with a feathered blend against a second half-offset copy (seamless content
folded back in). Result: guaranteed-wrapping edges; the only cost is a soft band
through the middle, invisible on the high-frequency rock/stone/dirt this runs on.

Raw generations are preserved under <mat>/_raw/ (the gallery skips subdirs).
  python3 scripts/seamless-fix.py <material> [material ...]
"""
import os, sys, glob
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.expanduser('~/unreal')
CANDS = os.path.join(ROOT, 'public/textures/candidates')


def make_seamless(im):
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    h, w = a.shape[:2]
    rolled = np.roll(np.roll(a, h // 2, 0), w // 2, 1)   # edges now seamless; seam at centre cross
    heal = np.roll(rolled, h // 2, 0)                     # a 2nd offset copy to blend the seam against
    heal = np.roll(heal, w // 2, 1)
    band = max(8, w // 12)
    m = np.zeros((h, w), np.float32)
    m[h // 2 - band:h // 2 + band, :] = 1
    m[:, w // 2 - band:w // 2 + band] = 1
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(band / 2))) / 255.0
    out = rolled * (1 - m[..., None]) + heal * m[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')


def main():
    mats = sys.argv[1:]
    if not mats:
        print('usage: seamless-fix.py <material> [...]'); sys.exit(1)
    for mat in mats:
        d = os.path.join(CANDS, mat)
        raw = os.path.join(d, '_raw')
        os.makedirs(raw, exist_ok=True)
        pngs = [p for p in glob.glob(os.path.join(d, 'remaster-*.png'))]
        for p in pngs:
            name = os.path.basename(p)
            rawp = os.path.join(raw, name)
            if not os.path.exists(rawp):
                os.replace(p, rawp)            # stash the raw generation once
            fixed = make_seamless(Image.open(rawp))
            fixed.save(p)
            fixed.resize((512, 512), Image.LANCZOS).save(p.replace('.png', '.webp'), 'WEBP', quality=88)
            print(f'  {mat}/{name}: seamless (+512 webp)')


if __name__ == '__main__':
    main()
