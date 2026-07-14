# Export the Retro Weapon Pack's standalone gun blends (Guns/<W>_01/BlendFile/)
# as single static GLBs for third-person props (attached to the character's
# hand bone). No armature/animations — just the assembled gun with one magazine.
#
#   blender --background --python scripts/export-tp-guns.blender.py -- \
#       <guns_dir> <out_dir>
#
# guns_dir is the pack's Guns/ folder WITH its original layout intact
# (<W>_01/BlendFile/*.blend next to <W>_01/Textures/) — the blends reference the
# albedo textures by relative path, so flattening the tree exports blank white
# materials.
#
# Skips the per-ammo-state magazine variants and projectile meshes the vendor
# keeps in the same file for the reload animations.
import os
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
guns_dir, out_dir = argv[0], argv[1]

SKIP = ('Separated', 'OneBullet', '2+Bullets', 'Full', 'Empty', 'Projectile')
WEAPONS = ['Pistol_01', 'Rifle_01', 'Shotgun_01', 'SMG_01']

for name in WEAPONS:
    bpy.ops.wm.open_mainfile(filepath=os.path.join(guns_dir, name, 'BlendFile', f'{name}.blend'))
    # the blends say '../Texture/' but the zip ships 'Textures/' — symlink one to
    # the other before running. Only the gun's own albedo matters; the projectile
    # texture belongs to meshes we skip.
    missing = [i.name for i in bpy.data.images if i.source == 'FILE'
               and name.split('_')[0] in i.name
               and not os.path.exists(bpy.path.abspath(i.filepath))]
    if missing:
        raise SystemExit(f'{name}: unresolved textures {missing} — check guns_dir layout')
    # remove everything but the assembled-gun meshes (select_all is unreliable
    # in --background, so export the pruned scene instead of a selection)
    for o in list(bpy.data.objects):
        if o.type != 'MESH' or any(s in o.name for s in SKIP):
            bpy.data.objects.remove(o, do_unlink=True)
    keep = [o.name for o in bpy.data.objects]
    out = os.path.join(out_dir, f'tp_{name.split("_")[0].lower()}.glb')
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_yup=True,
    )
    print(f'exported {out}: {keep}')
