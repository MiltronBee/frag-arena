#!/usr/bin/env python3
"""Composite team-crest banner textures from an isolated Gemini emblem.

Division of labour: Gemini makes ONE neutral chrome emblem on green chroma
(scripts/gemini-emblem.mjs); this owns everything Gemini can't control —
keying, team tint, glow, the stone substrate, and the tiling layout. Because
both teams composite the SAME emblem, Red and Blue are a guaranteed matched
pair, differing only in hue.

Seamlessness: the substrate is made tileable with an offset-blend, and the
emblem sits centred with clear margin so it never crosses a tile edge. When the
surface UV repeats the texture (Red tiles ~3.3x2), it reads as a deliberate
step-and-repeat heraldic banner rather than a broken seam — that's the
"several crests per image" layout.

Emblems can be pre-squashed vertically (--vsquash) to pre-compensate a surface
that stretches the texture tall; tune it from an in-game shot, not from UV math.

  python3 scripts/compose-crest.py --emblem raptor \
      --out-red CTF_Crypt_C-st-128-R --out-blue CTF_Crypt_C-rst-128-B
"""
import argparse, os
import numpy as np
from PIL import Image, ImageFilter, ImageChops, ImageOps

ROOT = os.path.expanduser('~/unreal')
EMBLEMS = os.path.join(ROOT, 'public/textures/emblems')
STONE = os.path.join(ROOT, 'maps/improved/textures_hd/ShaneChurch_archeBloks2.png')
OUTROOT = os.path.join(ROOT, 'public/textures/candidates')
SIZE = 1024  # author at 2x ship res; promotion downsamples to 512

# Team hue triples: (shadow, mid, spec) for the metal ramp. Spec stays near-white
# so the metal still reads as shiny rather than plastic.
TEAMS = {
    'violet': ((28, 6, 44), (153, 69, 255), (240, 225, 255)),   # Solana #9945FF
    'green':  ((6, 40, 28), (20, 241, 149), (224, 255, 244)),   # Solana #14F195
    'red':    ((40, 6, 8), (214, 50, 50), (255, 232, 224)),
    'blue':   ((8, 20, 46), (46, 107, 214), (224, 240, 255)),
}
GLOW = {'violet': (170, 90, 255), 'green': (40, 255, 170), 'red': (255, 70, 70), 'blue': (70, 150, 255)}


def key_green(im):
    """Green chroma -> straight alpha, with green-spill removal on the fringe."""
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # greenness: how much g dominates the other two channels
    greenness = (g - np.maximum(r, b))
    alpha = np.clip(1.0 - (greenness - 20) / 60.0, 0, 1)  # >80 green -> 0, <20 -> 1
    alpha[greenness < 20] = 1.0
    # despill: where a pixel is still greenish inside the kept region, clamp g
    spill = (g > (r + b) / 2 + 10)
    g2 = np.where(spill, (r + b) / 2 + 10, g)
    out = np.dstack([r, g2, b, alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def tint_metal(emblem_rgba, shadow, mid, spec):
    """Colourise neutral metal to a team hue, preserving bevel shading.

    Luminance drives a 3-stop ramp shadow->mid->spec, so recesses go dark team,
    faces read as team-coloured metal, and highlights stay bright specular.
    """
    rgb = emblem_rgba.convert('RGB')
    lum = np.asarray(ImageOps.grayscale(rgb)).astype(np.float32) / 255.0
    sh, md, sp = np.array(shadow), np.array(mid), np.array(spec)
    lo = lum < 0.5
    t = np.where(lo, lum / 0.5, (lum - 0.5) / 0.5)[..., None]
    a, bb = np.where(lo[..., None], sh, md), np.where(lo[..., None], md, sp)
    out = (a + (bb - a) * t).astype(np.uint8)
    res = Image.fromarray(out, 'RGB').convert('RGBA')
    res.putalpha(emblem_rgba.getchannel('A'))
    return res


def make_seamless(stone, size):
    """Tileable substrate: offset by half and feather-blend the crossing seams."""
    s = stone.convert('RGB').resize((size, size), Image.LANCZOS)
    s = ImageEnhance_darken(s)
    arr = np.asarray(s).astype(np.float32)
    rolled = np.roll(np.roll(arr, size // 2, 0), size // 2, 1)
    # feather mask: blend a band around the (now-central) seams
    m = np.zeros((size, size), np.float32)
    band = size // 8
    for c in (size // 2,):
        m[c - band:c + band, :] = 1
        m[:, c - band:c + band] = 1
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(band / 2))) / 255.0
    out = arr * (1 - m[..., None]) + rolled * m[..., None]
    return Image.fromarray(out.astype(np.uint8), 'RGB')


def ImageEnhance_darken(im):
    """Push stone dark + toward neutral so the team colour reads on top."""
    a = np.asarray(im).astype(np.float32)
    g = a.mean(2, keepdims=True)
    a = a * 0.4 + g * 0.6 * 0.4      # desaturate 60%, then darken to ~40%
    a = np.clip(a * 0.55, 0, 255)
    return Image.fromarray(a.astype(np.uint8), 'RGB')


def glow_layer(alpha, color, size):
    g = alpha.filter(ImageFilter.GaussianBlur(size // 22))
    tint = Image.new('RGB', (size, size), color)
    lay = Image.new('RGB', (size, size), (0, 0, 0))
    lay.paste(tint, (0, 0), g)
    return lay


def compose(emblem_keyed, team, vsquash, scale):
    sh, md, sp = TEAMS[team]
    metal = tint_metal(emblem_keyed, sh, md, sp)

    # scale + optional vertical pre-squash, keep centred with margin
    ew = int(SIZE * scale)
    eh = int(ew * (1.0 - vsquash))
    metal = metal.resize((ew, eh), Image.LANCZOS)
    emb = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    emb.paste(metal, ((SIZE - ew) // 2, (SIZE - eh) // 2), metal)
    alpha = emb.getchannel('A')

    base = make_seamless(Image.open(STONE), SIZE)
    # recessed inlay shadow under the emblem so it looks set INTO the stone
    contact = alpha.filter(ImageFilter.GaussianBlur(SIZE // 90))
    shade = Image.new('RGB', (SIZE, SIZE), (0, 0, 0))
    base = Image.composite(Image.blend(base, shade, 0.55), base, contact)

    glow = glow_layer(alpha, GLOW[team], SIZE)
    base = ImageChops.screen(base, glow)          # outer bloom
    out = base.convert('RGBA')
    out.alpha_composite(emb)                        # the metal emblem on top
    out = ImageChops.screen(out.convert('RGB'), glow_layer(alpha.filter(ImageFilter.GaussianBlur(SIZE//120)), GLOW[team], SIZE))
    return Image.fromarray(np.asarray(out).astype(np.uint8), 'RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--emblem', default='raptor')
    ap.add_argument('--out-red', required=True, help='material name for red/violet team surface')
    ap.add_argument('--out-blue', required=True, help='material name for blue/green team surface')
    ap.add_argument('--red-team', default='violet', choices=list(TEAMS))
    ap.add_argument('--blue-team', default='green', choices=list(TEAMS))
    ap.add_argument('--vsquash', type=float, default=0.0, help='0..0.8 vertical pre-squash for stretched surfaces')
    ap.add_argument('--scale', type=float, default=0.66, help='emblem size fraction of the tile')
    args = ap.parse_args()

    ep = os.path.join(EMBLEMS, args.emblem + '.png')
    keyed = key_green(Image.open(ep))

    for mat, team in [(args.out_red, args.red_team), (args.out_blue, args.blue_team)]:
        outdir = os.path.join(OUTROOT, mat)
        os.makedirs(outdir, exist_ok=True)
        img = compose(keyed, team, args.vsquash, args.scale)
        name = f'crest-{args.emblem}-{team}'
        img.save(os.path.join(outdir, name + '.png'))
        img.resize((512, 512), Image.LANCZOS).save(os.path.join(outdir, name + '.webp'), 'WEBP', quality=88)
        print(f'  {mat}: {name}.png (+512 webp)  team={team}')


if __name__ == '__main__':
    main()
