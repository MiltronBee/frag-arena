"""Render the draft armor mounted on hero_male.glb to verify look + fit.
Places each armour piece at its bone's head (rest pose) with a scale/offset, front+side.
  blender -b -P scripts/render-armor-on-char.blender.py -- /tmp/armor_char.png
"""
import bpy, os, sys, math
from mathutils import Vector, Euler
argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/armor_char.png'
R = os.path.expanduser('~/unreal/public/assets/props')
CH = os.path.expanduser('~/unreal/public/assets/characters/hero_male.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=CH)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

def bone_world(name):
    pb = arm.pose.bones.get(name)
    if not pb: return None, None
    head = arm.matrix_world @ pb.head
    mat = arm.matrix_world @ pb.matrix   # bone orientation in world
    return head, mat

# (glb, bone, scale, local offset in metres, euler rot deg, mirror_x)
MOUNTS = [
    ('armor_chest.glb', 'spine_03', 1.05, (0, 0.03, -0.17), (74, 0, 0), False),
    ('armor_pauldron.glb', 'clavicle_l', 1.1, (0.055, 0.0, 0.02), (0, -25, 0), False),
    ('armor_pauldron.glb', 'clavicle_r', 1.1, (-0.055, 0.0, 0.02), (0, 25, 0), True),
    ('armor_elbow.glb', 'lowerarm_l', 1.0, (0.02, 0.0, 0), (0, -80, 0), False),
    ('armor_elbow.glb', 'lowerarm_r', 1.0, (-0.02, 0.0, 0), (0, 80, 0), True),
    ('armor_knee.glb', 'calf_l', 1.0, (0, 0.03, 0.04), (78, 0, 0), False),
    ('armor_knee.glb', 'calf_r', 1.0, (0, 0.03, 0.04), (78, 0, 0), True),
]
for glb, bone, sc, off, rot, mir in MOUNTS:
    head, mat = bone_world(bone)
    if head is None:
        print('MISSING bone', bone); continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(R, glb))
    new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for o in new:
        o.location = head + Vector(off)
        o.scale = (sc * (-1 if mir else 1), sc, sc)
        o.rotation_euler = Euler([math.radians(a) for a in rot], 'XYZ')
        bpy.context.view_layer.update()
        local = mat.inverted() @ o.matrix_world
        loc, quat, scl = local.decompose()
        eul = quat.to_euler('XYZ')
        print('LOCALXF', bone, glb, 'pos', [round(v,4) for v in loc], 'roteul', [round(math.degrees(a),2) for a in eul], 'scl', [round(v,4) for v in scl])

# camera + lights
scn = bpy.context.scene
scn.render.engine = 'BLENDER_EEVEE_NEXT'
scn.world = bpy.data.worlds.new('W'); scn.world.use_nodes = True
scn.world.node_tree.nodes['Background'].inputs[0].default_value = (0.04, 0.04, 0.05, 1)
scn.world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
for loc, e in [((2, -3, 3), 600), ((-3, -1, 2), 250), ((0, 3, 2), 200)]:
    l = bpy.data.lights.new('L', 'POINT'); l.energy = e
    ob = bpy.data.objects.new('L', l); ob.location = loc; scn.collection.objects.link(ob)

# figure the character bounds to frame it
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
zs = [(o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box]
cz = (max(zs) + min(zs)) / 2
cd = bpy.data.cameras.new('C'); cam = bpy.data.objects.new('C', cd); scn.collection.objects.link(cam); scn.camera = cam
ctop=max(zs); cbot=min(zs)
cam.location = (0.0, -3.6, (ctop+cbot)/2); cam.rotation_euler = (math.radians(90), 0, 0); cd.lens = 42
scn.render.resolution_x = 620; scn.render.resolution_y = 900; scn.render.filepath = OUT
bpy.ops.render.render(write_still=True); print('wrote', OUT)
