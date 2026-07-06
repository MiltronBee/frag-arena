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
  // third-person body other players see (attached to their replicated entity)
  playerBody: {
    url: '/assets/characters/RobotExpressive.glb',
    scale: 0.22,
    yOffset: -0.5,
    // model's forward axis vs our yaw convention; tuned so it faces its aim
    yawOffset: Math.PI,
    anims: { idle: 'Idle', run: 'Running', jump: 'Jump' },
  },

  // first-person weapon held in view (parented to the camera). position is in
  // camera-local space: +x right, +y up, +z forward (into the screen).
  viewmodel: {
    url: '/assets/weapons/blaster.glb',
    scale: 0.2,
    position: { x: 0.28, y: -0.3, z: 0.7 },
    rotation: { x: 0, y: Math.PI, z: 0 }, // face the muzzle away from the camera
  },
}

export default assets
