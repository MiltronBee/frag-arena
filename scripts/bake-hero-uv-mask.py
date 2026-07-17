# Bake per-region UV masks from the hero body GLB using vertex-group weights.
#
#   blender --background --python scripts/bake-hero-uv-mask.py -- <hero.glb> <out_mask.png>
#
# RGBA PNG (matches body texture res); colored by dominant bone group per face:
#   RED=head  BLUE=hands  GREEN=body/limbs  YELLOW=feet  BLACK=no-UV
import sys, os
import bpy
import numpy as np
from math import floor

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: --python bake-hero-uv-mask.py -- <hero.glb> <out_mask.png>"); sys.exit(1)
GLB, OUT = argv[0], argv[1]

TEX_W = TEX_H = 1024

REGION_HEAD = (1.0, 0.0, 0.0, 1.0)
REGION_HAND = (0.0, 0.0, 1.0, 1.0)
REGION_BODY = (0.0, 1.0, 0.0, 1.0)
REGION_FOOT = (1.0, 1.0, 0.0, 1.0)

BONE_MAP = [
    ("head", "H"), ("neck", "H"), ("face", "H"), ("jaw", "H"), ("eye", "H"), ("tongue", "H"),
    ("hand", "N"), ("thumb", "N"), ("index", "N"), ("middle", "N"), ("ring", "N"), ("pinky", "N"),
    ("finger", "N"),
    ("foot", "F"), ("ball", "F"), ("toe", "F"),
]

def region_for_bone(bone_name):
    b = bone_name.lower()
    for key, code in BONE_MAP:
        if key in b:
            return code
    return "B"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

body = None
for o in bpy.data.objects:
    if o.type == "MESH" and (body is None or len(o.data.vertices) > len(body.data.vertices)):
        body = o
if body is None:
    print("ERR: no mesh in GLB"); sys.exit(1)
print("body mesh:", body.name, "verts=", len(body.data.vertices))
print("vgroups:", [vg.name for vg in body.vertex_groups])

vg_region = {}
for vg in body.vertex_groups:
    vg_region[vg.index] = region_for_bone(vg.name)
print("region breakdown per vgroup:")
for vg in body.vertex_groups:
    print("  " + vg.name + " -> " + vg_region[vg.index])

vert_region = ["B"] * len(body.data.vertices)
for vi, v in enumerate(body.data.vertices):
    best_w = -1.0; best_code = "B"
    for g in v.groups:
        if g.weight > best_w and g.group in vg_region:
            best_w = g.weight; best_code = vg_region[g.group]
    vert_region[vi] = best_code

# use body texture resolution if larger than 1024
for img in bpy.data.images:
    if img.size[0] > TEX_W:
        TEX_W, TEX_H = img.size[0], img.size[1]
print("baking mask at", TEX_W, "x", TEX_H)

mesh = body.data
uv_layer = mesh.uv_layers.active
if uv_layer is None:
    print("ERR: no UV layer"); sys.exit(1)
uvs = uv_layer.data

pixels = np.zeros((TEX_H, TEX_W, 4), dtype=np.float32)

region_colors = {
    "H": REGION_HEAD, "N": REGION_HAND, "F": REGION_FOOT, "B": REGION_BODY,
}

def barycentric_fill(p0, p1, p2, r0, r1, r2):
    x0 = p0[0] * (TEX_W - 1); y0 = (1.0 - p0[1]) * (TEX_H - 1)
    x1 = p1[0] * (TEX_W - 1); y1 = (1.0 - p1[1]) * (TEX_H - 1)
    x2 = p2[0] * (TEX_W - 1); y2 = (1.0 - p2[1]) * (TEX_H - 1)
    minx = max(0, int(floor(min(x0, x1, x2))))
    maxx = min(TEX_W - 1, int(np.ceil(max(x0, x1, x2))))
    miny = max(0, int(floor(min(y0, y1, y2))))
    maxy = min(TEX_H - 1, int(np.ceil(max(y0, y1, y2))))
    denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if denom == 0: return
    c0 = region_colors[r0]; c1 = region_colors[r1]; c2 = region_colors[r2]
    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denom
            l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denom
            l2 = 1 - l0 - l1
            if l0 >= -0.0002 and l1 >= -0.0002 and l2 >= -0.0002:
                if l0 >= l1 and l0 >= l2: pixels[y, x] = c0
                elif l1 >= l2: pixels[y, x] = c1
                else: pixels[y, x] = c2

count = 0
for poly in mesh.polygons:
    li = poly.loop_indices
    verts = [mesh.loops[i].vertex_index for i in li]
    coords = [uvs[i].uv for i in li]
    for k in range(1, len(li) - 1):
        barycentric_fill(coords[0], coords[k], coords[k + 1],
                         vert_region[verts[0]], vert_region[verts[k]], vert_region[verts[k + 1]])
    count += 1
print("rasterized polys:", count)

img = bpy.data.images.new("hero_uv_mask", width=TEX_W, height=TEX_H, alpha=True)
img.pixels = pixels.reshape(-1).tolist()
img.filepath_raw = os.path.abspath(OUT)
img.file_format = "PNG"
img.save()
print("wrote mask", OUT)
