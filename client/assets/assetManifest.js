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
  // Quaternius 'Universal Base Characters' Superhero_Male body (paid, standard
  // license) baked with the 'Universal Animation Library 1' (UAL1) clips via
  // scripts/build-hero-character.blender.py — one skin, "Standard" mannequin rig,
  // 120 clips. Raw model: feet at y=0, ~1.82 units tall.
  // (hero_female.glb is the same rig/clips with the Superhero_Female body.)
  //
  // UAL1 (CC0) supplies REAL shooter locomotion/combat the old UAL2 set lacked:
  // Idle_Loop, Jog_Fwd_Loop (+ strafes), Sprint_Loop, a full Pistol_* aim/shoot/
  // reload set, Death01/02, and Hit_* reactions. Audition all 120 in the client
  // playground (default boot; ?game for the match) and copy a new mapping there.
  playerBody: {
    url: '/assets/characters/hero_male.glb',
    scale: 0.577, // raw ~1.82 units * 0.577 ≈ 1.05 in-game (matches old body height)
    yOffset: -1.0, // feet sit on the VISUAL floor (arenaDressing GROUND_Y = -1),
                   // NOT the collision box bottom (-0.5) — else bodies hover ~0.5 up
    yawOffset: 0, // GLB faces +Z and the loader's __root__ fix preserves forward, so no offset (Math.PI flipped bodies 180deg opposite their aim + inverted locomotion)
    anims: {
      idle: 'Idle_Loop',
      run: 'Jog_Fwd_Loop', // forward jog; directional variants below fix strafe-slide
      runBack: 'Jog_Bwd_Loop',
      runLeft: 'Jog_Left_Loop',
      runRight: 'Jog_Right_Loop',
      jump: 'Jump_Start',
      shoot: 'Pistol_Shoot', // one-shot overlay (only gun clip in UAL1)
      hit: 'Hit_Chest',
      death: 'Death01', // Death02 is an alternate
    },
    // bone the held weapon prop attaches to (Babylon exposes a linked TransformNode
    // per glTF joint; see CharacterModel._attachWeapon). NOTE: rig changed from the
    // old 'Fist.R' to 'hand_r' — tpWeapons mounts below still need retuning.
    handBone: 'hand_r',
    // bone the helmet prop attaches to (see CharacterModel._headNode / _mountHelmet)
    headBone: 'Head',
    // rigid head prop parented to the Head bone (rides head animation).
    // TUNED VISUALLY — see probe-helmet
    helmet: {
      url: '/assets/props/helmet_0.glb',
      // TUNED VISUALLY (tune-helmet.mjs): 0.8/y0.04 left the bald crown poking out
      // the top of the shell. A smaller shell needs a matching lift to still cap the
      // skull — at 0.85 the crown clips through unless raised to y~0.078.
      scale: 0.85,
      position: { x: 0, y: 0.078, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  },

}

// ---------------------------------------------------------------------------
// THIRD-PERSON HELD WEAPON PROPS — the static gun other players see in-hand.
// Indexed to match common/weaponsConfig order: 0=Rifle 1=SMG 2=Shotgun 3=Pistol.
//
// These are plain props (no rig/anims), authored in cm with the barrel along +X,
// grip near the origin. They parent to the soldier's `hand_r` bone, INSIDE the
// holder's 0.577 body scaling — so the per-cm scale factor is ~0.010 game units
// (was ~0.018 inside the old 0.32 body; the body grew ~1.8x, so the scale shrank
// by 0.32/0.577 to keep real-world gun size). pos/rot are in the hand bone's
// local space; scale is uniform.
//
// Orientation: the `hand_r` bone frame is rotated relative to the prop's authored
// +X barrel, so a base yaw of y=+PI/2 (1.5708) swings the barrel forward. Each
// gun then needs a small per-weapon roll (z) to level the barrel, because the
// props were authored with slightly different barrel pitches (the shotgun even
// needs a negative roll). position y=-0.03 lifts the whole gun so the grip seats
// in the fist. Re-tuned from scratch after the Fist.R -> hand_r rig swap
// (2026-07-14) via scripts/tune-tp-mounts.mjs.
// ---------------------------------------------------------------------------
export const tpWeapons = [
  // NOTE (2026-07-16 sci-fi swap): the Quaternius sci-fi guns are authored in
  // METERS, not cm — so the per-cm ~0.010 scale no longer applies. Scales below
  // are computed to give real-ish world lengths (rifle ~0.70u, SMG ~0.42u,
  // shotgun ~0.55u, pistol ~0.24u) INSIDE the 0.577 body bone scale, from each
  // gun's measured raw X-length (see bounding boxes). Rough first pass — a
  // visual tuning pass on pos/rot follows.
  { // 0 Rifle  (raw len 1.06m)
    url: '/assets/weapons/Gun_Rifle.gltf',
    scale: 1.145,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: 0.3 },
  },
  { // 1 SMG  (raw len 0.48m)
    url: '/assets/weapons/Gun_SMG.gltf',
    scale: 1.507,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: 0.15 },
  },
  { // 2 Shotgun  (raw len 0.63m)
    url: '/assets/weapons/Gun_Shotgun.gltf',
    scale: 1.518,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: -0.4 },
  },
  { // 3 Pistol  (raw len 0.44m)
    url: '/assets/weapons/Gun_Pistol.gltf',
    scale: 0.941,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: 0.1 },
  },
  // PROJECTILE WEAPONS (slots 4-5). They reuse the PLAIN (non-red) sci-fi gun
  // meshes as third-person props — same geometry as their sci-fi counterparts, so
  // the bounding-box scales and rotations match the like-shaped slots above
  // (Plasma reuses the Rifle prop, Flak reuses the Shotgun prop).
  { // 4 Plasma  (Rifle prop, raw len 1.06m)
    url: '/assets/weapons/Gun_Rifle.gltf',
    scale: 1.145,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: 0.3 },
  },
  { // 5 Flak  (Shotgun prop, raw len 0.63m)
    url: '/assets/weapons/Gun_Shotgun.gltf',
    scale: 1.518,
    position: { x: 0.0, y: -0.03, z: 0.0 },
    rotation: { x: 0, y: 1.5708, z: -0.4 },
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
