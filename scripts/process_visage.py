#!/usr/bin/env python3
# Isolate the CTF-Visage (Facing Worlds) PLAY area from the UT skybox scene,
# convert its textures to web WebP, and rewrite the MTL. The exported OBJ dumps
# the whole skybox (nebula box + distant SkyCity/cathedral/moon/ship backdrop)
# far from the compact bowtie play area, using ordinary wall textures — so we
# separate SPATIALLY (face-centroid inside the play box), not by material name.
import os, sys
from PIL import Image

SRC_OBJ = os.path.expanduser('~/unreal/maps/improved/CTF-Visage.obj')
SRC_MTL = os.path.expanduser('~/unreal/maps/improved/CTF-Visage.mtl')
SRC_TEX = os.path.expanduser('~/unreal/maps/improved/textures_hd')
OUT_DIR = os.path.expanduser('~/unreal/public/assets/maps/CTF-Visage')
OUT_TEX = os.path.join(OUT_DIR, 'textures')
os.makedirs(OUT_TEX, exist_ok=True)

# Play-area box in native OBJ coords (Z-up, unrotated), from the cluster analysis.
BOX = dict(x=(-80, 170), y=(-300, 60), z=(-95, 30))

# ---- parse OBJ ----
V = []
lines = open(SRC_OBJ).read().splitlines()
for ln in lines:
    if ln.startswith('v '):
        p = ln.split(); V.append((float(p[1]), float(p[2]), float(p[3])))

def centroid(face_tokens):
    xs = ys = zs = 0.0; n = 0
    for t in face_tokens:
        i = int(t.split('/')[0]) - 1
        x, y, z = V[i]; xs += x; ys += y; zs += z; n += 1
    return xs/n, ys/n, zs/n

def inbox(c):
    return (BOX['x'][0] <= c[0] <= BOX['x'][1] and
            BOX['y'][0] <= c[1] <= BOX['y'][1] and
            BOX['z'][0] <= c[2] <= BOX['z'][1])

# ---- emit play-only OBJ ----
out = []
cur = None            # current material as we scan
emitted_mtl = None    # last usemtl written to output
kept_mats = set()
kept_faces = 0
skybox_faces = 0
kept_face_idx = []    # for bounds recompute
for ln in lines:
    if ln.startswith('mtllib'):
        out.append('mtllib CTF-Visage.mtl'); continue
    if ln.startswith(('v ', 'vt ', 'vn ')):
        out.append(ln); continue
    if ln.startswith('usemtl '):
        cur = ln.split(None, 1)[1].strip(); continue
    if ln.startswith('f '):
        toks = ln.split()[1:]
        if inbox(centroid(toks)):
            if emitted_mtl != cur:
                out.append('usemtl ' + cur); emitted_mtl = cur
            out.append(ln); kept_mats.add(cur); kept_faces += 1
            kept_face_idx.append([int(t.split('/')[0]) - 1 for t in toks])
        else:
            skybox_faces += 1
        continue
    # drop o/g/s and anything else

open(os.path.join(OUT_DIR, 'CTF-Visage.obj'), 'w').write('\n'.join(out) + '\n')
print(f'OBJ: kept {kept_faces} play faces, dropped {skybox_faces} skybox/backdrop faces')
print(f'materials used by play mesh: {len(kept_mats)}')

# play bounds
import statistics
xs = [V[i][0] for f in kept_face_idx for i in f]
ys = [V[i][1] for f in kept_face_idx for i in f]
zs = [V[i][2] for f in kept_face_idx for i in f]
print('PLAY bounds native: x[%.0f,%.0f] y[%.0f,%.0f] z[%.0f,%.0f]' %
      (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))

# ---- parse source MTL into blocks ----
blocks = {}
name = None; buf = []
for ln in open(SRC_MTL):
    if ln.startswith('newmtl '):
        if name: blocks[name] = buf
        name = ln.split(None, 1)[1].strip(); buf = [ln.rstrip('\n')]
    elif name:
        buf.append(ln.rstrip('\n'))
if name: blocks[name] = buf

# ---- convert textures for kept mats + rewrite MTL ----
mtl_out = ['# CTF-Visage play mesh (skybox stripped) — web textures']
converted = 0; missing = []
for m in sorted(kept_mats):
    blk = blocks.get(m)
    if not blk:
        mtl_out += ['', 'newmtl ' + m, 'Kd 0.8 0.8 0.8']; continue
    new_blk = []
    for line in blk:
        if line.startswith('map_Kd'):
            src_name = os.path.basename(line.split()[-1])          # e.g. Foo.png
            stem = os.path.splitext(src_name)[0]
            src = os.path.join(SRC_TEX, src_name)
            dst = os.path.join(OUT_TEX, stem + '.webp')
            if os.path.exists(src):
                if not os.path.exists(dst):
                    im = Image.open(src).convert('RGB')
                    im.thumbnail((512, 512), Image.LANCZOS)
                    im.save(dst, 'WEBP', quality=80, method=6)
                    converted += 1
                new_blk.append('map_Kd textures/%s.webp' % stem)
            else:
                missing.append(src_name)
        else:
            new_blk.append(line)
    mtl_out.append(''); mtl_out += new_blk

open(os.path.join(OUT_DIR, 'CTF-Visage.mtl'), 'w').write('\n'.join(mtl_out) + '\n')
print(f'textures: converted {converted} new WebP into {OUT_TEX}')
if missing:
    print('MISSING source textures:', missing[:10], '...' if len(missing) > 10 else '')
