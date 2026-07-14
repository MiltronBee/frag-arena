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
# usage: blender --background --python this.py -- \
#            anims.blend gun.blend armsTex gunTex out.glb [blendActions.json WEAPON]
#
# Checkpoint C -- the declarative mapping now DRIVES export. With the 7-arg form the
# exporter reads scripts/retro-blend-actions.json (the blend-action counterpart to
# scripts/retro-clip-mapping.json) and builds the full safe first-person runtime clip
# set for WEAPON: idle (<- real Breathing), walk, run, fire, reload (+ shotgun
# reload_start/reload_insert/reload_end and a chained 'reload'), draw, hide, interact.
# Attachment is structural: the arms' hand-IK is constrained to the gun, so gun object
# and Main-bone motion is FOLLOWED by the hands and baked per-frame by the glTF
# sampler. The prior detachment (Rifle/Shotgun draw) was purely that object-level-only
# gun actions (e.g. Rifle_Draw) carry no pose.bones fcurves and the old classifier
# dropped them; here each clip explicitly stacks its arms + gun actions on same-named
# NLA tracks (which merge on export), so the gun always travels with the hands.
#
# The legacy 5-arg form is preserved verbatim (idle<-BasePose, fire, reload, draw via
# the built-in bone-target classifier) so any ad-hoc caller is byte-for-byte identical.
import json as _json, os as _os

def load_clip_mapping(path):
    """Read the declarative clip-mapping JSON (pure json; no bpy). Returns the dict, or
    None if unreadable. Used for the semantic vocabulary / runtime-consumption flags."""
    if path is None:
        base = globals().get('__file__')
        if not base:
            return None
        path = _os.path.join(_os.path.dirname(_os.path.abspath(base)), 'retro-clip-mapping.json')
    try:
        with open(path) as _f:
            return _json.load(_f)
    except (OSError, ValueError):
        return None

def load_blend_actions(path):
    """Read scripts/retro-blend-actions.json (per-weapon runtime-clip -> Blender action
    resolution). Returns the dict, or None if unreadable."""
    try:
        with open(path) as _f:
            return _json.load(_f)
    except (OSError, ValueError):
        return None

argv = sys.argv[sys.argv.index('--')+1:]
anims_blend, gun_blend, arms_tex, gun_tex, out_glb = argv[:5]
# Full-set mode requires BOTH a blend-actions map (arg 6) and a weapon key (arg 7).
blend_actions = load_blend_actions(argv[5]) if len(argv) > 5 else None
weapon = argv[6] if len(argv) > 6 else None
weapon_spec = None
if blend_actions and weapon:
    weapon_spec = blend_actions.get('weapons', {}).get(weapon)
    if weapon_spec:
        print('blend-actions: %s (%s) -> weapon %s, %d clips'
              % (argv[5], blend_actions.get('schema', '?'), weapon, len(weapon_spec['clips'])))
    else:
        print('blend-actions: weapon %r not in %s -- falling back to legacy 4-clip export'
              % (weapon, argv[5]))
elif len(argv) > 5:
    print('blend-actions: no weapon key given -- legacy 4-clip export (arg6=%s)' % argv[5])

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

# --- NLA: same track names merge into one glTF animation (this holds ACROSS objects
# AND for multiple tracks on ONE object -- verified empirically in Blender 4.2). We
# lay each clip's arms action + gun action(s) on same-named tracks; they merge, and
# the arms' IK-follow of the gun is baked per-frame by the sampler.
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

def pad_short(act):
    # 1-frame pose clips sample unreliably in-engine (from==to animation group);
    # duplicate the pose one frame later so every clip spans >= 2 frames. Idempotent.
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
idle_probe_actions = None  # (arms_action, gun_actions) used for the ground-truth check

def A(name):
    return bpy.data.actions.get(name)

if weapon_spec:
    # ------- full-set export driven by scripts/retro-blend-actions.json -------
    # Attachment is BAKED, not left to the exporter. The arms grip the gun through an
    # IK constraint chain; Blender's glTF NLA sampler does not reliably co-activate the
    # gun track while sampling the arms, so with a large clip set the arms stop following
    # the gun (the grip slips by exactly the gun's travel). We instead bake each clip's
    # arms pose to FLAT FK -- reading the fully evaluated, gun-following, IK-solved pose
    # per frame with the gun co-active -- then MUTE the arms constraints. The exported
    # arms clip then carries the follow directly and needs no runtime IK.
    #
    # The gun keeps its authored action -- EXCEPT where a clip lists several gun actions
    # (Shotgun splits gun motion into an object family `movement_*` and a bone family
    # `shotgun01_*`). Two same-named gun tracks merge structurally but the sampler does
    # not reproduce the co-active pose (fire/reload detach), so we first UNION the two
    # actions into one (their fcurve channels are disjoint: object TRS vs pose bones),
    # reducing every clip to the single-gun-action path that exports cleanly.
    if arms_arm.name != weapon_spec.get('armsArmature'):
        print('WARN: arms armature %r != mapping %r' % (arms_arm.name, weapon_spec.get('armsArmature')))
    if gun_arm.name != weapon_spec.get('gunArmature'):
        print('WARN: gun armature %r != mapping %r' % (gun_arm.name, weapon_spec.get('gunArmature')))
    clip_specs = weapon_spec['clips']

    def merge_gun_actions(merged_name, action_names):
        """Union several gun actions' fcurves into one action. Raises on a data-path
        collision (would mean the families are not disjoint)."""
        merged = bpy.data.actions.new(merged_name)
        seen = set()
        for an in action_names:
            src = A(an)
            if not src:
                print('   !! MISSING gun action %r for merge %s' % (an, merged_name)); continue
            for fc in src.fcurves:
                key = (fc.data_path, fc.array_index)
                if key in seen:
                    raise RuntimeError('gun action merge collision on %s[%d] (%s)'
                                       % (fc.data_path, fc.array_index, merged_name))
                seen.add(key)
                nfc = merged.fcurves.new(fc.data_path, index=fc.array_index)
                nfc.keyframe_points.add(len(fc.keyframe_points))
                for i, kp in enumerate(fc.keyframe_points):
                    nfc.keyframe_points[i].co = kp.co
                    nfc.keyframe_points[i].interpolation = kp.interpolation
            merged.frame_range  # touch so range recomputes
        return merged

    # collapse every multi-action gun clip to a single unioned action, in place
    for cn, cs in clip_specs.items():
        gl = cs.get('gun', [])
        if len(gl) > 1:
            m = merge_gun_actions('merged_%s' % cn, gl)
            cs['gun'] = [m.name]
            print('   merged gun[%s] -> %s' % (','.join(gl), m.name))

    def clear_nla(o):
        if o.animation_data:
            o.animation_data.action = None
            for tr in list(o.animation_data.nla_tracks):
                o.animation_data.nla_tracks.remove(tr)

    def set_gun_coactive(gun_actions):
        """Drive the gun (object TRS + bones) so the arms IK follows it during the bake."""
        clear_nla(gun_arm)
        if gun_actions and not gun_arm.animation_data:
            gun_arm.animation_data_create()
        for i, gn in enumerate(gun_actions):
            a = A(gn)
            if a:
                tr = gun_arm.animation_data.nla_tracks.new(); tr.name = 'co%d' % i
                tr.strips.new(a.name, int(a.frame_range[0]), a)

    def clip_range(arms_action, gun_actions):
        fr = []
        for n in ([arms_action] if arms_action else []) + list(gun_actions):
            a = A(n)
            if a:
                fr += [a.frame_range[0], a.frame_range[1]]
        f0, f1 = (int(min(fr)), int(max(fr))) if fr else (1, 2)
        return f0, (f1 if f1 > f0 else f0 + 1)  # every baked clip spans >= 2 frames

    # phase 1: collect the evaluated (IK-solved, gun-following) arms basis per frame for
    # every NON-chain clip. arms.action stays the SOURCE action so constraints solve live.
    pose_bones = list(arms_arm.pose.bones)
    baked_data = {}  # clip -> (f0, f1, {bone: [(f, loc, quat, scale)]})
    if not arms_arm.animation_data:
        arms_arm.animation_data_create()
    for clip_name, cspec in clip_specs.items():
        if 'chain' in cspec:
            continue
        aa, gg = cspec.get('arms'), list(cspec.get('gun', []))
        f0, f1 = clip_range(aa, gg)
        clear_nla(arms_arm)
        arms_arm.animation_data.action = A(aa) if aa else None
        set_gun_coactive(gg)
        store = {pb.name: [] for pb in pose_bones}
        for f in range(f0, f1 + 1):
            bpy.context.scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            ae = arms_arm.evaluated_get(dg)
            for pb in pose_bones:
                M = ae.pose.bones[pb.name].matrix
                rest = pb.bone.matrix_local
                if pb.parent:
                    local_rest = pb.parent.bone.matrix_local.inverted() @ rest
                    local_pose = ae.pose.bones[pb.parent.name].matrix.inverted() @ M
                else:
                    local_rest, local_pose = rest, M
                store[pb.name].append((f, (local_rest.inverted() @ local_pose).decompose()))
        baked_data[clip_name] = (f0, f1, store)

    # phase 2: constraints off (the flat FK is now authoritative), write flat actions.
    for pb in pose_bones:
        for c in pb.constraints:
            c.mute = True
    clear_nla(arms_arm); arms_arm.animation_data_create()
    baked_action = {}
    for clip_name, (f0, f1, store) in baked_data.items():
        act = bpy.data.actions.new('baked_%s' % clip_name)
        arms_arm.animation_data.action = act
        for pb in pose_bones:
            pb.rotation_mode = 'QUATERNION'
        for bone, frames in store.items():
            pb = arms_arm.pose.bones[bone]
            for f, (loc, quat, scale) in frames:
                pb.location = loc; pb.rotation_quaternion = quat; pb.scale = scale
                pb.keyframe_insert('location', frame=f)
                pb.keyframe_insert('rotation_quaternion', frame=f)
                pb.keyframe_insert('scale', frame=f)
        arms_arm.animation_data.action = None
        used_actions.add(act)
        baked_action[clip_name] = act

    # phase 3: assign clips to same-named NLA tracks -- baked arms + authored gun. A
    # 'chain' clip sequences its segments' baked arms actions and gun actions in lockstep.
    clear_nla(arms_arm); clear_nla(gun_arm)
    arms_arm.animation_data_create(); gun_arm.animation_data_create()

    def arms_track(clip_name):
        tr = arms_arm.animation_data.nla_tracks.new(); tr.name = clip_name; return tr

    def gun_track(clip_name):
        tr = gun_arm.animation_data.nla_tracks.new(); tr.name = clip_name; return tr

    def assign_gun(clip_name, gun_actions, cursor):
        end = cursor
        for i, gn in enumerate(gun_actions):
            a = A(gn)
            if not a:
                print('   !! MISSING gun action %r for %s' % (gn, clip_name)); continue
            pad_short(a); used_actions.add(a)
            # one lane (track) per gun-action index so stacked families stay parallel
            lane = gun_lanes.setdefault((clip_name, i), gun_track(clip_name))
            s = lane.strips.new(a.name, int(cursor), a)
            end = max(end, int(s.frame_end) + 1)
        return end

    gun_lanes = {}
    for clip_name, cspec in clip_specs.items():
        if 'chain' in cspec:
            cursor = 1
            atrack = arms_track(clip_name)
            for seg in cspec['chain']:
                bact = baked_action.get(seg)
                seg_gun = list(clip_specs[seg].get('gun', []))
                seg_end = cursor
                if bact:
                    s = atrack.strips.new(bact.name, int(cursor), bact)
                    seg_end = max(seg_end, int(s.frame_end) + 1)
                seg_end = max(seg_end, assign_gun(clip_name, seg_gun, cursor))
                cursor = seg_end
            print('++ %-13s CHAIN %s' % (clip_name, '+'.join(cspec['chain'])))
        else:
            bact = baked_action.get(clip_name)
            if bact:
                arms_track(clip_name).strips.new(bact.name, int(bact.frame_range[0]), bact)
            assign_gun(clip_name, list(cspec.get('gun', [])), 1)
            if cspec.get('runtime') == 'idle':
                idle_probe_actions = (bact.name if bact else None, list(cspec.get('gun', [])))
            print('++ %-13s <- baked_arms + gun[%s]'
                  % (clip_name, ','.join(cspec.get('gun', [])) or '-'))
else:
    # ------- legacy 5-arg export: idle<-BasePose, fire, reload, draw -------
    by_arm = {'arms': [], 'gun': []}
    for a in bpy.data.actions:
        t = targets_of(a)
        if not t: continue  # object-level sway clips — legacy skipped these
        if t & arms_bones and not t & gun_bones: by_arm['arms'].append(a)
        elif t & gun_bones and not t & arms_bones: by_arm['gun'].append(a)

    def reload_clips(cands):
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
            'draw':   [pick(cands, lambda n: 'draw' in n and 'aim' not in n)],
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
            for a in acts:
                strip = tr.strips.new(a.name, cursor, a)
                cursor = int(strip.frame_end) + 1
            print(f'++ {arm_obj.name}: {track_name} <- {"+".join(a.name for a in acts)} ({cursor}f)')
    idle_probe_actions = (pick(by_arm['arms'], lambda n: n.endswith('basepose')) and
                          pick(by_arm['arms'], lambda n: n.endswith('basepose')).name,
                          [pick(by_arm['gun'], lambda n: n.endswith('basepose')).name]
                          if pick(by_arm['gun'], lambda n: n.endswith('basepose')) else [])

# --- ground truth: with the equipped IDLE active, where are hands vs gun? (mute NLA
#     so only the probe actions evaluate; the IK follow must keep them together) ---
for o in (arms_arm, gun_arm):
    if o.animation_data:
        for tr in o.animation_data.nla_tracks:
            tr.mute = True
if idle_probe_actions:
    ia, igs = idle_probe_actions
    if ia and A(ia):
        arms_arm.animation_data.action = A(ia)
    for i, gn in enumerate(igs):
        if A(gn):
            trp = gun_arm.animation_data.nla_tracks.new(); trp.name = '__probe%d' % i
            trp.strips.new(A(gn).name, int(A(gn).frame_range[0]), A(gn))
bpy.context.scene.frame_set(1)
dg = bpy.context.evaluated_depsgraph_get()
for obj, label in ((arms_mesh, 'ARMS'), (next(iter(kept), None), 'GUN')):
    if obj is None: continue
    ev = obj.evaluated_get(dg); me = ev.to_mesh()
    if len(me.vertices):
        xs = [ev.matrix_world @ v.co for v in me.vertices]
        mn = [round(min(c[i] for c in xs), 2) for i in range(3)]
        mx = [round(max(c[i] for c in xs), 2) for i in range(3)]
        print(f'CHECK {label} @idle: min={mn} max={mx}')
    ev.to_mesh_clear()
arms_arm.animation_data.action = None
# drop probe-only tracks, then unmute the real clip tracks
for o in (arms_arm, gun_arm):
    if o.animation_data:
        for tr in list(o.animation_data.nla_tracks):
            if tr.name.startswith('__probe'):
                o.animation_data.nla_tracks.remove(tr)
            else:
                tr.mute = False
gun_arm.animation_data.action = None

# purge every action not in our NLA strips so nothing else can leak into the export
for a in list(bpy.data.actions):
    if a not in used_actions:
        bpy.data.actions.remove(a)

# scene fps drives glTF sampling; report it so candidate durations are reproducible
_scn = bpy.context.scene
print('scene fps: %s/%s' % (_scn.render.fps, _scn.render.fps_base))
print('exporting animations:', sorted(set(
    tr.name for o in (arms_arm, gun_arm) if o.animation_data for tr in o.animation_data.nla_tracks)))

bpy.ops.export_scene.gltf(
    filepath=out_glb, export_format='GLB',
    export_animations=True, export_animation_mode='NLA_TRACKS',
    export_yup=True, use_selection=False,
    # The vendor authors FPS_Arms_Mesh as a LEFT arm with a Mirror modifier
    # generating the right arm (vertex groups auto-flipped _l -> _r). Without
    # export_apply the mirror is silently skipped and every weapon ships a
    # one-armed viewmodel. export_apply applies mesh modifiers EXCLUDING
    # armature deform, so skinning is preserved.
    export_apply=True)
print('WROTE', out_glb)
