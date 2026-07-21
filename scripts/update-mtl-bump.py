#!/usr/bin/env python3
"""Wire derived normal maps into the CTF-Visage MTL via `map_bump`.

Babylon's MTLFileLoader reads `map_bump [-bm <level>] <file>` and assigns it as
StandardMaterial.bumpTexture at OBJ load — so normals ship as a pure asset+MTL
change, no renderer code and no bundle rebuild. The server strips `mtllib`
(GameInstance.js) so this never reaches collision.

For each material whose map_Kd texture X.webp has a sibling X_n.webp, insert a
map_bump line right after the map_Kd. Idempotent: skips materials that already
have a map_bump.

  python3 scripts/update-mtl-bump.py [--level 1.2] [--dry]
"""
import os, sys

ROOT = os.path.expanduser('~/unreal')
MTL = os.path.join(ROOT, 'public/assets/maps/CTF-Visage/CTF-Visage.mtl')
TEXDIR = os.path.join(ROOT, 'public/assets/maps/CTF-Visage')
LEVEL = '1.2'
if '--level' in sys.argv:
    LEVEL = sys.argv[sys.argv.index('--level') + 1]
DRY = '--dry' in sys.argv

lines = open(MTL).read().splitlines()
out, added, skipped = [], [], []
i = 0
# track whether the current material block already has a map_bump
block_has_bump = False
cur = None


def block_lines(idx):
    """the raw lines belonging to the current newmtl block, to test for map_bump"""
    j = idx
    while j < len(lines) and not lines[j].startswith('newmtl '):
        j += 1
    return None


for idx, line in enumerate(lines):
    out.append(line)
    if line.startswith('newmtl '):
        cur = line.split(None, 1)[1].strip()
    elif line.startswith('map_Kd ') and cur:
        rel = line.split(None, 1)[1].strip()          # textures/X.webp
        base, ext = os.path.splitext(rel)
        nrel = base + '_n' + ext                        # textures/X_n.webp
        # already wired? scan the rest of this block
        rest = []
        k = idx + 1
        while k < len(lines) and not lines[k].startswith('newmtl '):
            rest.append(lines[k]); k += 1
        if any(r.strip().startswith(('map_bump', 'map_Bump', 'bump')) for r in rest):
            skipped.append((cur, 'already has bump')); continue
        if not os.path.exists(os.path.join(TEXDIR, nrel)):
            skipped.append((cur, 'no normal map')); continue
        out.append(f'map_bump -bm {LEVEL} {nrel}')
        added.append(cur)

print(f'add map_bump to {len(added)} materials (level {LEVEL})')
for c, why in skipped:
    print(f'  skip {c}: {why}')
if DRY:
    sys.exit(0)
open(MTL, 'w').write('\n'.join(out) + '\n')
print(f'\nwrote {MTL}')
