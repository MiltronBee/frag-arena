#!/usr/bin/env python3
"""Derive a tangent-space normal map from an albedo texture (Sobel height->normal).

The standard cheap path when no scanned normal exists: read the albedo luminance
as a heightfield, take its gradient, and encode the surface normal. Good on
stone/rock/concrete where luminance tracks relief (dark = crevice, light =
raised). Wraps the gradient so the normal map tiles exactly like its albedo.

  python3 scripts/derive-normal.py <albedo.webp|png> <out.webp> [strength]
"""
import sys
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
strength = float(sys.argv[3]) if len(sys.argv) > 3 else 2.2

im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(np.float32) / 255.0
lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]

# wrapped central differences (mode='wrap' keeps the normal map seamless-tiling)
dx = (np.roll(lum, -1, 1) - np.roll(lum, 1, 1)) * 0.5
dy = (np.roll(lum, -1, 0) - np.roll(lum, 1, 0)) * 0.5

nx = -dx * strength
ny = -dy * strength
nz = np.ones_like(lum)
inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
nx *= inv; ny *= inv; nz *= inv

# encode [-1,1] -> [0,255]; Babylon tangent-space convention (Y up)
enc = np.dstack([(nx * 0.5 + 0.5), (ny * 0.5 + 0.5), (nz * 0.5 + 0.5)])
Image.fromarray((enc * 255).astype(np.uint8), 'RGB').save(out, 'WEBP', quality=90)
print(f'wrote {out}  strength={strength}  from {im.size} albedo')
