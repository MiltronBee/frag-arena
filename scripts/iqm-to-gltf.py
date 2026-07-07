#!/usr/bin/env python3
"""Minimal IQM -> glb converter: static bind-pose geometry + skin texture.
Enough to judge visual quality of Xonotic assets in our engine. Skeleton/animation
are intentionally out of scope for this prototype (that's the harder follow-up)."""
import struct, sys, io, json
import numpy as np
from PIL import Image
from pygltflib import (GLTF2, Scene, Node, Mesh, Primitive, Attributes, Buffer,
    BufferView, Accessor, Material, PbrMetallicRoughness, Texture, Image as GImage,
    Sampler, TextureInfo)

IQM, TGA, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(IQM, 'rb').read()

# header
magic = data[:16].rstrip(b'\x00')
assert magic == b'INTERQUAKEMODEL', magic
ver, filesize, flags = struct.unpack('<III', data[16:28])
H = struct.unpack('<24I', data[28:28+96])  # 24 uint32 header fields
(num_text, ofs_text, num_meshes, ofs_meshes,
 num_va, num_vertexes, ofs_va,
 num_tri, ofs_tri, ofs_adj,
 num_joints, ofs_joints,
 num_poses, ofs_poses,
 num_anims, ofs_anims,
 num_frames, num_fc, ofs_frames, ofs_bounds,
 num_comment, ofs_comment, num_ext, ofs_ext) = H

# meshes: name, material, first_vertex, num_vertexes, first_triangle, num_triangles
meshes = []
for i in range(num_meshes):
    off = ofs_meshes + i*24
    meshes.append(struct.unpack('<6I', data[off:off+24]))
total_verts = num_vertexes

# vertex arrays: type, flags, format, size, offset
VA = {}
for i in range(num_va):
    off = ofs_va + i*20
    vtype, vflags, vfmt, vsize, voff = struct.unpack('<5I', data[off:off+20])
    VA[vtype] = (vfmt, vsize, voff)

def read_float_array(vtype, comps):
    fmt, size, off = VA[vtype]
    assert fmt == 7 and size == comps, (vtype, fmt, size)  # 7 = FLOAT
    arr = np.frombuffer(data, dtype='<f4', count=total_verts*comps, offset=off)
    return arr.reshape(total_verts, comps).copy()

pos = read_float_array(0, 3)   # POSITION
uv  = read_float_array(1, 2)   # TEXCOORD
nrm = read_float_array(2, 3)   # NORMAL

# triangles (uint32 x3)
tris = np.frombuffer(data, dtype='<u4', count=num_tri*3, offset=ofs_tri).reshape(num_tri, 3)

# use mesh 0 (main body) only — mesh 1 is a fullbright shadow head we skip
m = meshes[0]
fv, nv, ft, nt = m[2], m[3], m[4], m[5]
prim_tris = tris[ft:ft+nt] - fv          # local indices
prim_pos = pos[fv:fv+nv]
prim_uv  = uv[fv:fv+nv]
prim_nrm = nrm[fv:fv+nv]

# IQM is Z-up right-handed; glTF is Y-up. Rotate -90deg about X: (x,y,z)->(x,z,-y)
def zup_to_yup(a):
    out = np.empty_like(a)
    out[:,0] = a[:,0]; out[:,1] = a[:,2]; out[:,2] = -a[:,1]
    return out
prim_pos = zup_to_yup(prim_pos)
prim_nrm = zup_to_yup(prim_nrm)
prim_uv[:,1] = 1.0 - prim_uv[:,1]         # flip V for glTF convention

# texture: TGA -> PNG bytes
img = Image.open(TGA).convert('RGBA')
png = io.BytesIO(); img.save(png, format='PNG'); png = png.getvalue()

# assemble a single glb binary blob
pos_b = prim_pos.astype('<f4').tobytes()
nrm_b = prim_nrm.astype('<f4').tobytes()
uv_b  = prim_uv.astype('<f4').tobytes()
idx_b = prim_tris.astype('<u4').tobytes()
def pad(b): return b + b'\x00'*((4 - len(b) % 4) % 4)
blob = pad(pos_b)+pad(nrm_b)+pad(uv_b)+pad(idx_b)+pad(png)
o_pos, o_nrm, o_uv, o_idx, o_png = 0, len(pad(pos_b)), len(pad(pos_b))+len(pad(nrm_b)), \
    len(pad(pos_b))+len(pad(nrm_b))+len(pad(uv_b)), len(pad(pos_b))+len(pad(nrm_b))+len(pad(uv_b))+len(pad(idx_b))

g = GLTF2()
g.scenes = [Scene(nodes=[0])]; g.scene = 0
g.nodes = [Node(mesh=0)]
g.buffers = [Buffer(byteLength=len(blob))]
g.bufferViews = [
    BufferView(buffer=0, byteOffset=o_pos, byteLength=len(pos_b), target=34962),
    BufferView(buffer=0, byteOffset=o_nrm, byteLength=len(nrm_b), target=34962),
    BufferView(buffer=0, byteOffset=o_uv,  byteLength=len(uv_b),  target=34962),
    BufferView(buffer=0, byteOffset=o_idx, byteLength=len(idx_b), target=34963),
    BufferView(buffer=0, byteOffset=o_png, byteLength=len(png)),
]
mn = prim_pos.min(axis=0).tolist(); mx = prim_pos.max(axis=0).tolist()
g.accessors = [
    Accessor(bufferView=0, componentType=5126, count=nv, type='VEC3', min=mn, max=mx),
    Accessor(bufferView=1, componentType=5126, count=nv, type='VEC3'),
    Accessor(bufferView=2, componentType=5126, count=nv, type='VEC2'),
    Accessor(bufferView=3, componentType=5125, count=len(prim_tris)*3, type='SCALAR'),
]
g.images = [GImage(bufferView=4, mimeType='image/png')]
g.samplers = [Sampler(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497)]
g.textures = [Texture(source=0, sampler=0)]
g.materials = [Material(
    pbrMetallicRoughness=PbrMetallicRoughness(
        baseColorTexture=TextureInfo(index=0), metallicFactor=0.0, roughnessFactor=1.0),
    emissiveTexture=TextureInfo(index=0), emissiveFactor=[0.35,0.35,0.35], name='erebus')]
g.meshes = [Mesh(primitives=[Primitive(
    attributes=Attributes(POSITION=0, NORMAL=1, TEXCOORD_0=2), indices=3, material=0)])]
g.set_binary_blob(blob)
g.save_binary(OUT)
print(f'wrote {OUT}: verts={nv} tris={len(prim_tris)} tex={img.size} bytes={len(blob)}')
