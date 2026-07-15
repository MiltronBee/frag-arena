# Build a third-person player body GLB by merging a Quaternius Universal Base
# Character body with the Universal Animation Library 2 (UAL2) clips. Both share
# the 65-bone "Standard" mannequin rig (identical bone names), so the UAL2 actions
# retarget onto the body with no bone remapping.
#
#   blender --background --python scripts/build-hero-character.blender.py -- \
#       [UAL2.glb] [body.gltf] [out.glb]
#
# ACTIONS-mode gotcha: the glTF exporter only emits actions linked to the exported
# armature. We import UAL2 first (its animations become fake-user Actions), delete
# UAL2's own geometry, then push every action onto the body armature as its own NLA
# track+strip so all clips survive the export.
import sys

import bpy

DEFAULT_UAL2 = ('/tmp/ual2/Universal Animation Library 2[Standard]/'
                'Unreal-Godot/UAL2_Standard.glb')
DEFAULT_BODY = ('/tmp/ubc/Universal Base Characters[Standard]/'
                'Base Characters/Godot - UE/Superhero_Male_FullBody.gltf')
DEFAULT_OUT = 'public/assets/characters/hero_male.glb'

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ual2_path = argv[0] if len(argv) > 0 else DEFAULT_UAL2
body_path = argv[1] if len(argv) > 1 else DEFAULT_BODY
out_path = argv[2] if len(argv) > 2 else DEFAULT_OUT

bpy.ops.wm.read_factory_settings(use_empty=True)

# import UAL2 anims, keep actions (fake user), drop its geometry
bpy.ops.import_scene.gltf(filepath=ual2_path)
for a in bpy.data.actions:
    a.use_fake_user = True
ual2_actions = list(bpy.data.actions)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# import the body
bpy.ops.import_scene.gltf(filepath=body_path)
armature = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

# GOTCHA FIX: push every action onto the body armature as an NLA strip so the
# ACTIONS-mode exporter emits them (bone names match -> they apply cleanly)
armature.animation_data_create()
for a in ual2_actions:
    trk = armature.animation_data.nla_tracks.new()
    trk.name = a.name
    trk.strips.new(a.name, 0, a)
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.context.view_layer.objects.active = armature

bpy.ops.export_scene.gltf(
    filepath=out_path, export_format='GLB', export_apply=True,
    export_animations=True, export_animation_mode='ACTIONS',
    export_nla_strips=True, export_skins=True, export_yup=True,
    export_materials='EXPORT', export_image_format='AUTO')
print(f'exported {out_path}')
