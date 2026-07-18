const authoredMount = {
  scale: 0.01,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: Math.PI / 2, z: 0 },
  anims: { idle: 'idle', fire: 'fire', reload: 'reload', draw: 'draw' }
}

// ADS (aim-down-sights). Weapons that opt in extend their anims with the six ADS
// clips baked into the retro GLBs (scripts/retro-blend-actions.json "aim" group)
// and carry an `ads` block. `fov` is the world-camera target in DEGREES (matching
// this.fov / the user FOV setting); in/out are the zoom transition seconds; the
// sensitivity multiplier scales look speed while aimed (never mutates the stored
// setting). These are iron sights — modest zoom, not a scope.
// Shotgun/Flak deliberately OMIT ads (no breathing_aiming source + the documented
// shotgun base-orientation blocker), so they stay hip-fire only.
const adsAnims = {
  aimStart: 'aim_start', aimPose: 'aim_pose', aimEnd: 'aim_end',
  fireAiming: 'fire_aiming', breathingAiming: 'breathing_aiming', walkAiming: 'walk_aiming'
}
// fov in DEGREES (composed onto the user FOV). in/out are transition seconds:
// out is deliberately FASTER than in — snap into the sight, but drop back to hip
// even faster so peripheral vision returns instantly (arena survival). FOV targets
// stay >=75deg so you're never blind to flankers/vertical play. Look sensitivity
// while aimed is NOT a fixed number — it's derived from the live zoom (focal-length
// matched) in Simulator, so hand->pixel travel stays consistent. Numbers per an
// id-gameplay-engineer review (scripts/gemini-id.mjs, Randall "Hitscan" Voss).
// `extra` carries the ADS GAMEPLAY mults (consumed in weapon.fire/firePattern/applyCommand,
// scaled by entity.aimFactor): spreadBaseMult/spreadHeatMult tighten the cone, heatMult
// cuts bloom accumulation, projSpeedMult speeds projectiles. A mult of 1 (or absent) = no
// effect. Sandbox numbers per a Bungie weapon-sandbox review (scripts/gemini-bungie.mjs).
const withAds = (fov, inTime, outTime, extra = {}) => ({
  anims: { ...authoredMount.anims, ...adsAnims },
  ads: { fov, inTime, outTime, ...extra }
})

export const weapons = [
  {
    index: 0,
    name: 'Rifle',
    url: '/assets/weapons/retro_rifle_arms.glb',
    ...authoredMount,
    // ADS gameplay: tighter base cone (-50%), -40% sustained bloom, -30% heat/shot
    // -> aimed = a precise sustained mid-range tracker; hip is a looser burst weapon.
    ...withAds(75, 0.08, 0.06, { spreadBaseMult: 0.5, spreadHeatMult: 0.6, heatMult: 0.7 }),
    // ADS: sink the bulky receiver down + forward so the front sight stays on the
    // crosshair but the body drops out of the lower-middle (downward-tracking blind
    // spot per the id review). Presentation only; never touches the aim ray.
    adsMount: { position: { x: 0.0, y: -0.03, z: 0.06 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } },
    // draw re-enabled 2026-07-13: the old GLB's draw clip detached the gun from
    // the hands; the rebuilt full-pipeline GLB draws attached (0.26cm grip slip).
    muzzle: { x: 0.08, y: -0.13, z: 1.05 },
    recoilForce: 1.0,
    drawTime: 0.30, // seconds to equip (enforced in a later phase; data-only for now)

    // Gameplay specs
    // VERB: mid-range pressure / tracking tool — the consistent workhorse you
    // fight with most of the time. ~0.84s TTK to full health (research: spawn
    // weapons want 0.8-0.9s at 100 HP no-regen) — steady pressure, NOT the
    // finisher (that's the Pistol). The SMG kills faster up close (~0.72s),
    // trading range + accuracy; the Rifle owns mid-range with a tight cone.
    type: 'hitscan',
    fireCooldown: 0.14, // ~430 RPM (was 0.15; a touch snappier, still in TTK band)
    reloadTime: 1.5,
    magazineCapacity: 30,
    maxReserveAmmo: 90,
    damage: 15,
    // range 75: deliberately NOT 60 — the SMG (slot 1) is already range 60
    // "close-range hose"; matching it would recreate a verb collision. 75
    // cleanly out-ranges the SMG (60) and Shotgun (30) while staying a
    // mid-range tool rather than the old unusable "100" on this small arena.
    range: 75,
    // reliable mid-range tracking, mild sustained bloom: soften the heat so
    // the cone stays tight enough to track a moving target on full-auto
    // (spread angles are radians; pattern math in common/firePattern.js)
    spreadBase: 0.003,
    spreadHeat: 0.004, // was 0.007
    heatPerShot: 0.12  // was 0.16
  },
  {
    index: 1,
    name: 'SMG',
    url: '/assets/weapons/retro_smg_arms.glb',
    ...authoredMount,
    // SMG stays hip-only for now: the full-set ADS rebuild rendered badly in live
    // testing (its vendor rig has known quirks). Reverted to the original shipped GLB.
    // Revisit with re-authored SMG arm clips before re-enabling ADS here.
    muzzle: { x: 0.08, y: -0.13, z: 0.90 },
    recoilForce: 0.6,
    drawTime: 0.25,

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
    drawTime: 0.40,

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
    // ADS gameplay: the pistol now carries a real HIP cone (spreadBase below), and ADS
    // is how you make it precise -- spreadBaseMult:0 snaps the aimed cone to a dead
    // laser, so aiming is a genuine accuracy gain (loose from the hip -> pinpoint aimed).
    // ADS also EXTENDS the damage-falloff range (rangeMult 1.75, common/damageFalloff.js)
    // so the aimed pistol keeps its 3-shot kill far past where hip-fire drops off.
    ...withAds(80, 0.05, 0.04, { spreadBaseMult: 0.0, rangeMult: 1.75 }),
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
    // ADS holder framing: the hip mount is deliberately shoved lower-RIGHT + canted
    // for the classic pistol hip look, but that offset would push the aimed sights off
    // the crosshair. While aiming, the viewmodel blends the holder to this CENTERED,
    // un-canted mount (by the aim amount) so the iron sights land on the crosshair.
    // Presentation only — never touches the aim ray. Tuned visually vs the crosshair.
    adsMount: { position: { x: 0.0, y: 0.0, z: 0.0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } },
    recoilForce: 0.8,
    drawTime: 0.15,

    // Gameplay specs
    // VERB: quick-draw precision finisher — NOT a primary. You pressure with the
    // Rifle, then swap and land a clean finishing shot. 3-shot kill (34 dmg) but a
    // deliberately slow cooldown that punishes spam and rewards precise single
    // shots. Near-laser accurate (flat spread, no heat) is its identity.
    // TODO(sandbox): fast-draw equip time (~0.1s) — needs a weapon-equip timer
    //   system that doesn't exist yet (switching is currently instant). Captured
    //   here so the "quick-draw" fantasy isn't lost; do NOT half-build it.
    type: 'hitscan',
    fireCooldown: 0.45, // slow, precise (was 0.15) — punishes spam
    reloadTime: 1.0,
    magazineCapacity: 6, // was 12 — small mag reinforces "finisher, not primary"
    maxReserveAmmo: 36,
    damage: 34, // was 20 → 3-shot kill @ 100 HP
    range: 50,
    // Damage falloff (common/damageFalloff.js): full 34 dmg (3-shot @ 100 HP) inside
    // 20m, LINEAR down to 0.5x (17 dmg -> 6-shot) by 40m, floored beyond. Hip-fire is
    // thus a mid-range finisher that goes soft at long range; ADS (rangeMult 1.75 above)
    // pushes this window out to 35m/70m, so the aimed pistol keeps the 3-shot kill at
    // range. Chosen so the 3-shot window is decided by AIM, not just distance.
    falloffStart: 20,
    falloffEnd: 40,
    falloffMinMult: 0.5,
    // HIP now has a real cone (was 0.0015 near-laser) so ADS is a meaningful accuracy
    // gain: loose from the hip, pinpoint when aimed (ads.spreadBaseMult:0). No heat --
    // it's a precise single-shot finisher, not a sprayer; placement is rewarded.
    spreadBase: 0.005,
    spreadHeat: 0
  },
  // ---------------------------------------------------------------------------
  // PROJECTILE WEAPONS (slots 4-5) — the roster's two projectile guns. They REUSE
  // the base rigged retro-arm GLBs (Plasma←rifle arms, Flak←shotgun arms) via the
  // shared authoredMount, so they inherit real arms + the idle/fire/reload/draw
  // clips + correct facing. The Quaternius "Red" bodyless sci-fi meshes were
  // dropped (no arms, no anims, reversed facing); the cyan/green muzzle FX +
  // projectile bolts (client/graphics/firingFx.js) carry each gun's identity.
  // ---------------------------------------------------------------------------
  {
    index: 4,
    name: 'Plasma',              // HUD shows uppercased; keep short
    url: '/assets/weapons/retro_rifle_arms.glb',
    ...authoredMount,
    // ADS gameplay: tighter cone (-60% base, -50% bloom) + 35% faster + 0.6x collision
    // radius at full ADS -> aimed = a precise fast dart; hip = a loose, slow, fat
    // area-denial ball. (GameInstance spawn scales speed/size; firePattern the cone.)
    ...withAds(75, 0.08, 0.06, { projSpeedMult: 1.35, projSizeMult: 0.6, spreadBaseMult: 0.4, spreadHeatMult: 0.5 }),
    muzzle: { x: 0.08, y: -0.13, z: 1.05 },
    recoilForce: 0.7,
    drawTime: 0.30,
    // VERB: strip health / punish dodgers. Projectile bolts that SLOW the target.
    // Projectile plumbing already exists (common/entity/Projectile.js + GameInstance
    // performShot projectile branch); slowFactor/slowDuration are consumed in Phase 2.
    type: 'projectile',
    projectileSpeed: 65,
    fireCooldown: 0.10,
    reloadTime: 1.6,
    magazineCapacity: 25,
    maxReserveAmmo: 100,
    damage: 10,
    range: 90,
    spreadBase: 0.010,
    spreadHeat: 0.020,
    heatPerShot: 0.05,
    slowFactor: 0.15,     // Phase 2: victim move speed *= (1-slowFactor)
    slowDuration: 0.4     // Phase 2: seconds
  },
  {
    index: 5,
    name: 'Flak',
    url: '/assets/weapons/retro_shotgun_arms.glb',
    ...authoredMount,
    // fire/draw nulled to match base Shotgun: those retro-shotgun clips rack the
    // pump without re-baked arms and detach the gun ~12cm; procedural recoil carries
    // the shot, idle keeps the grip glued (see slot 2 note).
    anims: { ...authoredMount.anims, fire: null, draw: null },
    muzzle: { x: 0.08, y: -0.15, z: 1.05 },
    recoilForce: 2.2,
    drawTime: 0.40,
    // VERB: own the doorway. A burst of bouncing shrapnel projectiles.
    // pellets>1 + bounceCount are consumed in Phase 2 (spawn N projectiles, reflect
    // off obstacles once). In Phase 1 it may fire a single projectile — that's fine.
    type: 'projectile',
    projectileSpeed: 45,
    fireCooldown: 0.9,
    reloadTime: 2.4,
    magazineCapacity: 5,
    maxReserveAmmo: 15,
    damage: 12,           // per pellet
    pellets: 5,
    bounceCount: 1,
    range: 30,
    spreadBase: 0.05      // cone for the pellet burst
  }
  // Roster is 6 contiguous weapons (0-5): Rifle, SMG, Shotgun, Pistol are hitscan;
  // Plasma (4) + Flak (5) are projectile. The projectile plumbing (Projectile
  // entity, factory, bolt rendering, plasmaImpact FX) is reused by both; their
  // slow/pellet/bounce mechanics land in Phase 2.
]
export default weapons
