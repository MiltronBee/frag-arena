const authoredMount = {
  scale: 0.01,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: Math.PI / 2, z: 0 },
  anims: { idle: 'idle', fire: 'fire', reload: 'reload', draw: 'draw' }
}

export const weapons = [
  {
    index: 0,
    name: 'Rifle',
    url: '/assets/weapons/retro_rifle_arms.glb',
    ...authoredMount,
    // draw re-enabled 2026-07-13: the old GLB's draw clip detached the gun from
    // the hands; the rebuilt full-pipeline GLB draws attached (0.26cm grip slip).
    muzzle: { x: 0.08, y: -0.13, z: 1.05 },
    recoilForce: 1.0,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.15,
    reloadTime: 1.5,
    magazineCapacity: 30,
    maxReserveAmmo: 90,
    damage: 15,
    range: 100,
    // disciplined AR: tight, with a small bloom under sustained full-auto
    // (spread angles are radians; pattern math in common/firePattern.js)
    spreadBase: 0.003,
    spreadHeat: 0.007,
    heatPerShot: 0.16
  },
  {
    index: 1,
    name: 'SMG',
    url: '/assets/weapons/retro_smg_arms.glb',
    ...authoredMount,
    muzzle: { x: 0.08, y: -0.13, z: 0.90 },
    recoilForce: 0.6,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.08,
    reloadTime: 1.2,
    magazineCapacity: 40,
    maxReserveAmmo: 120,
    damage: 10,
    range: 60,
    // minigun-style hose (UT99): rate over accuracy — the cone visibly blooms
    // the longer the trigger is held, so burst discipline matters
    spreadBase: 0.006,
    spreadHeat: 0.032,
    heatPerShot: 0.13
  },
  {
    index: 2,
    name: 'Shotgun',
    url: '/assets/weapons/retro_shotgun_arms.glb',
    ...authoredMount,
    // fire: null — the shipped 4-clip shotgun's fire clip moves the gun through the
    // pump-rack without re-baked arms, detaching it ~12cm from the hands every shot
    // (scripts/retro-blend-actions.json notes.shotgunFireGrip). Procedural recoil
    // (recoilForce below) carries the shot feel instead; idle keeps the grip glued.
    anims: { ...authoredMount.anims, draw: null, fire: null },
    muzzle: { x: 0.08, y: -0.15, z: 1.05 },
    recoilForce: 2.2,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.8,
    reloadTime: 2.2,
    magazineCapacity: 8,
    maxReserveAmmo: 24,
    damage: 10, // per pellet
    pellets: 8,
    // flak-style rosette (common/firePattern.js): 1 center pellet + 7 on a
    // jittered ring — the wall stamp is a readable circle, never confetti.
    // (replaces the old per-axis random `spread: 0.08` cone)
    ringRadius: 0.05,
    ringJitter: 0.016,
    spreadBase: 0.004,
    range: 30
  },
  {
    index: 3,
    name: 'Pistol',
    url: '/assets/weapons/retro_pistol_arms.glb',
    ...authoredMount,
    isOneHanded: true,
    // The pistol grip is authored ~37deg below the camera line — steeper than the
    // 29deg bottom edge of the 1.0rad FOV — so at the shared mount the trigger
    // hand/arm falls below the frame. Raise and push the rig out to reframe it
    // (muzzle shifted by the same offset to stay on the barrel tip), then shift
    // it right into the classic lower-right pistol framing with a slight inward
    // yaw/cant so the barrel reads as converging on the crosshair.
    // y raised until BOTH hands of the authored two-hand cup grip clear the
    // bottom edge (the support hand sits ~4cm below the trigger hand; at y=0.05
    // it projected ~30px below the viewport and the grip read as one-handed).
    position: { x: 0.10, y: 0.09, z: 0.05 },
    muzzle: { x: 0.18, y: -0.05, z: 0.75 },
    rotation: { x: 0, y: Math.PI / 2 - 0.06, z: 0.05 },
    recoilForce: 0.8,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.15,
    reloadTime: 1.0,
    magazineCapacity: 12,
    maxReserveAmmo: 36,
    damage: 20,
    range: 50,
    // Enforcer: snappy semi-auto finisher — near-laser accurate with flat spread
    // (no heat scaling), so trigger speed is rewarded. 400 RPM, TTK 0.6s @ 100 HP.
    spreadBase: 0.0015,
    spreadHeat: 0
  }
  // Slot 5 ('Plasma Rifle') removed 2026-07-13: it reused the AR rifle GLB and read
  // as a duplicate AR. The projectile plumbing (Projectile entity, factory, bolt
  // rendering, plasmaImpact FX) is kept for a future real energy-weapon model.
]
export default weapons
