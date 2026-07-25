#!/usr/bin/env python3
"""Composite the CTF team textures from the REAL BONK / WIF token logos.

The user asked for the actual token art (pulled from each SPL token's on-chain
Metaplex metadata -> off-chain JSON `image`, see scripts/fetch-token-logos.md):
  public/textures/emblems/token_bonk.png  (official 3D Shiba + "!!!" on orange)
  public/textures/emblems/token_wif.png   (the dogwifhat photo — Shiba in a pink hat)

The two logos have totally different framing (BONK is a square emblem, WIF is a
photo on grey), so to make them a matched FACTION PAIR we present each as a round
"coin" medallion with a brand-coloured bevelled rim, then set that medallion into
two surfaces:

  FLAG  -> a team-coloured banner cloth. We reuse an existing flag texture as the
           cloth so the fabric folds + UV land exactly where the flag mesh expects,
           recolour it to the brand hue (luminance x hue), and drop the medallion
           centred. Output: public/assets/props/Prop_Flag_{bonk,wif}.webp
  SIGIL -> the same darkened seamless stone substrate compose-crest.py uses, with a
           brand glow + a recessed inlay shadow so the coin looks set into the wall,
           centred with margin so the surface's UV tiling step-repeats cleanly.
           Output: the two CTF_Crypt decor sigil webps (+ regenerated normal maps).

Run from ~/unreal:
  python3 scripts/compose-memecoin-crest.py
"""
import os
import numpy as np
from PIL import Image, ImageFilter, ImageChops, ImageDraw, ImageOps

ROOT = os.path.expanduser('~/unreal')
EMB = os.path.join(ROOT, 'public/textures/emblems')
STONE = os.path.join(ROOT, 'maps/improved/textures_hd/ShaneChurch_archeBloks2.png')
PROPS = os.path.join(ROOT, 'public/assets/props')
SIGILS = os.path.join(ROOT, 'public/assets/maps/CTF-Visage/textures')
FLAG_TEMPLATE = os.path.join(PROPS, 'Prop_Flag_blue.webp')  # neutral cloth (folds + UV)
S = 1024  # author at 2x; ship 512

# Per-team look. banner = deep cloth base colour (multiplied onto the fabric luma).
# rim_out/rim_in = the medallion's bevelled ring. glow = the sigil's outer bloom.
TEAMS = {
    'bonk': {
        'logo': 'token_bonk.png',
        'banner': (214, 104, 18),    # orange cloth
        'rim_out': (255, 150, 30), 'rim_in': (110, 48, 6),
        'glow': (255, 140, 24),
        'flag_out': os.path.join(PROPS, 'Prop_Flag_bonk.webp'),
        'sigil': 'CTF_Crypt_C-st-128-R',   # red-team surface
    },
    'wif': {
        'logo': 'token_wif.png',
        'banner': (212, 48, 138),    # magenta/pink cloth
        'rim_out': (255, 95, 200), 'rim_in': (104, 20, 70),
        'glow': (255, 90, 196),
        'flag_out': os.path.join(PROPS, 'Prop_Flag_wif.webp'),
        'sigil': 'CTF_Crypt_C-rst-128-B',  # blue-team surface
    },
}


def center_square(im):
    w, h = im.size
    s = min(w, h)
    return im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))


def medallion(logo_path, rim_out, rim_in, diameter):
    """Round coin: the token art disc + a bevelled brand rim. Returns RGBA (diameter²)."""
    d = diameter
    art = center_square(Image.open(logo_path).convert('RGB')).resize((d, d), Image.LANCZOS)

    # circular alpha for the art disc (leave room for the rim)
    inner = int(d * 0.86)
    disc = Image.new('L', (d, d), 0)
    D = ImageDraw.Draw(disc)
    off = (d - inner) // 2
    D.ellipse([off, off, off + inner, off + inner], fill=255)
    disc = disc.filter(ImageFilter.GaussianBlur(d / 400))

    out = Image.new('RGBA', (d, d), (0, 0, 0, 0))

    # the rim: full-disc brand ring behind the art, bevel-shaded (top-lit)
    ring = Image.new('RGB', (d, d), rim_in)
    grad = np.linspace(1.15, 0.55, d)[:, None]  # top brighter than bottom -> bevel
    ro = np.array(rim_out, np.float32)
    ring_arr = np.clip(ro[None, None, :] * grad[..., None], 0, 255).astype(np.uint8)
    ring = Image.fromarray(np.broadcast_to(ring_arr, (d, d, 3)).copy(), 'RGB')
    ringmask = Image.new('L', (d, d), 0)
    ImageDraw.Draw(ringmask).ellipse([1, 1, d - 2, d - 2], fill=255)
    ringmask = ringmask.filter(ImageFilter.GaussianBlur(d / 300))
    out.paste(ring, (0, 0), ringmask)

    # a thin dark inner groove between rim and art so the art reads as inset
    groove = Image.new('L', (d, d), 0)
    gw = max(2, int(d * 0.012))
    ImageDraw.Draw(groove).ellipse([off - gw, off - gw, off + inner + gw, off + inner + gw], fill=255)
    ImageDraw.Draw(groove).ellipse([off, off, off + inner, off + inner], fill=0)
    out = Image.composite(Image.new('RGBA', (d, d), (0, 0, 0, 255)), out,
                          groove.filter(ImageFilter.GaussianBlur(d / 600)))

    out.paste(art, (0, 0), disc)          # the token art on top, disc-masked
    # keep everything inside the coin
    coinmask = Image.new('L', (d, d), 0)
    ImageDraw.Draw(coinmask).ellipse([0, 0, d - 1, d - 1], fill=255)
    coinmask = coinmask.filter(ImageFilter.GaussianBlur(d / 500))
    out.putalpha(ImageChops.multiply(out.getchannel('A'), coinmask))
    return out


# ── stone substrate helpers (ported from compose-crest.py) ───────────────────────
def darken_stone(im):
    a = np.asarray(im).astype(np.float32)
    g = a.mean(2, keepdims=True)
    a = a * 0.4 + g * 0.6 * 0.4
    return Image.fromarray(np.clip(a * 0.55, 0, 255).astype(np.uint8), 'RGB')


def make_seamless(stone, size):
    s = darken_stone(stone.convert('RGB').resize((size, size), Image.LANCZOS))
    arr = np.asarray(s).astype(np.float32)
    rolled = np.roll(np.roll(arr, size // 2, 0), size // 2, 1)
    m = np.zeros((size, size), np.float32)
    band = size // 8
    m[size // 2 - band:size // 2 + band, :] = 1
    m[:, size // 2 - band:size // 2 + band] = 1
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(band / 2))) / 255.0
    out = arr * (1 - m[..., None]) + rolled * m[..., None]
    return Image.fromarray(out.astype(np.uint8), 'RGB')


def glow_layer(alpha, color, size, blur_div):
    g = alpha.filter(ImageFilter.GaussianBlur(size // blur_div))
    lay = Image.new('RGB', (size, size), (0, 0, 0))
    lay.paste(Image.new('RGB', (size, size), color), (0, 0), g)
    return lay


def to_normal(rgb_img, strength=2.2):
    h = np.asarray(ImageOps.grayscale(rgb_img)).astype(np.float32) / 255.0
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + nz * nz)
    out = np.stack([(-dx / ln + 1) * .5, (-dy / ln + 1) * .5, (nz / ln + 1) * .5], -1)
    return Image.fromarray(np.clip(out * 255, 0, 255).astype(np.uint8), 'RGB')


def build_flag(team):
    """Team banner cloth = the template's fabric luma x the brand colour + medallion."""
    cloth = Image.open(FLAG_TEMPLATE).convert('RGB').resize((S, S), Image.LANCZOS)
    luma = np.asarray(ImageOps.grayscale(cloth)).astype(np.float32) / 255.0
    # lift the luma so the banner colour reads bright, then multiply (keeps the folds)
    luma = 0.55 + 0.6 * luma
    base = np.array(team['banner'], np.float32)[None, None, :] * luma[..., None]
    banner = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

    med = medallion(os.path.join(EMB, team['logo']), team['rim_out'], team['rim_in'], int(S * 0.62))
    px = (S - med.width) // 2
    # RAISE the coin so it centres on the VISIBLE cloth, not the full texture. The flag
    # mesh's cloth UV centroid is V≈0.44 (measured from Prop_Flag.glb — the bottom ~12%
    # of the texture is the pole/tassel, not banner), so a coin centred at V=0.5 reads low.
    # Shift up by (0.5-0.44)=0.06 of the texture height.
    py = px - int(S * 0.06)
    # drop shadow so the coin sits proud of the cloth
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sh.paste(Image.new('RGBA', med.size, (0, 0, 0, 180)), (px, py + int(S * 0.012)), med.getchannel('A'))
    banner.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S / 120)))
    banner.alpha_composite(med, (px, py))
    banner.convert('RGB').resize((512, 512), Image.LANCZOS).save(team['flag_out'], 'WEBP', quality=90)
    print(f"  flag  -> {os.path.relpath(team['flag_out'], ROOT)}")


def build_sigil(team):
    """Coin set into the darkened seamless stone, with brand glow + inlay shadow."""
    med = medallion(os.path.join(EMB, team['logo']), team['rim_out'], team['rim_in'], int(S * 0.6))
    emb = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    px = (S - med.width) // 2
    emb.paste(med, (px, px), med)
    alpha = emb.getchannel('A')

    base = make_seamless(Image.open(STONE), S)
    # recessed inlay shadow under the coin
    contact = alpha.filter(ImageFilter.GaussianBlur(S // 90))
    base = Image.composite(Image.blend(base, Image.new('RGB', (S, S), (0, 0, 0)), 0.6), base, contact)
    base = ImageChops.screen(base, glow_layer(alpha, team['glow'], S, 22))   # outer bloom BEHIND the coin
    comp = base.convert('RGBA')
    comp.alpha_composite(emb)
    # NO screen pass over the coin itself — a photo medallion (WIF) washes out under it.
    # The outer bloom behind already sells the "powered sigil" read.

    name = team['sigil']
    comp.resize((512, 512), Image.LANCZOS).save(os.path.join(SIGILS, name + '.webp'), 'WEBP', quality=90)
    to_normal(comp).resize((512, 512), Image.LANCZOS).save(os.path.join(SIGILS, name + '_n.webp'), 'WEBP', quality=88)
    print(f"  sigil -> textures/{name}.webp (+_n)")


def main():
    for tname, team in TEAMS.items():
        print(tname.upper())
        build_flag(team)
        build_sigil(team)


if __name__ == '__main__':
    main()
