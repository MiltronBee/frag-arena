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

  // first-person viewmodel parented to the camera. position is camera-local:
  // +x right, +y up, +z forward (into the screen). PSX arms (drillimpact, CC0),
  // authored around a camera node with finger-gun/knife/melee animation clips.
  viewmodel: {
    url: '/assets/weapons/psx_arms.glb',
    scale: 1.0,
    position: { x: 0, y: -1.35, z: 0.75 }, // framed so the finger-gun hand sits near the crosshair
    rotation: { x: 0.349, y: 0, z: 0 },     // ~20deg downward pitch
    anims: { idle: 'finger_gun_idle', fire: 'finger_gun_fire' },
  },
}

export default assets
