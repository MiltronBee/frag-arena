"""Re-export helmet #0 as a two-tone GLB: charcoal shell + glossy near-black pods.

Reproduces the ORIGINAL helmet_0.glb coordinate frame exactly (mesh centered at
origin, +Y up, single node) so the tuned mount transform in assetManifest.js
(scale 0.8, pos y 0.04, rot 0) still holds. Only the materials change: the shell
(object 'Helmet') and the twin jaw pods ('Sphere.001/.002') get separate slots,
so glTF exports two primitives and Babylon imports two submeshes under one root.

Materials are DIELECTRIC (metallic 0) on purpose: the arena scene has no IBL/env
texture, so metals would render near-black. Low roughness gives the sheen via the
directional sun's specular while the hemispheric ambient keeps the charcoal diffuse.

GOTCHA (see memory retro-shotgun-pistol-quirks / character-clothing): the source
meshes carry a MIRROR modifier — convert(target='MESH') applies it (and the geo
nodes) so we export the full mirrored helmet, not half.
"""
import bpy

OUT = '/home/miltron/unreal/public/assets/props/helmet_0.glb'
SHELL = (0.051, 0.055, 0.067, 1.0); SH_MET = 0.0; SH_RGH = 0.34
POD   = (0.020, 0.020, 0.024, 1.0); PD_MET = 0.0; PD_RGH = 0.10

TRIO = ['Helmet', 'Sphere.001', 'Sphere.002']
PODS = ['Sphere.001', 'Sphere.002']

def mat(name, base, met, rough):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = base
    b.inputs['Metallic'].default_value = met
    b.inputs['Roughness'].default_value = rough
    m.use_backface_culling = False           # -> doubleSided in glTF (matches original)
    return m

shell = mat('HelmetShell', SHELL, SH_MET, SH_RGH)
pod   = mat('HelmetPod',   POD,   PD_MET, PD_RGH)

# assign materials + bake modifiers (MIRROR + geo NODES) on each trio member
bpy.ops.object.select_all(action='DESELECT')
for name in TRIO:
    o = bpy.data.objects[name]
    o.data.materials.clear()
    o.data.materials.append(pod if name in PODS else shell)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')     # applies all modifiers
    o.select_set(False)

# Center on the SHELL's bounds (NOT the trio's) so the shell primitive lands on the
# exact same frame as the original shell-only export -> the tuned mount still holds.
# The pods are additive jaw detail and must ride along by the SAME translation, so we
# origin-set the shell, THEN join, THEN zero location (translating shell+pods by -C).
shellobj = bpy.data.objects['Helmet']
bpy.ops.object.select_all(action='DESELECT')
shellobj.select_set(True)
bpy.context.view_layer.objects.active = shellobj
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')  # origin -> shell center C

# join the two pods into the shell -> one object, two material slots (origin stays at C)
for name in PODS:
    bpy.data.objects[name].select_set(True)
bpy.ops.object.join()

shellobj.location = (0.0, 0.0, 0.0)  # translate shell+pods by -C
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB',
    use_selection=True, export_apply=True, export_yup=True,
)
print('EXPORTED', OUT)
print('slots:', [s.material.name for s in shellobj.material_slots])
