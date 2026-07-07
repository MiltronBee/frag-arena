import bpy, sys, re

# Vendor .blend -> one animated GLB, per weapon. (Replaces the FBX路 conversion:
# the pack's FBX clips only bake motion onto IK controller bones, and the IK
# constraints live solely in the .blend rigs — so FBX-converted arms T-pose.)
#
# Structure of FP_Arms_<W>_01_Anims.blend:
#   Arms_Armature (IK rig) + FPS_Arms_Mesh (skinned)
#   <W>_01_Armature (gun rig: Main/Trigger/Magazine/... bones) + sample mesh
#   Actions: Arms_BasePose/Fire/Reload (arms), <W>_BasePose/Fire/Reload (gun bones),
#            <W>_Breathing/Walk/... (object-level camera sway — skipped; the game
#            adds procedural bob), Camera object at the origin = the authored eye.
# Gun meshes come from <W>_01.blend, skinned to an identically-named armature.
#
# usage: blender --background --python this.py -- anims.blend gun.blend armsTex gunTex out.glb

argv = sys.argv[sys.argv.index('--')+1:]
anims_blend, gun_blend, arms_tex, gun_tex, out_glb = argv

bpy.ops.wm.open_mainfile(filepath=anims_blend)

arms_arm = bpy.data.objects['Arms_Armature']
gun_arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and o is not arms_arm)
arms_mesh = bpy.data.objects['FPS_Arms_Mesh']

# --- pull the gun's skinned meshes in from the gun blend ---
have = set(o.name for o in bpy.data.objects)
with bpy.data.libraries.load(gun_blend) as (src, dst):
    dst.objects = [n for n in src.objects if n not in have]
appended = [o for o in dst.objects if o is not None]
for o in appended:
    bpy.context.scene.collection.objects.link(o)
# re-point skinned meshes at OUR gun armature; drop everything else that came along
dup_arms = [o for o in appended if o.type == 'ARMATURE']
kept = []
for o in appended:
    if o.type != 'MESH':
        continue
    mods = [m for m in o.modifiers if m.type == 'ARMATURE']
    if mods:
        for m in mods: m.object = gun_arm
        o.parent = gun_arm
        kept.append(o)
    else:
        bpy.data.objects.remove(o, do_unlink=True)  # loose extras (spare magazines etc.)
for o in dup_arms:
    bpy.data.objects.remove(o, do_unlink=True)
print('gun meshes added:', [o.name for o in kept])

# --- delete junk: control widgets, backdrop, camera object ---
for o in list(bpy.data.objects):
    if o.name.startswith('Ctrl_Mesh') or o.name == 'Cube' or o.type == 'CAMERA':
        bpy.data.objects.remove(o, do_unlink=True)

# --- textures: force our albedos, nearest-filtered, rough ---
def apply_texture(mesh_obj, img_path):
    img = bpy.data.images.load(img_path, check_existing=True)
    for slot in mesh_obj.material_slots:
        mat = slot.material
        if not mat: continue
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not bsdf: continue
        # reuse an existing image node if present, else add one
        node = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)
        if node is None:
            node = nt.nodes.new('ShaderNodeTexImage')
        node.image = img
        node.interpolation = 'Closest'
        if not bsdf.inputs['Base Color'].links:
            nt.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 1.0

apply_texture(arms_mesh, arms_tex)
for o in kept:
    apply_texture(o, gun_tex)
mesh_in_anims = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent is gun_arm and o not in kept]
for o in mesh_in_anims:
    apply_texture(o, gun_tex)

# --- trim shoulders/upper arms so the FP camera is never inside the mesh ---
# NB: the rig has mixed-case duplicate groups (upperArm_l AND UpperArm_l) — match ci.
import bmesh
_cut = ('shoulder', 'upperarm')
_cut_idx = {vg.index for vg in arms_mesh.vertex_groups if any(k in vg.name.lower() for k in _cut)}
if _cut_idx:
    bm = bmesh.new(); bm.from_mesh(arms_mesh.data)
    dl = bm.verts.layers.deform.active
    doomed = [v for v in bm.verts if len(v[dl]) and max(v[dl].items(), key=lambda kv: kv[1])[0] in _cut_idx]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(arms_mesh.data); bm.free()
    print('trimmed upper-arm verts:', len(doomed))

# --- NLA: same track names on both armatures merge into one glTF animation ---
# Action names vary per blend (Arms_Fire / arms_Fire / shotgun01_fire...), so
# classify by which armature's BONES an action actually targets, then match by
# case-insensitive suffix.
arms_bones = set(b.name for b in arms_arm.data.bones)
gun_bones = set(b.name for b in gun_arm.data.bones)

def targets_of(act):
    bones = set()
    for fc in act.fcurves:
        m = re.match(r'pose\.bones\["([^"]+)"\]', fc.data_path)
        if m: bones.add(m.group(1))
    return bones

def pick(cands, *preds):
    for pred in preds:
        hit = [a for a in cands if pred(a.name.lower())]
        if hit: return hit[0]
    return None

by_arm = {'arms': [], 'gun': []}
for a in bpy.data.actions:
    t = targets_of(a)
    if not t: continue  # object-level sway clips (breathing/walk) — game adds code-bob
    if t & arms_bones and not t & gun_bones: by_arm['arms'].append(a)
    elif t & gun_bones and not t & arms_bones: by_arm['gun'].append(a)

def pad_short(act):
    # 1-frame pose clips sample unreliably in-engine (from==to animation group);
    # duplicate the pose one frame later so every clip spans >= 2 frames.
    if act and act.frame_range[1] - act.frame_range[0] < 1.0:
        f = act.frame_range[0]
        for fc in act.fcurves:
            if len(fc.keyframe_points):
                fc.keyframe_points.insert(f + 1, fc.keyframe_points[0].co.y)
        print(f'   padded 1-frame clip: {act.name}')

# stash tracks can live on ANY object (mesh objects included) — clear them all
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = None
        for tr in list(o.animation_data.nla_tracks):
            o.animation_data.nla_tracks.remove(tr)

used_actions = set()
def reload_clips(cands):
    """Single reload action, or the pump-action Start/Step/Step/End chain (loads two
    shells) when the vendor authored the reload as segments (shotgun)."""
    single = pick(cands, lambda n: n.endswith('reload'))
    if single: return [single]
    start = pick(cands, lambda n: n.endswith('reloadstart'))
    step = pick(cands, lambda n: n.endswith('reloadstep'))
    end = pick(cands, lambda n: n.endswith('reloadend'))
    if start and step and end: return [start, step, step, end]
    return [a for a in (start,) if a]

for arm_obj, key in ((arms_arm, 'arms'), (gun_arm, 'gun')):
    cands = by_arm[key]
    clips = {
        'idle':   [pick(cands, lambda n: n.endswith('basepose'))],
        'fire':   [pick(cands, lambda n: 'fire' in n and 'aim' not in n)],
        'reload': reload_clips(cands),
    }
    clips = {k: [a for a in v if a] for k, v in clips.items()}
    if not arm_obj.animation_data:
        arm_obj.animation_data_create()
    for acts in clips.values():
        used_actions.update(acts)
    for track_name, acts in clips.items():
        if not acts:
            print(f'   ({arm_obj.name}: no {track_name})'); continue
        for a in acts: pad_short(a)
        tr = arm_obj.animation_data.nla_tracks.new()
        tr.name = track_name
        cursor = int(acts[0].frame_range[0])
        for a in acts:  # chained segments sit back-to-back on the one track
            strip = tr.strips.new(a.name, cursor, a)
            cursor = int(strip.frame_end) + 1
        print(f'++ {arm_obj.name}: {track_name} <- {"+".join(a.name for a in acts)} ({cursor}f)')

# --- ground truth: with idle (BasePose) active, where are hands vs gun? ---
arms_arm.animation_data.action = pick(by_arm['arms'], lambda n: n.endswith('basepose'))
gun_arm.animation_data.action = pick(by_arm['gun'], lambda n: n.endswith('basepose'))
for tr in list(arms_arm.animation_data.nla_tracks) + list(gun_arm.animation_data.nla_tracks):
    tr.mute = True
bpy.context.scene.frame_set(1)
dg = bpy.context.evaluated_depsgraph_get()
for obj, label in ((arms_mesh, 'ARMS'), (next(iter(kept), None), 'GUN')):
    if obj is None: continue
    ev = obj.evaluated_get(dg); me = ev.to_mesh()
    if len(me.vertices):
        xs = [ev.matrix_world @ v.co for v in me.vertices]
        mn = [round(min(c[i] for c in xs), 2) for i in range(3)]
        mx = [round(max(c[i] for c in xs), 2) for i in range(3)]
        print(f'CHECK {label} @BasePose: min={mn} max={mx}')
    ev.to_mesh_clear()
arms_arm.animation_data.action = None
gun_arm.animation_data.action = None
for tr in list(arms_arm.animation_data.nla_tracks) + list(gun_arm.animation_data.nla_tracks):
    tr.mute = False

# purge every action not in our NLA strips so nothing else can leak into the export
for a in list(bpy.data.actions):
    if a not in used_actions:
        bpy.data.actions.remove(a)

bpy.ops.export_scene.gltf(
    filepath=out_glb, export_format='GLB',
    export_animations=True, export_animation_mode='NLA_TRACKS',
    export_yup=True, use_selection=False)
print('WROTE', out_glb)
