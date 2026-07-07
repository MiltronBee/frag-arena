// Central art manifest — the ONE place art is wired up.
//
// Swapping placeholders for the real Synty POLYGON assets later means: convert the
// FBX to .glb, drop it in public/assets/, and edit the entry here (url + scale +
// yOffset + animation-clip names). No other client code changes. Everything that
// renders art reads its file/scale/animation names from this file.
//
// yOffset: the proxy collision box is centered on the entity origin and is 1 unit
// tall (spans y-0.5 .. y+0.5). Most character models have their origin at the feet,
// so yOffset ~ -0.5 drops the feet to the bottom of the box. Tune per model.

export const assets = {
  // third-person body other players see (attached to their replicated entity).
  // PROTOTYPE: Xonotic 'Erebus' (CC-BY-SA), converted IQM->glTF (static bind pose,
  // no animation yet). Swap back to RobotExpressive by restoring the url/scale below.
  playerBody: {
    url: '/assets/characters/erebus.glb',
    scale: 0.0274,
    yOffset: 0.22,
    yawOffset: 0,
    anims: { idle: 'Idle', run: 'Running', jump: 'Jump' }, // absent in static glb -> stands still
  },

}

// First-person weapons (parented to the camera). Converted from the Retro Weapon
// Pack's own .blend rigs (scripts/blend-to-gltf.blender.py) — the vendor authored
// every weapon around a camera at the origin looking down +X, with the arms' IK
// evaluated by Blender at export. So ONE transform mounts them all: scale cm->game
// units, yaw -90deg to map +X onto the camera's +Z. No per-weapon tuning.
// Clips: idle (base hold), fire, reload — each drives arms + gun bones together.
// Switch with 1-4 / Q / wheel.
// note: +90 not -90 — the glTF loader's __root__ carries its own 180deg Y flip,
// and the holder rotation composes with it.
const authoredMount = { scale: 0.01, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, anims: { idle: 'idle', fire: 'fire', reload: 'reload' } }

export const weapons = [
  { name: 'Rifle',   url: '/assets/weapons/retro_rifle_arms.glb',   ...authoredMount },
  { name: 'SMG',     url: '/assets/weapons/retro_smg_arms.glb',     ...authoredMount },
  { name: 'Shotgun', url: '/assets/weapons/retro_shotgun_arms.glb', ...authoredMount },
  { name: 'Pistol',  url: '/assets/weapons/retro_pistol_arms.glb',  ...authoredMount },
]

export default assets
