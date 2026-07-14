#!/usr/bin/env python3
"""Inspect a player-character GLB: skeleton, animation clips, bounds, fit numbers.

Usage: python3 scripts/verify-player-glb.py public/assets/characters/foo.glb

Prints skeleton presence, every animation clip with duration, world-ish mesh
bounds from accessor min/max, and the scale/yOffset that stand the model
~1.05 units tall in the 1-unit collision box (origin-centered, y -0.5..+0.5).
"""
import json
import struct
import sys


def read_glb(path):
    with open(path, 'rb') as f:
        magic, version, _length = struct.unpack('<4sII', f.read(12))
        if magic != b'glTF':
            sys.exit(f'{path}: not a GLB (magic={magic!r})')
        chunk_len, chunk_type = struct.unpack('<II', f.read(8))
        if chunk_type != 0x4E4F534A:  # JSON
            sys.exit(f'{path}: first chunk is not JSON')
        return json.loads(f.read(chunk_len))


def main():
    path = sys.argv[1]
    gltf = read_glb(path)

    skins = gltf.get('skins', [])
    print(f'skeleton: {"YES" if skins else "NO"} '
          f'({len(skins)} skin(s), {sum(len(s.get("joints", [])) for s in skins)} joints)')

    accessors = gltf.get('accessors', [])
    anims = gltf.get('animations', [])
    print(f'animations: {len(anims)}')
    for a in anims:
        dur = 0.0
        for s in a.get('samplers', []):
            inp = accessors[s['input']]
            dur = max(dur, (inp.get('max') or [0])[0])
        print(f'  - {a.get("name", "<unnamed>")!r}  {dur:.2f}s')

    # bounds from POSITION accessors (bind pose, node transforms ignored — fine
    # for feet-origin humanoids exported without extra root scaling)
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    for m in gltf.get('meshes', []):
        for p in m.get('primitives', []):
            acc = accessors[p['attributes']['POSITION']]
            for i in range(3):
                lo[i] = min(lo[i], acc['min'][i])
                hi[i] = max(hi[i], acc['max'][i])
    print(f'bounds min: {[round(v, 3) for v in lo]}')
    print(f'bounds max: {[round(v, 3) for v in hi]}')

    height = hi[1] - lo[1]
    if height > 0:
        scale = 1.05 / height
        # after scaling, drop the (scaled) model bottom to the box bottom (-0.5)
        y_offset = -0.5 - lo[1] * scale
        print(f'raw height: {height:.3f}')
        print(f'suggested scale: {scale:.4f}')
        print(f'suggested yOffset: {y_offset:.3f}')


if __name__ == '__main__':
    main()
