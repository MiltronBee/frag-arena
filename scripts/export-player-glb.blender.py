# Export a Quaternius Ultimate Animated Character Pack .blend to GLB for the
# playerBody slot. Each armature action becomes a named animation clip.
#
#   blender --background --python scripts/export-player-glb.blender.py -- \
#       <input.blend> <output.glb>
#
# export_apply=True is mandatory: without it modifiers (e.g. Mirror) are dropped
# and the mesh exports half-built — same failure the retro weapon arms had.
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=src)

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format='GLB',
    export_apply=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_skins=True,
    export_yup=True,
)
print(f'exported {dst}')
