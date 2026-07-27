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
// The Shotgun opts in as of the 17-clip retro rebuild (breathing_aiming/fire_aiming et
// al. are now present, built from the pack's bone-family gun actions so they orient
// correctly and the hands follow the gun). Flak reuses the same shotgun GLB but stays
// deliberately hip-fire ("own the doorway" burst identity).
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

// ── Body-zone damage multipliers (server-authoritative body-part hit detection) ──
// The server classifies each CONFIRMED hitscan hit into head / torso / legs with a
// lightweight 3-sphere pose model (server/lagCompensatedHitscanCheck.js) and applies
// these multipliers in GameInstance.damagePlayer — authoritative, OUTSIDE the
// reconciled applyCommand path, and NEVER on the predicted client path. Pure DATA (no
// wall-clock, no randomness), so it is safe to live in this shared module.
//
// Per weapon: a weapon may carry its own `zoneMultipliers`; anything without one falls
// back to DEFAULT_ZONE_MULTIPLIERS (the "global default"). v1 hitscan roster: Rifle /
// SMG / Shotgun-pellet use the default (head 2.0); the Pistol overrides head to 2.5
// (its precision/ADS finisher — 34 * 2.5 = 85, a UT-sniper-like near-instakill that
// also triggers the headshot announcer). Projectiles (Plasma/Flak) are unchanged: they
// never carry a zone, so no multiplier is applied (v1 is hitscan-only).
//
// LEG_DAMAGE_MULT is the ONE tunable knob. legs < 1.0 is THE USER'S ADDITION, not
// vanilla UT (UT had no limb reduction) — set this to 1.0 for "true UT" behaviour.
export const LEG_DAMAGE_MULT = 0.7
// 'arms' are FOLDED INTO torso (1.0): a vertical-band pose model with no skeleton
// cannot isolate an arm, so there is no 'arms' zone — a shoulder/arm ray classifies as
// torso and takes the torso multiplier. Documented here as the intended arm value.
export const DEFAULT_ZONE_MULTIPLIERS = {
  head: 2.0,
  torso: 1.0,   // arms fold into torso (see above)
  legs: LEG_DAMAGE_MULT
}

// The one weapon a fresh spawn owns AND holds (the pistol). Single source of truth
// for PlayerCharacter's constructor, respawnPlayer, the client's initial viewmodel,
// and the asset preloader's "don't double-warm the live rig" skip.
export const SPAWN_WEAPON_INDEX = 3

export const weapons = [
  {
    index: 0,
    name: 'Rifle',
    // SEASON 1 OWNERSHIP GATE (2026-07-26): every non-pistol weapon is `ownedOnly`.
    // See the Sniper (index 6) for the full rationale — the flag keeps this weapon out
    // of ENABLED_WEAPON_INDICES, every spawner and every default loadout, while leaving
    // it fully playable for a player the server GRANTS it to (a verified NFT holder, or
    // anyone who loots it off a corpse). Granted by 'Vector Rifle' in common/entitlements.js.
    ownedOnly: true,
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
    // SEASON 1 OWNERSHIP GATE — see index 0. Granted by 'Static Repeater'.
    ownedOnly: true,
    url: '/assets/weapons/retro_smg_arms.glb',
    ...authoredMount,
    // ADS enabled via procedural viewmodel centering fallback.
    // ADS gameplay: tighter base cone (-40%), -30% sustained bloom, -20% heat/shot
    ...withAds(80, 0.20, 0.15, { spreadBaseMult: 0.6, spreadHeatMult: 0.7, heatMult: 0.8 }),
    // ADS: sink the receiver down + forward so the sights align with the crosshair
    adsMount: { position: { x: 0.0, y: -0.03, z: 0.06 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } },
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
    // SEASON 1 OWNERSHIP GATE — see index 0. Granted by 'Breach Ward'.
    ownedOnly: true,
    url: '/assets/weapons/retro_shotgun_arms.glb',
    ...authoredMount,
    // Full 17-clip retro GLB built from the pack's BONE-family gun actions (shotgun01_*):
    // correctly oriented at bind (no rig rotation needed) and the arms' hand-IK follows
    // them, so fire pumps + reload feed with the hands ON the gun. (The object-family
    // movement_* sway is intentionally not used — the exporter mis-bases it 90deg and the
    // arms can't follow it; procedural bob covers locomotion sway anyway.) ADS uses the
    // aim_* / *_aiming clips; recoilForce still adds procedural kick.
    ...withAds(82, 0.10, 0.08),
    // play the pump/aim one-shots a touch faster than authored so the shotgun reads
    // snappier (both hands + gun scale together, so they stay synced).
    animSpeed: 1.3,
    // aimed framing: now that the shotgun has custom aim animations, we just need
    // a slight downward and forward offset to drop the receiver out of the sights
    // and prevent arm clipping.
    adsMount: { position: { x: 0.0, y: -0.03, z: 0.05 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } },
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
    // Body-zone override: the Pistol is the precision finisher, so its HEAD hit is
    // 2.5x (34 -> 85, near-instakill) vs the roster default of 2.0. torso/legs inherit
    // the default. See DEFAULT_ZONE_MULTIPLIERS / LEG_DAMAGE_MULT above.
    zoneMultipliers: { ...DEFAULT_ZONE_MULTIPLIERS, head: 2.5 },
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
    // DISABLED (user call, 2026-07-22): all energy weapons are out for now. The
    // entry STAYS so indices/protocol/weaponsState shapes never shift — consumers
    // must honor the flag: excluded from ALL_WEAPONS (bots), bot loadout picks,
    // map weapon/ammo pickups (resolvePickup) and death drops. Flip to re-enable.
    disabled: true,
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
    // DISABLED (user call, 2026-07-22): reads energy-like in play — out with Plasma
    // for now. Same contract: slot stays, consumers honor the flag. Flip to re-enable.
    disabled: true,
    url: '/assets/weapons/retro_shotgun_arms.glb',
    ...authoredMount,
    // Shares the Shotgun's 17-clip GLB (bone-family, correctly oriented, hands follow the
    // gun — see slot 2). Deliberately NO ads block: Flak stays hip-fire (its "own the
    // doorway" burst identity) — a clean choice, not a half state.
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
  },
  {
    index: 6,
    name: 'Sniper',
    // OWNERSHIP-GATED, not disabled. `ownedOnly` keeps it out of ENABLED_WEAPON_INDICES
    // — so it never spawns as a floor pickup and is never handed out by the default
    // loadout — while still being a fully live weapon the server can GRANT to a player
    // who holds the NFT. Season 1 rule: "no free pickups, you own it you use it."
    //
    // Deliberately NOT wired into pickupConfig: CTF-Visage ships 6 `sniper_rifle` spawn
    // points (currently split Rifle/SMG, see pickupConfig.js:33). Mapping them to this
    // weapon is the obvious move and is exactly what the no-free-pickups rule forbids.
    ownedOnly: true,
    url: '/assets/weapons/retro_sniper_arms.glb',
    ...authoredMount,
    // Numbers from the round-robin design panel (scratch/sniper-scope/, 2026-07-26):
    // 4 seats (sandbox/netcode/UX/economy) + chair rulings. See 00-SUMMARY.md.
    //
    // ADS fov 40 is the FIRST weapon to break the >=75deg floor the rest of the rack
    // keeps. That floor exists so you are never blind to flankers — breaking it IS the
    // sniper's cost, and it is why the scope-in sound is load-bearing counterplay.
    // Panel considered 30deg and rejected it: on a phone the thumb travel to cross the
    // screen becomes unusable. inTime 0.24 / outTime 0.16 keeps out faster than in, like
    // every other weapon here.
    //
    // `extra` mults are consumed in weapon.fire/firePattern/applyCommand scaled by
    // entity.aimFactor. Scoped is pixel-perfect (spread mults 0); hip-fire is
    // DELIBERATELY gutted via spreadBase 0.20 so this cannot double as a corridor
    // shotgun — no-scoping is not a play, you swap to the spawn Pistol.
    ...withAds(40, 0.24, 0.16, { spreadBaseMult: 0, spreadHeatMult: 0, heatMult: 1 }),
    adsMount: { position: { x: 0, y: -0.02, z: 0.05 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } },
    muzzle: { x: 0.08, y: -0.13, z: 1.35 },
    recoilForce: 3.0,
    drawTime: 0.55,

    // VERB: punish a sightline. 110 on a head (2.0x zone) is a one-shot kill at 100 HP;
    // 55 on a body is a two-shot. The 1.5s cooldown IS the counterplay window — a
    // Pistol-only player who hears the scope has a full beat to break the line.
    type: 'hitscan',
    fireCooldown: 1.5,
    reloadTime: 2.2,
    magazineCapacity: 5,
    maxReserveAmmo: 15,
    damage: 55,
    range: 120,           // longest on the rack; caps the lag-comp rewind check distance
    spreadBase: 0.20,     // HIP only — scoped zeroes this via the ADS mults above
    spreadHeat: 0.40
  }
  // Roster is 7 weapons (0-6): Rifle, SMG, Shotgun, Pistol, Sniper are hitscan;
  // Plasma (4) + Flak (5) are projectile. The projectile plumbing (Projectile
  // entity, factory, bolt rendering, plasmaImpact FX) is reused by both; their
  // slow/pellet/bounce mechanics land in Phase 2.
]

// Roster indices that are FREELY in play — not `disabled`, and not `ownedOnly`.
// Disabled entries keep their slot (indices/protocol never shift) but every
// spawner/loot/loadout consumer draws from this list.
//
// SEASON 1 (2026-07-26): this list is now JUST THE PISTOL. Plasma + Flak are disabled
// (energy weapons out, 2026-07-22) and every remaining weapon is ownership-gated. That
// is the whole "no free pickups" rule expressed as data: a spawner that draws from this
// list CANNOT place a gated weapon, so the rule holds by construction and not by
// remembering to check a flag at each call site.
//
// It is therefore normal — not a bug — for this to have length 1. Anything that needs
// "every weapon a bot may actually hold" wants PLAYABLE_WEAPON_INDICES below; drawing a
// bot loadout from THIS list would arm the whole arena with pistols.
export const ENABLED_WEAPON_INDICES = weapons.reduce(
	(list, w, i) => (w.disabled || w.ownedOnly ? list : (list.push(i), list)), [])

// Every weapon that is LIVE at all — free or gated, excluding only `disabled` entries.
// This is the "full arsenal" in the gameplay sense: what a bot may hold in a bot-only
// match, and the ceiling any grant can reach. Distinct from ENABLED_WEAPON_INDICES
// (which is about what may be FOUND) and from PlayerCharacter.ALL_WEAPONS (which
// deliberately excludes ownedOnly so no default-loadout path can leak a gated weapon).
export const PLAYABLE_WEAPON_INDICES = weapons.reduce(
	(list, w, i) => (w.disabled ? list : (list.push(i), list)), [])

// Live weapons that exist but must be EARNED, not found. They are fully playable — the
// server grants them to a verified holder — but no spawner, loot table or default
// loadout may draw from this list, which is what keeps "no free pickups" true by
// construction rather than by remembering to check a flag at every call site.
export const OWNED_ONLY_WEAPON_INDICES = weapons.reduce(
	(list, w, i) => (!w.disabled && w.ownedOnly ? (list.push(i), list) : list), [])

export default weapons
