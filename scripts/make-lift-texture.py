#!/usr/bin/env python3
"""Author the LIFT PLATFORM texture set (UT99 movers were plain grey boxes in v1).

WHY procedural instead of reusing public/assets/scifi/T_Trim_*: those are trim-sheet
ATLASES authored against the specific Quaternius meshes' UVs — a lift is a
MeshBuilder.CreateBox whose faces each carry a plain 0..1 UV quad, so an atlas maps
one arbitrary crop of unrelated greeble onto every face. A box needs a TILEABLE
texture, which is what this makes.

WHY procedural instead of Gemini: a lift deck is industrial diamond plate — a strict
periodic lattice. Generating it arithmetically makes it seamless BY CONSTRUCTION
(every pattern is a function of (x mod period)), so it needs no seamless-fix pass and
tiles perfectly at any repeat. See frag-texture-pipeline: "Gemini 'must tile' is
unreliable".

Outputs (public/assets/props/):
  lift_deck.webp      albedo — dark steel diamond/tread plate, worn, FLAT-LIT
  lift_deck_n.webp    normal map (Sobel of the height field that built the albedo)

HARD RULE inherited from the map pipeline: FLAT ALBEDO, no baked directional
lighting. The scene does its own lighting (sun DirectionalLight + the mover's dim
emissive edge), so a baked highlight would double-light and read as plastic. The
diamond relief is carried by the NORMAL map, not by painted shading.

Usage: python3 scripts/make-lift-texture.py [--size 512] [--preview]
"""
import argparse
import os
import numpy as np
from PIL import Image

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                       'public', 'assets', 'props')


def diamond_plate(n, cells=4):
    """Height field in [0,1]: a diamond/tread lattice on a steel base.

    `cells` = diamonds per texture edge. Everything is built from (i*cells/n) mod 1,
    so the field is exactly periodic across the texture edge => seamless when tiled.
    """
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    u = (x / n) * cells
    v = (y / n) * cells

    # REAL diamond tread plate: raised elongated studs, brick-offset row to row, with
    # the stud's long axis FLIPPING every row — that alternation is what makes tread
    # plate read as tread plate instead of as a wire grate.
    #
    # A stud is an L1 ball (|du| / ax + |dv| / ay < 1) inside its cell, so the pattern
    # is a pure function of the cell-local coordinate and stays exactly periodic.
    row = np.floor(v)                       # which stud row we're in
    flip = (row % 2.0)                      # 0 / 1 -> alternate the long axis per row
    uu = (u + 0.5 * flip) % 1.0 - 0.5       # brick offset: shift odd rows half a cell
    vv = v % 1.0 - 0.5

    # long/short semi-axes, swapped on alternating rows
    ax = np.where(flip > 0.5, 0.48, 0.27)
    ay = np.where(flip > 0.5, 0.27, 0.48)
    d = np.abs(uu) / ax + np.abs(vv) / ay   # 1.0 exactly on the stud outline

    # SHARP bevel: a narrow shoulder gives a crisp machined edge. The old 0.16-wide
    # shoulder on a soft field is what made the first pass look blurred.
    tread = np.clip((1.0 - d) / 0.16, 0.0, 1.0)
    tread = tread ** 0.65                   # flatten the crown so studs read as plateaus

    # PLATE SEAMS: a recessed groove every `seam_every` cells gives the eye a real-world
    # size reference, so a big lift face doesn't look like uniform wallpaper.
    seam_every = 4.0
    su = np.minimum((u % seam_every), seam_every - (u % seam_every))
    sv = np.minimum((v % seam_every), seam_every - (v % seam_every))
    seam = np.clip(np.minimum(su, sv) / 0.10, 0.0, 1.0)   # 0 in the groove, 1 away
    tread = tread * (0.35 + 0.65 * seam)

    # steel substrate: low-amplitude multi-octave value noise, periodic in both axes
    rng = np.random.default_rng(7)
    base = np.zeros((n, n), np.float32)
    for period, amp in ((16, 0.45), (32, 0.26), (64, 0.16), (128, 0.10)):
        g = rng.random((period, period)).astype(np.float32)
        # tile-then-resize keeps it periodic; bilinear keeps it smooth
        tile = Image.fromarray((g * 255).astype(np.uint8)).resize((n, n), Image.BILINEAR)
        base += amp * (np.asarray(tile, np.float32) / 255.0)
    base /= 1.04
    base -= base.min()
    base /= max(base.max(), 1e-6)

    # subtle rolled-steel grain: fine horizontal streaks (periodic sine + noise)
    grain = 0.5 + 0.5 * np.sin(v * np.pi * 2 * 3 + base * 6.0)

    h = 0.12 * base + 0.05 * grain + 0.83 * tread
    return np.clip(h, 0, 1), tread, base


def to_albedo(h, tread, base, rng):
    """FLAT albedo from the height field: dark gunmetal, worn tread crowns, grime.

    Tread crowns are LIGHTER (bare metal polished by boots), recesses DARKER (grime
    collects) — that is material variation, not directional light, so it stays legal
    under the flat-albedo rule.
    """
    n = h.shape[0]
    # gunmetal ramp: deep blue-grey recess -> mid steel crown
    lo = np.array([0.165, 0.175, 0.196], np.float32)   # recess / shadowed grime
    hi = np.array([0.520, 0.535, 0.560], np.float32)   # worn crown, bare steel
    t = (0.22 * base + 0.78 * tread)[..., None]
    rgb = lo + (hi - lo) * t

    # patchy grime/oxide blotches (periodic low-freq noise), slightly warm
    blot = rng.random((16, 16)).astype(np.float32)
    blot = np.asarray(Image.fromarray((blot * 255).astype(np.uint8))
                      .resize((n, n), Image.BICUBIC), np.float32) / 255.0
    grime = np.clip((blot - 0.45) / 0.55, 0, 1)[..., None]
    rgb *= (1.0 - 0.30 * grime)
    rgb += grime * np.array([0.045, 0.032, 0.018], np.float32)   # rust-warm tint

    # fine per-pixel speckle so a big flat face never reads as a gradient
    spk = (rng.random((n, n)).astype(np.float32) - 0.5)[..., None]
    rgb += spk * 0.016

    return np.clip(rgb, 0, 1)


def to_normal(h, strength=2.6):
    """Sobel height -> tangent-space normal map (same approach as derive-normal.py).

    np.roll for the gradient keeps the normal map seamless: the wrap-around
    difference at the edge is taken against the OPPOSITE edge, which is the correct
    neighbour for a tiling texture.
    """
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + nz * nz)
    nx, ny, nz = -dx / ln, -dy / ln, nz / ln
    out = np.stack([(nx + 1) * 0.5, (ny + 1) * 0.5, (nz + 1) * 0.5], -1)
    return np.clip(out, 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--cells', type=int, default=7, help='diamonds per texture edge')
    ap.add_argument('--preview', action='store_true',
                    help='also write a 2x2 tiled contact sheet to verify seamlessness')
    args = ap.parse_args()

    n = args.size
    rng = np.random.default_rng(11)
    h, tread, base = diamond_plate(n, args.cells)
    albedo = to_albedo(h, tread, base, rng)
    normal = to_normal(h)

    os.makedirs(OUT_DIR, exist_ok=True)
    a_path = os.path.join(OUT_DIR, 'lift_deck.webp')
    n_path = os.path.join(OUT_DIR, 'lift_deck_n.webp')
    Image.fromarray((albedo * 255).astype(np.uint8)).save(a_path, quality=92, method=6)
    Image.fromarray((normal * 255).astype(np.uint8)).save(n_path, quality=92, method=6)
    print(f'wrote {a_path} ({os.path.getsize(a_path)//1024} KB)')
    print(f'wrote {n_path} ({os.path.getsize(n_path)//1024} KB)')
    print(f'albedo mean RGB = {tuple(round(float(c*255)) for c in albedo.reshape(-1,3).mean(0))}')

    if args.preview:
        im = Image.fromarray((albedo * 255).astype(np.uint8))
        sheet = Image.new('RGB', (n * 2, n * 2))
        for i in range(2):
            for j in range(2):
                sheet.paste(im, (i * n, j * n))
        p = '/tmp/lift_deck_tiled.png'
        sheet.save(p)
        print(f'wrote {p} (2x2 tile — seams must be invisible)')


if __name__ == '__main__':
    main()
