# Build retro_sniper_arms.glb — the first-person viewmodel for the Sniper.
#
# There is no vendor .blend for this gun with the retro arms rig, so instead of authoring
# one we GRAFT: take retro_rifle_arms.glb (FPS arms + Arms_Armature 63 joints +
# Rifle_01_Armature 9 joints + all 14 clips), strip the AR meshes, and bone-parent the
# sniper mesh to the gun rig's root bone in their place. The clips animate the ARMATURES,
# not the meshes, so every clip — including the six aim_* clips the scope spec needs —
# survives untouched.
#
# What is deliberately lost: the AR's per-part gun animation (charge handle, dust cover,
# ejection cover each had their own bone). The sniper is one rigid body on the `Main`
# bone. A bolt-action cycle would need its own authored animation; the arms still play
# the full reload/fire motion around it.
#
# Alignment is numeric, not eyeballed: the sniper is rotated so its muzzle runs +X like
# the AR, uniformly scaled so its barrel length matches the AR's, then translated so the
# two bounding boxes agree on the axis that matters for each hand.
#
# Usage: blender -b -P graft-sniper-arms.blender.py -- <arms.glb> <sniper.glb> <out.glb>
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
ARMS, SNIPER, OUT = argv[0], argv[1], argv[2]
# per-axis nudge applied after the numeric fit, in AR units (cm). Tuned by rendering.
NUDGE = Vector((float(argv[3]) if len(argv) > 3 else 0.0,
                float(argv[4]) if len(argv) > 4 else 0.0,
                float(argv[5]) if len(argv) > 5 else 0.0))

bpy.ops.wm.read_factory_settings(use_empty=True)


def world_bbox(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


# ── 1. the arms rig ──────────────────────────────────────────────────────────
bpy.ops.import_scene.gltf(filepath=ARMS)
arms_objs = list(bpy.context.scene.objects)

gun_arm = next(o for o in arms_objs if o.type == "ARMATURE" and "Rifle" in o.name)

# MEASURE AND FIT IN REST POSE. The importer leaves the rig posed on the first frame of an
# imported action, so the AR meshes' world bbox already includes that deformation. Fitting
# the sniper to that posed bbox and THEN binding it applies the same deformation a second
# time, and the mesh lands ~10 units off. In rest position the modifier is identity, so
# what is measured is what gets bound.
for arm in [o for o in arms_objs if o.type == "ARMATURE"]:
    arm.data.pose_position = "REST"
bpy.context.view_layer.update()
# the AR meshes are exactly those skinned to the gun armature
ar_meshes = [o for o in arms_objs if o.type == "MESH"
             and any(m.type == "ARMATURE" and m.object == gun_arm for m in o.modifiers)]
if not ar_meshes:
    ar_meshes = [o for o in arms_objs if o.type == "MESH" and o.name != "FPS_Arms_Mesh"]

gun_lo, gun_hi = world_bbox(ar_meshes)
print(f"AR gun bbox  lo={[round(v,2) for v in gun_lo]} hi={[round(v,2) for v in gun_hi]}")

for o in ar_meshes:
    bpy.data.objects.remove(o, do_unlink=True)
print(f"stripped {len(ar_meshes)} AR meshes")

# ── 2. the sniper ────────────────────────────────────────────────────────────
before = set(bpy.context.scene.objects)
bpy.ops.import_scene.gltf(filepath=SNIPER)
snip = [o for o in bpy.context.scene.objects if o not in before and o.type == "MESH"]
snip_roots = [o for o in bpy.context.scene.objects if o not in before and o.parent is None]

# MIND THE AXIS CONVERSION. The glTF importer rewrites Y-up into Blender's Z-up:
# glTF (x, y, z) arrives as Blender (x, -z, y). The sniper's barrel is glTF -Z with the
# muzzle at the negative end, so INSIDE BLENDER the barrel runs along +Y, not Z. The AR
# it has to match runs along Blender +X (measured: 82.98 on X vs 10.6 and 32.5).
# Rotating about Y here is the obvious-looking mistake: it spins the gun about its own
# barrel and leaves the long axis where it was, so the scale-to-fit then divides by a
# 1.24-unit cross-section and inflates the mesh ~3.5x too far.
# Rz(-90deg) maps +Y onto +X, which puts the muzzle at +X like the AR.
for r in snip_roots:
    r.rotation_mode = "XYZ"
    r.rotation_euler[2] += -1.5707963
bpy.context.view_layer.update()

s_lo, s_hi = world_bbox(snip)
scale = (gun_hi.x - gun_lo.x) / (s_hi.x - s_lo.x)
for r in snip_roots:
    r.scale = tuple(v * scale for v in r.scale)
bpy.context.view_layer.update()
print(f"scaled sniper x{scale:.3f} to match AR barrel length")

s_lo, s_hi = world_bbox(snip)
# Blender axes here: +X is down the barrel, +Z is up, Y is lateral.
# X: match the MUZZLE end (max X) so the support hand's reach down the barrel is right.
# Z: match the TOP, so the receiver/sight line lands where the AR's was — matching the
#    bottom instead would align against the AR's magazine, which hangs 32 units down and
#    has no sniper analogue.
# Y: centre — both guns are symmetric about their own centreline.
delta = Vector((gun_hi.x - s_hi.x,
                ((gun_lo.y + gun_hi.y) - (s_lo.y + s_hi.y)) * 0.5,
                gun_hi.z - s_hi.z)) + NUDGE
for r in snip_roots:
    r.location += delta
bpy.context.view_layer.update()
print(f"aligned by {[round(v,2) for v in delta]}")

# ── 3. rigid-bind to the gun rig ─────────────────────────────────────────────
# An ARMATURE MODIFIER + a single full-weight vertex group, NOT a bone parent.
# Blender's bone parenting hangs the child off the bone's TAIL, so the mesh lands one
# bone-length away and matrix_parent_inverse has to undo that — easy to get wrong, and it
# exports as a plain node transform rather than a skin. A weight-1 vertex group is exactly
# rigid skinning, keeps the object where the alignment put it, and exports as a real skin
# so the glTF matches how the AR meshes were bound.
main_bone = "Main" if "Main" in gun_arm.data.bones else gun_arm.data.bones[0].name
for o in snip:
    # The alignment above was applied to the imported ROOT, and these meshes are its
    # children — so their world placement lives in the parent chain. Re-parenting to the
    # armature drops that chain, which silently threw the fit away. Capture the world
    # matrix first and restore it after, so matrix_basis is recomputed to keep the mesh
    # exactly where the fit put it.
    mw = o.matrix_world.copy()
    o.parent = gun_arm
    o.parent_type = "OBJECT"
    o.matrix_parent_inverse = gun_arm.matrix_world.inverted()
    o.matrix_world = mw

    vg = o.vertex_groups.new(name=main_bone)
    vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")
    mod = o.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = gun_arm
bpy.context.view_layer.update()
print(f"rigid-bound {len(snip)} sniper meshes to '{main_bone}'")

f_lo, f_hi = world_bbox(snip)
print(f"sniper final bbox lo={[round(v,2) for v in f_lo]} hi={[round(v,2) for v in f_hi]}")
print(f"AR gun was        lo={[round(v,2) for v in gun_lo]} hi={[round(v,2) for v in gun_hi]}")
arms = [o for o in bpy.context.scene.objects if o.type == "MESH" and o not in snip]
if arms:
    a_lo, a_hi = world_bbox(arms)
    print(f"arms bbox         lo={[round(v,2) for v in a_lo]} hi={[round(v,2) for v in a_hi]}")

# ── 4. export ────────────────────────────────────────────────────────────────
# back to POSE so the clips drive the rig again — REST was only for the fit.
for arm in [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]:
    arm.data.pose_position = "POSE"
bpy.context.view_layer.update()

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_skins=True,
    export_materials="EXPORT",
    export_yup=True,
)
print("GRAFTED", OUT)
