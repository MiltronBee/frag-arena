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

// First-person weapons (parented to the camera). All four share the same FP arms
// rig (Retro Weapon Pack, free/commercial-OK), each converted FBX->glTF with its own
// gun on the hand_item_r socket + its own animation clips. Because every weapon is
// recentered on the same 'camera' bone, one camera-local transform frames them all
// (the gun sizes differ naturally in the same hands). Switch with 1-4 / Q / wheel.
// Each weapon's idle animation holds the arms at a different distance from the eye,
// so every weapon gets its own camera-local transform (tuned by hand) or it either
// engulfs the camera or floats off-frame.
export const weapons = [
  { name: 'Rifle',   url: '/assets/weapons/retro_rifle_arms.glb',   scale: 0.016, position: { x: 0.14, y: -0.42, z: 0.50 }, rotation: { x: 0.12,  y: -1.62, z: 0 }, anims: { idle: 'idle', fire: 'fire' } },
  { name: 'SMG',     url: '/assets/weapons/retro_smg_arms.glb',     scale: 0.022, position: { x: 0.15, y: -0.50, z: 1.00 }, rotation: { x: 0.105, y: -1.62, z: 0 }, anims: { idle: 'idle', fire: 'fire' } },
  { name: 'Shotgun', url: '/assets/weapons/retro_shotgun_arms.glb', scale: 0.022, position: { x: 0.15, y: -0.50, z: 1.00 }, rotation: { x: 0.105, y: -1.62, z: 0 }, anims: { idle: 'idle', fire: 'fire' } },
  // pistol's idle animation swings the arms a lot; this frame keeps it clear of the camera
  { name: 'Pistol',  url: '/assets/weapons/retro_pistol_arms.glb',  scale: 0.022, position: { x: 0.16, y: -0.55, z: 0.90 }, rotation: { x: 0.10,  y: -1.62, z: 0 }, anims: { idle: 'idle', fire: 'fire' } },
]

export default assets
