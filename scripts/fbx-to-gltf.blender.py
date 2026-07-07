import bpy, sys, mathutils
argv = sys.argv[sys.argv.index('--')+1:]
arms_fbx, rifle_fbx, arms_tex, rifle_tex, out_glb = argv[0], argv[1], argv[2], argv[3], argv[4]
anim_specs = argv[5:]  # "name=path.fbx"

def apply_texture(mesh_obj, img_path):
    """Give every material on mesh_obj a retro unlit-ish look: albedo -> base color,
    metallic 0, roughness 1, nearest-neighbour filtering."""
    img = bpy.data.images.load(img_path, check_existing=True)
    for slot in mesh_obj.material_slots:
        mat = slot.material
        if not mat:
            continue
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not bsdf:
            continue
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.interpolation = 'Closest'  # crisp PSX/retro pixels
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 1.0

bpy.ops.wm.read_factory_settings(use_empty=True)

# --- arms (mesh + armature) ---
bpy.ops.import_scene.fbx(filepath=arms_fbx)
armature = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
arms_mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
apply_texture(arms_mesh, arms_tex)

# Trim upper arms / shoulders so the first-person camera never sits inside the mesh
# (only forearms + hands + gun should be visible, like a normal FP viewmodel). Delete
# each vertex whose dominant bone weight is a shoulder/upper-arm/spine bone; the cut
# lands cleanly around the elbow where forearm weights take over.
import bmesh
_cut = ('shoulder', 'upperArm', 'spine')
_cut_idx = {vg.index for vg in arms_mesh.vertex_groups if any(k in vg.name for k in _cut)}
if _cut_idx:
    _bm = bmesh.new(); _bm.from_mesh(arms_mesh.data)
    _dl = _bm.verts.layers.deform.active
    _doomed = [v for v in _bm.verts if len(v[_dl]) and max(v[_dl].items(), key=lambda kv: kv[1])[0] in _cut_idx]
    bmesh.ops.delete(_bm, geom=_doomed, context='VERTS')
    _bm.to_mesh(arms_mesh.data); _bm.free()
    print('trimmed upper-arm verts:', len(_doomed))

# --- rifle mesh, attached to the hand_item_r weapon socket bone ---
before = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=rifle_fbx)
rifle_objs = [o for o in bpy.data.objects if o not in before]
# drop any armature that came with the rifle; keep meshes
for o in list(rifle_objs):
    if o.type == 'ARMATURE':
        bpy.data.objects.remove(o, do_unlink=True)
        rifle_objs.remove(o)
rifle_meshes = [o for o in rifle_objs if o.type == 'MESH']

bpy.context.view_layer.update()
for rm in rifle_meshes:
    apply_texture(rm, rifle_tex)
# The arms + gun FBX are authored in a shared space, so the imported gun already sits
# at the hand socket. Parent it to hand_item_r KEEPING its world transform (this also
# sidesteps Blender's bone-axis convention differing from the source rig).
for o in bpy.data.objects:
    o.select_set(False)
for rm in rifle_meshes:
    rm.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
armature.data.bones.active = armature.data.bones['hand_item_r']
bpy.ops.object.parent_set(type='BONE', keep_transform=True)
bpy.context.view_layer.update()

# --- animations: import each, steal its action, stash as an NLA track ---
if not armature.animation_data:
    armature.animation_data_create()

def import_action(path, name):
    ba = set(bpy.data.actions)
    bo = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new_actions = [a for a in bpy.data.actions if a not in ba]
    new_objs = [o for o in bpy.data.objects if o not in bo]
    act = new_actions[0] if new_actions else None
    if act:
        act.name = name
        act.use_fake_user = True
    for o in new_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    return act

for spec in anim_specs:
    name, path = spec.split('=', 1)
    act = import_action(path, name)
    if not act:
        print('!! no action in', path); continue
    tr = armature.animation_data.nla_tracks.new()
    tr.name = name
    start = int(act.frame_range[0])
    tr.strips.new(name, start, act)
    print('++ track', name, 'frames', act.frame_range[:])

# Recenter the whole rig so the 'camera' bone (the authored eye) sits at the world
# origin. Then the viewmodel mounts naturally at our Babylon camera and only needs a
# small orientation/scale tweak instead of guessing where the hands ended up.
cam_bone = armature.pose.bones.get('camera')
if cam_bone:
    # 1) translate so the eye -> origin
    cam_head = (armature.matrix_world @ cam_bone.matrix).to_translation()
    armature.location = armature.location - cam_head
    bpy.context.view_layer.update()
    # 2) rotate so the eye's orientation is canonical (view looks down an axis),
    #    preserving the mesh scale (left-multiply by the eye's inverse rotation)
    cam_world = armature.matrix_world @ cam_bone.matrix
    R_inv = cam_world.to_quaternion().inverted().to_matrix().to_4x4()
    armature.matrix_world = R_inv @ armature.matrix_world
    bpy.context.view_layer.update()
    print('recentered + oriented on camera bone (was at', tuple(round(v, 2) for v in cam_head), ')')

# --- export one GLB with every NLA track as a named animation ---
bpy.ops.export_scene.gltf(
    filepath=out_glb, export_format='GLB',
    export_animations=True, export_animation_mode='NLA_TRACKS',
    export_yup=True, use_selection=False)
print('WROTE', out_glb)
