import bpy, math, sys, mathutils

argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/helmet_look.png'
# optional material params:  shellHex sheenMetal sheenRough  podHex podMetal podRough
def hx(s): return tuple(int(s[i:i+2],16)/255.0 for i in (0,2,4)) + (1.0,)
SHELL = hx(argv[1]) if len(argv)>1 else (0.055,0.06,0.07,1)
SH_MET = float(argv[2]) if len(argv)>2 else 0.65
SH_RGH = float(argv[3]) if len(argv)>3 else 0.32
POD   = hx(argv[4]) if len(argv)>4 else (0.02,0.02,0.025,1)
PD_MET = float(argv[5]) if len(argv)>5 else 0.9
PD_RGH = float(argv[6]) if len(argv)>6 else 0.12

TRIO = ['Helmet', 'Sphere.001', 'Sphere.002']
PODS = ['Sphere.001', 'Sphere.002']
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.hide_render = o.name not in TRIO

def mat(name, base, met, rough):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = base
    b.inputs['Metallic'].default_value = met
    b.inputs['Roughness'].default_value = rough
    return m

shell = mat('Shell', SHELL, SH_MET, SH_RGH)
pod   = mat('Pod',   POD,   PD_MET, PD_RGH)
for name in TRIO:
    o = bpy.data.objects[name]; o.data.materials.clear()
    o.data.materials.append(pod if name in PODS else shell)

scene = bpy.context.scene
cam_data = bpy.data.cameras.new('Cam'); cam_data.lens = 55
cam = bpy.data.objects.new('Cam', cam_data)
scene.collection.objects.link(cam); scene.camera = cam
cx, cy, cz = bpy.data.objects['Helmet'].location
tgt = mathutils.Vector((cx, cy-0.015, cz+1.11))

def look(loc, path):
    cam.location = loc
    cam.rotation_euler = (tgt-mathutils.Vector(loc)).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

# 3-point-ish lighting
def sun(energy, rx, rz, col=(1,1,1)):
    d = bpy.data.lights.new('S','SUN'); d.energy=energy; d.color=col
    ob = bpy.data.objects.new('S', d); scene.collection.objects.link(ob)
    ob.rotation_euler=(math.radians(rx),0,math.radians(rz))
sun(3.0, 55, -35)          # key from front-left-above
sun(1.2, 60, 140)          # fill from back-right
sun(2.0, 20, 180, (0.7,0.8,1.0))  # cool rim from behind

scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x = 640; scene.render.resolution_y = 640
import os
_wb = float(os.environ.get('WORLD','0.14'))
scene.world = bpy.data.worlds.new('W'); scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(_wb,_wb,_wb*1.1,1)

look((cx-1.0, cy-1.15, cz+1.55), OUT.replace('.png','_hero.png'))   # 3/4 front, above
look((cx,     cy-1.5,  cz+1.15), OUT.replace('.png','_front.png'))  # straight front
print("OK")
