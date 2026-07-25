#!/usr/bin/env python3
"""Author the combat-helmet skin (helmet_0.glb ships two flat near-black materials).

WHY THIS WAS REWRITTEN (2026-07-24). The first version bound correctly and still looked
grey in game, for two compounding reasons:

  1. It was almost featureless. Measured on the shipped file: mean RGB (45,49,56) with a
     standard deviation of NINE levels out of 255, and a normal map of (127,127,254) +-2
     — i.e. a flat dark swatch and a flat normal. There was nothing on it to see, so
     "textured" and "untextured grey" looked identical.
  2. It was applied at metallic 0.6 in a scene with NO environmentTexture, so even that
     little detail was multiplied away (see CharacterModel._fixUnlitMetal).

This version fixes (1): a brighter, high-contrast machined-armour skin with real
structure. (2) is fixed on the material side.

The UV CONSTRAINT still holds: the shell's unwrap is a PACKED faceplate atlas, not a
clean cylinder, so any PLACED feature (a brow band, a stripe) scatters across islands.
Everything here is therefore UV-AGNOSTIC — allover patterns that read correctly no
matter how the islands are cut: panel seams, rivets, brushed grain, scratches, edge
wear. That is the same reason the accent is left to the pod geometry, not painted on.

Outputs (public/assets/props/): helmet_skin.webp (albedo), helmet_skin_n.webp (normal).
"""
import argparse, os
import numpy as np
from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets', 'props')


def _smooth_noise(rng, n, cells):
    """Value noise at `cells` resolution, bilinearly resampled to n x n."""
    g = rng.random((cells, cells)).astype(np.float32)
    im = Image.fromarray((g * 255).astype(np.uint8)).resize((n, n), Image.BICUBIC)
    return np.asarray(im, np.float32) / 255.0


def _fbm(rng, n, octaves=(4, 8, 16, 32, 64, 128), amps=(0.5, 0.28, 0.16, 0.10, 0.06, 0.04)):
    out = np.zeros((n, n), np.float32)
    for c, a in zip(octaves, amps):
        out += a * _smooth_noise(rng, n, c)
    out -= out.min()
    return out / max(out.max(), 1e-6)


def build(n):
    rng = np.random.default_rng(11)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)

    # ---- PANEL SEAMS ---------------------------------------------------------
    # An irregular grid of recessed seams. Irregular on purpose: a perfectly regular
    # grid reads as gingham once the atlas packs it at different scales per island.
    seam = np.zeros((n, n), np.float32)
    for axis in (0, 1):
        pos, step = 0, 0
        while pos < n:
            step = int(rng.integers(n // 12, n // 5))
            pos += step
            if pos >= n:
                break
            w = int(rng.integers(2, 4))
            if axis == 0:
                seam[max(pos - w, 0):pos + w, :] = 1.0
            else:
                seam[:, max(pos - w, 0):pos + w] = 1.0
    seam_soft = np.asarray(Image.fromarray((seam * 255).astype(np.uint8))
                           .filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255.0

    # ---- RIVETS --------------------------------------------------------------
    # Small raised studs scattered along the seams (where a real panel is fastened).
    rivet = np.zeros((n, n), np.float32)
    ys, xs = np.nonzero(seam > 0.5)
    if len(ys):
        pick = rng.choice(len(ys), size=min(len(ys) // 220, 900), replace=False)
        r = max(n // 220, 2)
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        disc = np.clip(1.0 - np.sqrt(yy ** 2 + xx ** 2) / r, 0, 1) ** 0.6
        for i in pick:
            cy, cx = int(ys[i]), int(xs[i])
            y0, y1 = cy - r, cy + r + 1
            x0, x1 = cx - r, cx + r + 1
            if y0 < 0 or x0 < 0 or y1 > n or x1 > n:
                continue
            rivet[y0:y1, x0:x1] = np.maximum(rivet[y0:y1, x0:x1], disc)

    # ---- GRAIN / BRUSHED STREAKS --------------------------------------------
    grain = _fbm(rng, n)
    streak = 0.5 + 0.5 * np.sin(y * np.pi * 2 * 64 / n + grain * 9)
    brushed = 0.75 * grain + 0.25 * streak

    # ---- SCRATCHES + EDGE WEAR ----------------------------------------------
    scratch = (_smooth_noise(rng, n, n // 2) > 0.86).astype(np.float32)
    scratch *= (0.5 + 0.5 * np.sin(x * 0.7 + y * 0.31))
    scratch = np.asarray(Image.fromarray((scratch * 255).astype(np.uint8))
                         .filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255.0
    wear = (_fbm(rng, n, (6, 12, 24), (0.6, 0.3, 0.15)) ** 2.2)

    # ---- HEIGHT (drives the normal map) -------------------------------------
    height = (0.55 * brushed - 0.85 * seam_soft + 0.9 * rivet + 0.10 * scratch)

    # ---- ALBEDO --------------------------------------------------------------
    # Mid gunmetal, NOT near-black: the old ramp topped out at 0.305 and averaged 0.18,
    # which is below what the arena's dim key light can lift back into visibility.
    # Ramp re-tuned after looking at it on the rig (playground, 2026-07-24): the first
    # pass at hi=0.60 averaged 122/255 and, once _fixUnlitMetal adds its 0.30 self-lit
    # pass ON TOP of the same albedo, read as pale concrete against the near-black
    # bodysuit. Gunmetal wants a DARK base with bright machined detail on it, so the
    # base ramp drops ~30% while the detail adds keep most of their punch (contrast is
    # what makes it read as machined; overall value is what makes it read as metal).
    lo = np.array([0.135, 0.145, 0.170])  # shadowed plate
    hi = np.array([0.415, 0.435, 0.480])  # lit plate
    t = np.clip(0.35 + 0.65 * brushed, 0, 1)[..., None]
    rgb = lo + (hi - lo) * t
    rgb *= (1.0 - 0.55 * seam_soft)[..., None]                       # seams go dark
    rgb += (rivet * 0.20)[..., None]                                  # studs catch light
    rgb += (scratch * 0.24)[..., None] * np.array([1.00, 0.99, 0.95])  # bright bare metal
    rgb += (wear * 0.13)[..., None] * np.array([1.00, 0.92, 0.80])     # warm worn patina
    rgb = np.clip(rgb, 0, 1)

    # ---- NORMAL --------------------------------------------------------------
    # Strength raised hard: the previous map was effectively flat (std 2/255), so the
    # relief contributed nothing at any light angle.
    h = np.asarray(Image.fromarray((np.clip(height * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8))
                   .filter(ImageFilter.GaussianBlur(0.7)), np.float32) / 255.0
    k = 9.0
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * k
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * k
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + nz * nz)
    nrm = np.stack([(-dx / ln + 1) * .5, (-dy / ln + 1) * .5, (nz / ln + 1) * .5], -1)
    return rgb, np.clip(nrm, 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=512)
    n = ap.parse_args().size
    rgb, nrm = build(n)
    os.makedirs(OUT, exist_ok=True)
    for arr, name in ((rgb, 'helmet_skin.webp'), (nrm, 'helmet_skin_n.webp')):
        p = os.path.join(OUT, name)
        Image.fromarray((arr * 255).astype(np.uint8)).save(p, quality=92, method=6)
        a = (arr * 255)
        print('wrote', p, os.path.getsize(p) // 1024, 'KB',
              'mean', a.reshape(-1, a.shape[-1]).mean(0).round(1),
              'std', a.reshape(-1, a.shape[-1]).std(0).round(1))
    e = os.path.join(OUT, 'helmet_skin_e.webp')
    if os.path.exists(e):
        os.remove(e)
        print('removed', e)


if __name__ == '__main__':
    main()
