"""Blender check: helmet_0.glb + the painted skin on the real UVs. Matches
CharacterModel._skinHelmet exactly: shell = gunmetal albedo+normal (metallic .6 rough .4);
pods (mat name has 'pod') = dark base (.03) + FAINT teal emission (.10), metallic .85.
  blender -b -P scripts/render-helmet-skin.py -- /tmp/out.png
"""
import bpy, os, sys, math
argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/helmet_out.png'
R = os.path.expanduser('~/unreal/public/assets/props')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(R, 'helmet_0.glb'))

def img(p, nc=False):
    im = bpy.data.images.load(p)
    if nc: im.colorspace_settings.name = 'Non-Color'
    return im

for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    for slot in o.material_slots:
        m = slot.material
        if not m or not m.use_nodes: continue
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not b: continue
        nt = m.node_tree
        # UNIFORM gunmetal on every material (matches CharacterModel._skinHelmet)
        b.inputs['Emission Color'].default_value = (0, 0, 0, 1)
        if 'Emission Strength' in b.inputs: b.inputs['Emission Strength'].default_value = 0.0
        tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = img(os.path.join(R, 'helmet_skin.webp'))
        nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img(os.path.join(R, 'helmet_skin_n.webp'), nc=True)
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
        b.inputs['Metallic'].default_value = 0.6; b.inputs['Roughness'].default_value = 0.4

scn = bpy.context.scene
scn.render.engine = 'BLENDER_EEVEE_NEXT'
scn.world = bpy.data.worlds.new('W'); scn.world.use_nodes = True
scn.world.node_tree.nodes['Background'].inputs[0].default_value = (0.03, 0.03, 0.04, 1)
scn.world.node_tree.nodes['Background'].inputs[1].default_value = 0.7
for loc, e in [((3, -4, 5), 900), ((-4, -2, 2), 350), ((0, 5, 3), 260)]:
    l = bpy.data.lights.new('L', 'POINT'); l.energy = e
    ob = bpy.data.objects.new('L', l); ob.location = loc; scn.collection.objects.link(ob)
cd = bpy.data.cameras.new('C'); cam = bpy.data.objects.new('C', cd); scn.collection.objects.link(cam); scn.camera = cam
cam.location = (0.35, -0.9, 0.28); cam.rotation_euler = (math.radians(74), 0, math.radians(21)); cd.lens = 60
scn.render.resolution_x = 820; scn.render.resolution_y = 820; scn.render.filepath = OUT
bpy.ops.render.render(write_still=True); print('wrote', OUT)
