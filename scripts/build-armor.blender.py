"""Draft Saint Seiya-style "Cloth" armor pieces for the Degen Tournament soldier.

Builds 4 GLB props (public/assets/props/) that CharacterModel mounts on skeleton bones,
exactly like the helmet mounts on the Head bone:
  armor_chest.glb    breastplate w/ central ridge + gem + collar   -> spine_03
  armor_pauldron.glb layered 3-plate shoulder + swept fin          -> clavicle_l / _r
  armor_elbow.glb    domed cap + ridge fin                         -> lowerarm_l / _r
  armor_knee.glb     domed cap + ridge fin (bigger)                -> calf_l / _r

Saint Seiya "Cloth" language: layered curved metal plates, raised ridges, swept fins,
a central gem. Bronze-gold metal + a Solana-violet emissive gem. Authored at ~real human
scale (metres) so the mount just needs a modest scale like the helmet's 0.85.

  blender -b -P scripts/build-armor.blender.py
"""
import bpy, bmesh, math, os
from mathutils import Vector

OUT = os.path.expanduser('~/unreal/public/assets/props')
os.makedirs(OUT, exist_ok=True)

GOLD = (0.82, 0.63, 0.24, 1.0)     # bronze-gold cloth
TRIM = (0.30, 0.22, 0.09, 1.0)     # dark recess trim
GEM = (0.60, 0.27, 1.0, 1.0)       # Solana violet #9945FF


def _mat(name, rgba, metal=1.0, rough=0.28, emit=None, emit_str=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = rgba
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit is not None:
        b.inputs['Emission Color'].default_value = emit
        if 'Emission Strength' in b.inputs:
            b.inputs['Emission Strength'].default_value = emit_str
    return m


def _new(name):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob, bmesh.new()


def _finish(ob, bm, mat, bevel=0.006, seg=2):
    bm.to_mesh(ob.data); bm.free()
    ob.data.materials.append(mat)
    md = ob.modifiers.new('bev', 'BEVEL'); md.width = bevel; md.segments = seg
    md = ob.modifiers.new('sub', 'SUBSURF'); md.levels = 1; md.render_levels = 1
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def dome(bm, center, radius, flat, cut_z=0.0, mat_offset=Vector((0, 0, 0))):
    """A flattened hemisphere shell (an armour plate)."""
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=2, radius=radius)
    for v in tmp.verts:
        v.co.z *= flat
    # keep the top cap (z above cut)
    bmesh.ops.delete(tmp, geom=[v for v in tmp.verts if v.co.z < cut_z], context='VERTS')
    for v in tmp.verts:
        v.co += Vector(center)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    verts = [bm.verts.new(v.co) for v in tmp.verts]
    for f in tmp.faces:
        try: bm.faces.new([verts[v.index] for v in f.verts])
        except ValueError: pass
    tmp.free()


def box(bm, center, size, rot=None):
    m = bmesh.new()
    bmesh.ops.create_cube(m, size=1.0)
    for v in m.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    if rot:
        import mathutils
        R = mathutils.Euler(rot, 'XYZ').to_matrix()
        for v in m.verts:
            v.co = R @ v.co
    for v in m.verts:
        v.co += Vector(center)
    verts = [bm.verts.new(v.co) for v in m.verts]
    bmesh.ops.recalc_face_normals(m, faces=m.faces)
    for f in m.faces:
        try: bm.faces.new([verts[v.index] for v in f.verts])
        except ValueError: pass
    m.free()


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB',
                              export_apply=True, export_yup=True)
    print('wrote', path)
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


gold = _mat('ArmorGold', GOLD)
trim = _mat('ArmorTrim', TRIM, rough=0.5)
gem = _mat('ArmorGem', GEM, metal=0.0, rough=0.1, emit=GEM, emit_str=6.0)


def build_pauldron():
    # 3 stacked curved plates (decreasing) + a swept fin = the Saint Seiya shoulder
    ob, bm = _new('pauldron')
    dome(bm, (0, 0, 0.00), 0.150, 0.78)                 # base plate
    dome(bm, (0, -0.020, 0.045), 0.112, 0.82)           # mid plate (shifted forward+up)
    dome(bm, (0, -0.038, 0.082), 0.076, 0.85)           # top plate
    _finish(ob, bm, gold, bevel=0.004)
    # a swept fin rising off the top-back
    fin, fbm = _new('paul_fin')
    box(fbm, (0, 0.06, 0.10), (0.02, 0.05, 0.11), rot=(math.radians(28), 0, 0))
    _finish(fin, fbm, gold, bevel=0.006)
    # a violet gem set in the top plate
    g, gbm = _new('paul_gem')
    dome(gbm, (0, -0.038, 0.100), 0.026, 1.0)
    _finish(g, gbm, gem, bevel=0.002)
    export([ob, fin, g], os.path.join(OUT, 'armor_pauldron.glb'))


def build_chest():
    ob, bm = _new('chest')
    # breastplate: a wide flattened dome curved to the torso
    dome(bm, (0, -0.02, 0), 0.20, 0.62)
    # two pectoral bulges
    dome(bm, (0.078, -0.05, 0.02), 0.082, 0.75)
    dome(bm, (-0.078, -0.05, 0.02), 0.082, 0.75)
    # central vertical ridge
    box(bm, (0, -0.11, 0.0), (0.018, 0.02, 0.16))
    # collar ridge across the top
    box(bm, (0, -0.06, 0.15), (0.13, 0.02, 0.02))
    _finish(ob, bm, gold, bevel=0.005)
    # central gem near the sternum top
    g, gbm = _new('chest_gem')
    dome(gbm, (0, -0.13, 0.075), 0.028, 1.0)
    _finish(g, gbm, gem, bevel=0.002)
    export([ob, g], os.path.join(OUT, 'armor_chest.glb'))


def build_cap(name, radius, fin_len):
    ob, bm = _new(name)
    dome(bm, (0, 0, 0), radius, 0.9)                      # domed cap
    dome(bm, (0, 0, radius * 0.34), radius * 0.62, 0.9)   # raised second tier
    box(bm, (0, -radius * 0.7, radius * 0.2), (radius * 0.28, fin_len, radius * 0.22),
        rot=(math.radians(-35), 0, 0))                     # forward ridge fin
    _finish(ob, bm, gold, bevel=0.004)
    export([ob], os.path.join(OUT, f'armor_{name}.glb'))


build_pauldron()
build_chest()
build_cap('elbow', 0.070, 0.055)
build_cap('knee', 0.092, 0.065)
print('ALL ARMOR PIECES BUILT')
