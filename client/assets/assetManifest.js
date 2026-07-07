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
  // Retro Weapon Pack (free, commercial-OK) FP arms holding an AR-style rifle,
  // converted FBX->glTF in Blender (arms + rifle on hand_item_r + merged animations).
  viewmodel: {
    url: '/assets/weapons/retro_rifle_arms.glb',
    scale: 0.018,
    position: { x: 0.12, y: -0.35, z: 0.45 },
    rotation: { x: 0.14, y: -1.745, z: 0 }, // barrel forward, rifle low-right
    anims: { idle: 'idle', fire: 'fire' }, // pack also has reload + walk for later
  },
}

export default assets
