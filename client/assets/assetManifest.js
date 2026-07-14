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
  // Quaternius 'Ultimate Animated Character Pack' BlueSoldier_Male (CC0,
  // https://quaternius.com/packs/ultimatedanimatedcharacter.html), exported from
  // the pack .blend via scripts/export-player-glb.blender.py — one skin, 23
  // joints, 17 clips. Raw model: feet at y=0, 3.28 units tall.
  playerBody: {
    url: '/assets/characters/soldier.glb',
    scale: 0.32,
    yOffset: -0.49,
    yawOffset: Math.PI, // model faces +Z in-file; the loader's __root__ 180deg Y
                        // flip inverts that, so PI re-aligns the body with travel dir
    anims: {
      idle: 'Idle',
      run: 'Run',
      jump: 'Jump',
      shoot: 'Shoot_OneHanded',
      hit: 'RecieveHit',
      death: 'Death',
    },
    // bone the held weapon prop attaches to (Babylon exposes a linked TransformNode
    // per glTF joint; see CharacterModel._attachWeapon)
    handBone: 'Fist.R',
  },

}

// ---------------------------------------------------------------------------
// THIRD-PERSON HELD WEAPON PROPS — the static gun other players see in-hand.
// Indexed to match common/weaponsConfig order: 0=Rifle 1=SMG 2=Shotgun 3=Pistol.
//
// These are plain props (no rig/anims), authored in cm with the barrel along +X,
// grip near the origin. They parent to the soldier's `Fist.R` bone, INSIDE the
// holder's 0.32 scaling — so 1 raw model unit ~= 0.57m and 1cm ~= 0.018 game
// units of parent-local scale (rifle ~60cm -> ~0.49 game units long).
//
// Orientation trap (same as the FP weapons above): the glTF loader adds a 180deg
// Y flip on each prop's __root__. We attach the prop's own root under the bone,
// so its authored +X barrel is what we rotate — expect per-gun yaw tuning to
// point the barrel forward and seat the grip in the fist. pos/rot are in the
// bone's local space; scale is uniform game-units-per-cm inside the holder.
// ---------------------------------------------------------------------------
export const tpWeapons = [
  { // 0 Rifle
    url: '/assets/weapons/tp_rifle.glb',
    scale: 0.018,
    position: { x: 0.0, y: 0.0, z: 0.0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  { // 1 SMG
    url: '/assets/weapons/tp_smg.glb',
    scale: 0.018,
    position: { x: 0.0, y: 0.0, z: 0.0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  { // 2 Shotgun
    url: '/assets/weapons/tp_shotgun.glb',
    scale: 0.018,
    position: { x: 0.0, y: 0.0, z: 0.0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  { // 3 Pistol
    url: '/assets/weapons/tp_pistol.glb',
    scale: 0.018,
    position: { x: 0.0, y: 0.0, z: 0.0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
]

// First-person weapons (parented to the camera). Converted from the Retro Weapon
// Pack's own .blend rigs (scripts/blend-to-gltf.blender.py) — the vendor authored
// every weapon around a camera at the origin looking down +X, with the arms' IK
// evaluated by Blender at export. So ONE transform mounts them all: scale cm->game
// units, yaw -90deg to map +X onto the camera's +Z. No per-weapon tuning.
// Clips: idle (base hold), fire, reload — each drives arms + gun bones together.
// Switch with 1-4 / Q / wheel.
// note: +90 not -90 — the glTF loader's __root__ carries its own 180deg Y flip,
// and the holder rotation composes with it.
import { weapons } from '../../common/weaponsConfig'

export { weapons }
export default assets
