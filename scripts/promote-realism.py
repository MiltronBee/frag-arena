#!/usr/bin/env python3
"""Promote realism upscales into the live CTF-Visage texture set.

Copies each candidates/<mat>/remaster-real.webp over the shipping texture the
MTL actually references (read from the MTL, not assumed from the name). Only
materials that HAVE a remaster-real are touched — the crests/sign/medallion
(pending user pick) and FX/skybox (never generated) keep their current art.

Backs up the whole textures/ dir first. Originals are also git-tracked, so this
is doubly reversible. No bundle rebuild / server restart needed downstream —
these are static assets.

  python3 scripts/promote-realism.py [--dry]
"""
import os, sys, shutil, subprocess

ROOT = os.path.expanduser('~/unreal')
MAPDIR = os.path.join(ROOT, 'public/assets/maps/CTF-Visage')
MTL = os.path.join(MAPDIR, 'CTF-Visage.mtl')
CANDS = os.path.join(ROOT, 'public/textures/candidates')
DRY = '--dry' in sys.argv

# material -> texture relpath, straight from the MTL
mats, cur = {}, None
for line in open(MTL):
    if line.startswith('newmtl '):
        cur = line.split(None, 1)[1].strip()
    elif line.startswith('map_Kd ') and cur:
        mats[cur] = line.split(None, 1)[1].strip()

promote = []
for mat, rel in mats.items():
    src = os.path.join(CANDS, mat, 'remaster-real.webp')
    if os.path.exists(src):
        promote.append((mat, src, os.path.join(MAPDIR, rel)))

print(f'{len(promote)} of {len(mats)} materials have a realism upscale to promote')
skipped = sorted(set(mats) - {m for m, _, _ in promote})
print(f'untouched ({len(skipped)}): {", ".join(skipped)}\n')

if DRY:
    tot_old = tot_new = 0
    for mat, src, dst in promote:
        o = os.path.getsize(dst) if os.path.exists(dst) else 0
        n = os.path.getsize(src)
        tot_old += o; tot_new += n
        print(f'  {mat:30} {o/1024:6.1f}KB -> {n/1024:6.1f}KB')
    print(f'\ntextures total: {tot_old/1024:.0f}KB -> {tot_new/1024:.0f}KB (promoted files only)')
    sys.exit(0)

# backup the whole textures dir
ts = subprocess.check_output(['date', '+%Y%m%d-%H%M%S']).decode().strip()
bak = os.path.join(ROOT, 'backups', f'visage-tex-prerealism-{ts}')
shutil.copytree(os.path.join(MAPDIR, 'textures'), bak)
print(f'backed up -> {bak}\n')

for mat, src, dst in promote:
    shutil.copyfile(src, dst)
    print(f'  promoted {mat}')

# report new payload
tot = sum(os.path.getsize(os.path.join(MAPDIR, 'textures', f))
          for f in os.listdir(os.path.join(MAPDIR, 'textures')))
print(f'\n{len(promote)} promoted. textures/ now {tot/1024:.0f}KB total.')
