#!/usr/bin/env python3
# Uniform v2 post-processor: turns raw Gemini repaint(s) into the shipped team
# albedo + normal atlas, enforcing the "banger brief" value hierarchy. Called by
# scripts/gemini-uniform-texture.mjs (--v2); not meant to be run by hand, but the
# whole config comes in as one JSON arg so it is trivially reproducible.
#
# Pipeline (all garment-only; skin/face pixels stay == the resampled original,
# so the composite can never touch the face):
#   1. garment mask   = original atlas max(r,g,b) < 100  (skin is >=140 red)
#   2. zone composite = Gemini "base" repaint over the whole garment; optional
#                       "chest" repaint feathered into the chest box only.
#   3. value gradient = brief S1 "dark feet -> bright chest": multiply garment
#                       RGB up in the chest box, down in the boot boxes (feathered).
#   4. accent manage  = brief S1 "ONE dominant chest splash, quiet legs": detect
#                       team-accent-hued pixels; boost saturation in the chest box,
#                       mute it everywhere else.
#   5. warm/cool tint = brief S2 TF2 rule: nudge the neutral charcoal base warm
#                       (red team) or cool (blue team); accents left pure.
#   6. normal map     = DeepBump color_to_normals on the FINISHED albedo, composited
#                       over the original GLB normal (face relief preserved).
#   7. relight bake   = brief S3 "bake the normal's shading into the albedo ~35%":
#                       Lambert shade from a fixed top-left key, applied as a
#                       multiply normalised to 1.0 on flat surfaces (exact formula
#                       at _bake_relight below) so crevices darken / plates catch
#                       light even where the map is dark.
#
# Fallback: if the DeepBump dir / onnxruntime is unavailable, a Sobel height->normal
# is used instead and reported on stderr (still ships a real normal + bake).
import sys, json, os, math
import numpy as np
from PIL import Image, ImageFilter

cfg = json.loads(sys.argv[1])
SIZE = cfg.get('size', 1024)

def load_rgb(p):
    return np.asarray(Image.open(p).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32)

orig = load_rgb(cfg['orig'])
base = load_rgb(cfg['gens'][0])

# ---- 1. garment mask (feathered) ------------------------------------------
garment_hard = (orig.max(axis=2) < 100).astype(np.float32)
garment = np.asarray(Image.fromarray((garment_hard * 255).astype(np.uint8), 'L')
                     .filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255.0
gm = garment[..., None]

def box_mask(box, feather):
    """feathered 0..1 mask for a normalized [x0,y0,x1,y1] box (garment-clipped later)."""
    m = np.zeros((SIZE, SIZE), np.float32)
    x0, y0, x1, y1 = [int(round(v * SIZE)) for v in box]
    m[y0:y1, x0:x1] = 1.0
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8), 'L')
                   .filter(ImageFilter.GaussianBlur(feather))).astype(np.float32) / 255.0
    return m

# ---- 2. zone composite ----------------------------------------------------
# base Gemini repaint over ALL garment; optional chest repaint over chest box.
albedo = orig * (1 - gm) + base * gm
chest_box = cfg.get('chestBox')
if len(cfg['gens']) > 1 and cfg['gens'][1] and chest_box:
    chest = load_rgb(cfg['gens'][1])
    cmask = (box_mask(chest_box, 40) * garment)[..., None]
    albedo = albedo * (1 - cmask) + chest * cmask
    print('[bake] chest zone repaint composited', file=sys.stderr)

# ---- HSV helpers (vectorised) ---------------------------------------------
def rgb_to_hsv(a):
    r, g, b = a[..., 0] / 255, a[..., 1] / 255, a[..., 2] / 255
    mx = np.max(a, axis=2) / 255; mn = np.min(a, axis=2) / 255
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    idx = (mx == r/1) & nz
    # compute per-channel-max hue
    rmax = (a[..., 0] >= a[..., 1]) & (a[..., 0] >= a[..., 2]) & nz
    gmax = (a[..., 1] > a[..., 0]) & (a[..., 1] >= a[..., 2]) & nz
    bmax = (a[..., 2] > a[..., 0]) & (a[..., 2] > a[..., 1]) & nz
    h[rmax] = ((g - b)[rmax] / d[rmax]) % 6
    h[gmax] = ((b - r)[gmax] / d[gmax]) + 2
    h[bmax] = ((r - g)[bmax] / d[bmax]) + 4
    h = (h * 60) % 360
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    v = mx
    return h, s, v

def hsv_to_rgb(h, s, v):
    c = v * s
    x = c * (1 - np.abs((h / 60) % 2 - 1))
    m = v - c
    z = np.zeros_like(h)
    cond = [(h < 60), (h < 120), (h < 180), (h < 240), (h < 300), (h >= 300)]
    r = np.select(cond, [c, x, z, z, x, c])
    g = np.select(cond, [x, c, c, x, z, z])
    b = np.select(cond, [z, z, x, c, c, x])
    return np.stack([(r + m), (g + m), (b + m)], axis=2) * 255

# ---- 3. value gradient (dark feet -> bright chest) ------------------------
factor = np.ones((SIZE, SIZE), np.float32)
if chest_box:
    factor += box_mask(chest_box, 60) * garment * (cfg.get('chestBright', 0.14))
for bb in cfg.get('bootBoxes', []):
    factor -= box_mask(bb, 50) * garment * (cfg.get('bootDark', 0.18))
albedo = np.clip(albedo * factor[..., None], 0, 255)

# ---- 4. accent management (one dominant chest splash, quiet legs) ---------
hlo, hhi = cfg['accentHueRange']
h, s, v = rgb_to_hsv(albedo)
if hlo <= hhi:
    hue_ok = (h >= hlo) & (h <= hhi)
else:  # red wraps past 360/0
    hue_ok = (h >= hlo) | (h <= hhi)
accent = (hue_ok & (s > 0.18) & (v > 0.12)).astype(np.float32) * garment
if chest_box:
    inchest = box_mask(chest_box, 50) * garment
else:
    inchest = np.zeros_like(garment)
offchest = np.clip(1 - inchest, 0, 1)
# boost accent saturation on the chest, mute it elsewhere
s2 = s.copy()
s2 = s2 * (1 + accent * inchest * 0.35)          # chest splash: +35% sat
s2 = s2 * (1 - accent * offchest * 0.55)         # quiet legs: -55% sat
s2 = np.clip(s2, 0, 1)
v2 = v * (1 + accent * inchest * 0.06)            # tiny chest value lift
v2 = np.clip(v2, 0, 1)
albedo = np.clip(hsv_to_rgb(h, s2, v2), 0, 255)

# ---- 5. warm/cool base tint (neutral charcoal only) ----------------------
h, s, v = rgb_to_hsv(albedo)
neutral = ((s < 0.22).astype(np.float32)) * garment
neutral_b = neutral[..., None]
if cfg['baseShift'] == 'warm':
    tint = np.array([9., 1., -9.], np.float32)
else:
    tint = np.array([-8., -1., 11.], np.float32)
albedo = np.clip(albedo + neutral_b * tint, 0, 255)

# keep a copy of the FINISHED albedo (pre-bake) — DeepBump reads this
albedo_finished = albedo.copy()

# ---- 6. normal map from finished albedo -----------------------------------
def deepbump_normal(rgb):
    dd = cfg.get('deepbumpDir')
    if not dd or not os.path.isdir(dd):
        raise RuntimeError('no deepbump dir')
    sys.path.insert(0, dd)
    import module_color_to_normals as mcn
    chw = np.transpose(rgb / 255.0, (2, 0, 1)).astype(np.float32)
    out = mcn.apply(chw, 'SMALL', None)          # C,H,W in 0..1
    return np.transpose(out, (1, 2, 0))          # H,W,C 0..1

def sobel_normal(rgb, strength=2.0):
    g = rgb.mean(axis=2) / 255.0
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = (g[:, 2:] - g[:, :-2]) * 0.5
    gy[1:-1, :] = (g[2:, :] - g[:-2, :]) * 0.5
    nx = -gx * strength; ny = -gy * strength; nz = np.ones_like(g)
    ln = np.sqrt(nx*nx + ny*ny + nz*nz)
    return np.stack([nx/ln, ny/ln, nz/ln], axis=2) * 0.5 + 0.5

normal_src = 'deepbump'
try:
    nrm = deepbump_normal(albedo_finished)
except Exception as e:
    print(f'[bake] DeepBump unavailable ({e}); Sobel normal fallback', file=sys.stderr)
    nrm = sobel_normal(albedo_finished)
    normal_src = 'sobel'

# composite garment normal over the ORIGINAL GLB normal (face relief preserved)
orig_n = np.asarray(Image.open(cfg['origNormal']).convert('RGB')
                    .resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255.0
normal = orig_n * (1 - gm) + nrm * gm

# ---- 7. relight bake into albedo (~35%) -----------------------------------
def _bake_relight(alb, nmap, strength=0.35):
    """Lambert relight from a fixed top-left key, composited as a MULTIPLY that
    is normalised to 1.0 on a flat (n=[0,0,1]) surface, so only relief deviates:
        n     = 2*nmap - 1                     (OpenGL/glTF +Y convention)
        L     = normalize([-0.6, 0.7, 0.65])   (top-left, slightly toward viewer)
        shade = ambient + (1-ambient)*max(dot(n,L),0)    ambient=0.55
        flat  = shade for n=[0,0,1]  == ambient + (1-ambient)*Lz
        factor= (1-strength) + strength*(shade/flat)     == 1.0 where flat
        out   = clip(alb * factor)
    Plates facing the key brighten, seams/crevices darken; flat cloth unchanged."""
    n = nmap * 2 - 1
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
    L = np.array([-0.6, 0.7, 0.65], np.float32); L /= np.linalg.norm(L)
    ambient = 0.55
    ndl = np.clip((n * L).sum(axis=2), 0, 1)
    shade = ambient + (1 - ambient) * ndl
    flat = ambient + (1 - ambient) * L[2]
    factor = (1 - strength) + strength * (shade / flat)
    return np.clip(alb * factor[..., None], 0, 255)

# bake garment only (skin factor forced to 1 so face stays == original)
baked = _bake_relight(albedo_finished, normal)
albedo = albedo_finished * (1 - gm) + baked * gm

# ---- save -----------------------------------------------------------------
Image.fromarray(albedo.astype(np.uint8), 'RGB').save(cfg['outAlbedo'], 'WEBP', quality=92, method=6)
Image.fromarray((normal * 255).astype(np.uint8), 'RGB').save(cfg['outNormal'], 'WEBP', quality=92, method=6)
print(json.dumps({'albedo': cfg['outAlbedo'], 'normal': cfg['outNormal'],
                  'normalSource': normal_src, 'chestRepaint': len(cfg['gens']) > 1}))
