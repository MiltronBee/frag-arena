// Firing / ballistics PRESENTATION config + pure helpers.
//
// This file holds ZERO gameplay values. Damage, fire rate, ammo, range, spread,
// projectileSpeed and all server authority live in common/weaponsConfig.js and are
// untouched by this pass. Everything here is client-render only — the server never
// imports it. Colors are plain [r,g,b] arrays (0..1) so this module has no babylon
// dependency and is unit-testable under plain node.
//
// UT99 lesson (not imitation): instantaneous readability, violent contrast, compact
// effect lifetimes, unmistakable per-weapon identity, speed. So tracers are thin,
// additive and extremely short-lived; muzzle flashes are a bright sprite + soft
// bloom (NOT a runtime dynamic light — those force Babylon shader recompiles and
// cost every frame on mobile); impacts are small, surface-aware and normal-oriented;
// the plasma bolt is a tight hot core, not a soft neon orb.

// ---------------------------------------------------------------------------
// Per-weapon presentation presets, keyed by the weapon's gameplay index (0..5):
// 0 Rifle, 1 SMG, 2 Shotgun, 3 Pistol, 4 Plasma (cyan projectile), 5 Flak (green projectile).
// tracer:null => the weapon renders no hitscan tracer (plasma uses a projectile).
// projectile != null => plasma bolt visual params.
// report => procedural WebAudio synth params (see WeaponAudio.voiceParams).
// recoil => AIM-SAFE kick: camera POSITIONAL offset only (world units) + shake
//           amplitude. It never rotates the aim, so fire-ray / MoveCommand
//           authority is byte-identical (getForwardRay().direction is rotation-only).
// ---------------------------------------------------------------------------
// camKick = per-weapon VISUAL camera recoil identity (Simulator._applyCamRecoil).
//   A ROTATION offset (pitch climb + signed yaw drift + subtle roll) applied to the
//   render camera AFTER the fire ray / MoveCommand aim are read that frame, and fully
//   REMOVED before the next read — the identical apply-late / remove-first pattern
//   FragLayer.applyDeathCamera() already ships. It is therefore PROVABLY invisible to
//   getForwardRay(): the shot ray + aim bytes are byte-identical with or without it.
//   Angles are DEGREES here (Simulator converts once to radians). `pitch`/`yawDrift`/
//   `roll` are per-shot impulses; `heatBias` scales the pitch climb by the shot's
//   predicted heat (ray.heat — the same heat the server charges spread with, so the
//   FELT recoil mirrors the accuracy penalty with zero netcode change); `climb`/
//   `climbMax` add a capped sustained-fire lean on autos; `tension`/`damping` are the
//   critically-ish damped return spring (ζ≈1, settle inside the CS-style recovery
//   window). `fov` (shotgun only) = a small world-camera FOV punch fraction; the
//   viewmodel renders on the SEPARATE fixed-fov vmCamera, so the gun never distorts.
// vmKick = per-weapon PROCEDURAL viewmodel recoil personality (Viewmodel.kick):
//   back/up/pitch/yaw impulse scale + spring tension/damping (snappy vs heavy),
//   optional pump = a delayed second rack impulse (shotgun), plus `roll` (±rad, random
//   sign) and per-shot `variance` (multiplies back/up/pitch each shot) for Vlambeer
//   "vary everything" — repeated shots stop reading as a metronome.
// eject = brass casing: camera-local port offset, delay ms (pump guns eject on
//   the rack, not the shot), casing size + color. null = no brass.
// light = muzzle light pulse: intensity/range/life for the SINGLE pre-created
//   scene point light (BABYLONRenderer._muzzleLight). One light created at init
//   and pulsed by intensity keeps the scene's light count constant, so firing
//   never triggers the StandardMaterial shader recompile that per-shot dynamic
//   lights would. Color comes from muzzle.color. null = no world light.
// smoke = barrel smoke: an alpha-blended gray puff that swells + drifts up off
//   the muzzle tip (world layer). chance<1 gates full-auto so the SMG doesn't
//   stack a solid overdraw column; gray is the puff brightness (0..1).
const WEAPON_FX = {
  // 0 — Rifle: disciplined, sharp single report + crisp gold tracer.
  0: {
    tracer: { color: [1.0, 0.80, 0.34], core: [1.0, 0.96, 0.72], width: 0.018, life: 50, chance: 1.0 },
    muzzle: { color: [1.0, 0.80, 0.42], scale: 0.24, glowScale: 0.40, life: 42 },
    impact: { scale: 0.22 },
    recoil: { back: 0.040, rise: 0.020, shake: 0.55 },
    // disciplined punch: small climb, subtle right drift, quick 220ms settle.
    camKick: { pitch: 0.45, yawDrift: 0.06, yawJitter: 0.05, climb: 0.15, climbMax: 1.8,
               heatBias: 0.4, tension: 950, damping: 62, roll: 0.10 },
    vmKick: { back: 0.5, up: 0.06, pitch: 0.35, yaw: 0.06, tension: 280, damping: 23,
              roll: 0.010, variance: 0.2 },
    eject: { x: 0.14, y: -0.10, z: 0.55, delay: 0, size: 0.020, color: [0.85, 0.62, 0.22] },
    light: { intensity: 2.1, range: 9, life: 70, decayPow: 2, jitter: 0.15 },
    smoke: { chance: 0.45, scale: 0.15, life: 650, gray: 0.5 },
    report: { kind: 'ballistic', level: 0.85, bodyFreq: 220, bodyDrop: 62, noiseHz: 2200, noiseQ: 0.9, decay: 0.14, mech: 0.5 },
    projectile: null,
  },
  // 1 — SMG: rapid compact staccato. Thinner, shorter tracer, and NOT every round
  // (chance<1) so full-auto cadence stays readable instead of a solid rope.
  // Minigun-lesson feel: tiny fast buzzy kicks, brass FOUNTAIN.
  1: {
    tracer: { color: [1.0, 0.66, 0.28], core: [1.0, 0.88, 0.60], width: 0.010, life: 30, chance: 0.5 },
    muzzle: { color: [1.0, 0.82, 0.45], scale: 0.17, glowScale: 0.26, life: 26 },
    impact: { scale: 0.18 },
    recoil: { back: 0.024, rise: 0.012, shake: 0.34 },
    // rattly climb: lower per-shot pitch but higher heat bias + left drift; fast 160ms
    // recovery keeps the picture honest between the SMG's tight bursts.
    camKick: { pitch: 0.22, yawDrift: -0.04, yawJitter: 0.18, climb: 0.25, climbMax: 2.2,
               heatBias: 0.6, tension: 1500, damping: 80, roll: 0.16 },
    vmKick: { back: 0.22, up: 0.03, pitch: 0.16, yaw: 0.10, tension: 500, damping: 31,
              roll: 0.018, variance: 0.3 },
    eject: { x: 0.13, y: -0.11, z: 0.45, delay: 0, size: 0.016, color: [0.85, 0.62, 0.22] },
    // strobe the light on ~60% of shots (like its tracer chance) so sustained fire
    // flickers instead of holding a constant glow (a held light reads LESS violent).
    light: { intensity: 1.15, range: 8, life: 55, decayPow: 2, jitter: 0.15, chance: 0.6 },
    smoke: { chance: 0.22, scale: 0.11, life: 520, gray: 0.45 },
    report: { kind: 'ballistic', level: 0.62, bodyFreq: 262, bodyDrop: 92, noiseHz: 2850, noiseQ: 1.0, decay: 0.075, mech: 0.42 },
    projectile: null,
  },
  // 2 — Shotgun (flak lesson): violent muzzle volume, HEAVY slow-recover shove,
  // then a pump rack (second kick + clack + shell out) ~350ms later.
  2: {
    tracer: { color: [1.0, 0.72, 0.36], core: [1.0, 0.92, 0.7], width: 0.010, life: 34, chance: 1.0, pelletTracers: 6 },
    muzzle: { color: [1.0, 0.72, 0.36], scale: 0.42, glowScale: 0.66, life: 55 },
    impact: { scale: 0.30 },
    recoil: { back: 0.090, rise: 0.048, shake: 1.15 },
    // heavy single shove: big one-shot pitch, no heat/climb term (single-shot cadence),
    // a wide random yaw jar, slow 380ms recovery + a small pump dip at 350ms so the
    // whole body agrees with the rack. fov = a ~-5% world-camera concussion punch
    // (zoom IN on blast, sells forward momentum): shotgun-ONLY, world camera only.
    camKick: { pitch: 1.20, yawDrift: 0, yawJitter: 0.20, climb: 0, climbMax: 0,
               heatBias: 0, tension: 380, damping: 39, roll: 0.30,
               pumpDip: { delay: 350, pitch: 0.15 },
               fov: { amount: -0.05, inMs: 50, outMs: 180 } },
    vmKick: { back: 1.0, up: 0.16, pitch: 0.65, yaw: 0.05, tension: 95, damping: 23,
              pump: { delay: 350, back: 0.35, pitch: 0.22 }, roll: 0.030, variance: 0.1 },
    eject: { x: 0.10, y: -0.12, z: 0.50, delay: 350, size: 0.030, color: [0.75, 0.16, 0.10] },
    light: { intensity: 3.2, range: 13, life: 110, decayPow: 2, jitter: 0.15 },
    smoke: { chance: 1.0, scale: 0.42, life: 1200, gray: 0.55 },
    report: { kind: 'shotgun', level: 1.0, bodyFreq: 140, bodyDrop: 46, noiseHz: 1400, noiseQ: 0.6, decay: 0.30, mech: 0.7 },
    projectile: null,
  },
  // 3 — Pistol (Enforcer lesson): hard single crack, snappy high muzzle flick,
  // laser-accurate. One clean hole per trigger pull.
  3: {
    tracer: { color: [1.0, 0.96, 0.82], core: [1.0, 1.0, 0.96], width: 0.012, life: 44, chance: 1.0 },
    muzzle: { color: [1.0, 0.82, 0.45], scale: 0.20, glowScale: 0.32, life: 34 },
    impact: { scale: 0.20 },
    recoil: { back: 0.050, rise: 0.030, shake: 0.62 },
    // snappy flick: one sharp upward crack per shot — every shot is a "first shot"
    // (no climb/heat term), tight yaw jitter, and a ~110ms critically-damped (ζ≈1.0)
    // recovery that completes before the next click — the crosshair picture is honest
    // again before you can re-fire (first-shot feel). roll:0 keeps the Enforcer clean.
    camKick: { pitch: 0.55, yawDrift: 0, yawJitter: 0.07, climb: 0, climbMax: 0,
               heatBias: 0, tension: 1400, damping: 75, roll: 0 },
    vmKick: { back: 0.45, up: 0.11, pitch: 0.6, yaw: 0.04, tension: 450, damping: 30,
              roll: 0.008, variance: 0.16 },
    eject: { x: 0.20, y: -0.02, z: 0.60, delay: 0, size: 0.018, color: [0.85, 0.62, 0.22] },
    light: { intensity: 1.5, range: 8, life: 70, decayPow: 2, jitter: 0.15 },
    // the UT99 enforcer signature: one clean hole, one lazy smoke wisp
    smoke: { chance: 1.0, scale: 0.17, life: 950, gray: 0.5 },
    report: { kind: 'ballistic', level: 0.9, bodyFreq: 200, bodyDrop: 70, noiseHz: 2000, noiseQ: 1.1, decay: 0.12, mech: 0.6 },
    projectile: null,
  },
  // 4 — Plasma Repeater: cyan energy identity. The projectile bolt carries the
  // visual (chance:0 so no hitscan tracer), light-climb auto with soft recovery.
  4: {
    tracer: { color: [0.45, 0.85, 1.0], core: [0.85, 0.98, 1.0], width: 0.013, life: 30, chance: 0.0 }, // bolt carries the visual; keep chance 0 so no hitscan tracer
    muzzle: { color: [0.45, 0.85, 1.0], scale: 0.20, glowScale: 0.34, life: 34 },
    impact: { scale: 0.20 },
    recoil: { back: 0.030, rise: 0.016, shake: 0.40 },
    camKick: { pitch: 0.30, yawDrift: 0.03, yawJitter: 0.15, climb: 0.10, climbMax: 0.8,
               heatBias: 0.3, tension: 1100, damping: 60 },
    vmKick: { back: 0.30, up: 0.04, pitch: 0.22, yaw: 0.06, tension: 420, damping: 28,
              roll: 0.012, variance: 0.25 },
    eject: null,
    light: { intensity: 1.4, range: 8, life: 60, decayPow: 2, jitter: 0.15 },
    smoke: { chance: 0.0, scale: 0.0, life: 0, gray: 0.0 },
    report: { kind: 'ballistic', level: 0.7, bodyFreq: 300, bodyDrop: 120, noiseHz: 3200, noiseQ: 1.2, decay: 0.10, mech: 0.35 },
    projectile: null,
  },
  // 5 — Flak Cannon: heavy, shotgun-like feel but a projectile. Big single shove +
  // FOV concussion punch, dirty green muzzle, long low report.
  5: {
    tracer: { color: [0.6, 1.0, 0.5], core: [0.9, 1.0, 0.8], width: 0.014, life: 34, chance: 0.0 },
    muzzle: { color: [0.6, 1.0, 0.5], scale: 0.40, glowScale: 0.62, life: 46 },
    impact: { scale: 0.24 },
    recoil: { back: 0.080, rise: 0.042, shake: 1.0 },
    camKick: { pitch: 1.20, yawDrift: 0, yawJitter: 0.20, climb: 0, climbMax: 1.2,
               heatBias: 0, tension: 380, damping: 39,
               fov: { amount: -0.04, inMs: 50, outMs: 180 } },
    vmKick: { back: 0.9, up: 0.15, pitch: 0.60, yaw: 0.05, tension: 100, damping: 24,
              roll: 0.028, variance: 0.12 },
    eject: null,
    light: { intensity: 2.8, range: 12, life: 100, decayPow: 2, jitter: 0.15 },
    smoke: { chance: 0.6, scale: 0.30, life: 900, gray: 0.5 },
    report: { kind: 'shotgun', level: 0.95, bodyFreq: 150, bodyDrop: 50, noiseHz: 1500, noiseQ: 0.6, decay: 0.28, mech: 0.6 },
    projectile: null,
  },
}

// Fallback for shots we render without a known weapon identity — chiefly OTHER
// players' hitscan (the WeaponFired network message carries origin+direction only,
// no weapon id). Neutral hot ballistic tracer + generic crack, distance-attenuated
// by the caller.
const REMOTE_FX = {
  tracer: { color: [1.0, 0.74, 0.48], core: [1.0, 0.95, 0.8], width: 0.016, life: 42, chance: 1.0 },
  muzzle: { color: [1.0, 0.76, 0.42], scale: 0.25, glowScale: 0.38, life: 42 },
  impact: { scale: 0.22 },
  recoil: { back: 0, rise: 0, shake: 0 },
  vmKick: null,
  camKick: null, // remote players never recoil the local camera (see REMOTE_FX note)
  eject: null,
  light: { intensity: 1.5, range: 9, life: 70, decayPow: 2, jitter: 0.15 },
  smoke: { chance: 0.4, scale: 0.15, life: 600, gray: 0.5 },
  report: { kind: 'ballistic', level: 0.7, bodyFreq: 210, bodyDrop: 66, noiseHz: 2100, noiseQ: 0.9, decay: 0.13, mech: 0.45 },
  projectile: null,
}

// Surface-aware impact styling. `color` is [r,g,b]; `sprite` selects the pooled
// impact material; `scaleMul` multiplies the weapon's base impact scale; `life` ms;
// `spark` adds a brief secondary spark burst. Kept small + brief so targets are
// never obscured (design: "Do not obscure targets").
// UT99 enforcer-hit read: white-hot spark + dark scorch mark + drifting smoke,
// never a colored glow ring. `additive` picks the mark's blend (hot additive vs
// dark alpha-blended scorch); `smoke` adds the slow dissipating puff.
// Scorch lifetimes are LONG (UT99 wall marks): the grouping a weapon paints on a
// wall is part of its identity, so marks must persist long enough to read the
// pattern. Pool recycling (BABYLONRenderer POOLS.impact) caps sustained-fire cost.
const SURFACE_FX = {
  flesh:    { color: [0.5, 0.02, 0.02],  sprite: 'blood_splat', additive: false, scaleMul: 1.5, life: 480, spark: false, smoke: false, blood: true },
  stone:    { color: [0.10, 0.09, 0.08], sprite: 'scorch', additive: false, scaleMul: 1.55, life: 3200, spark: true,  smoke: true },
  metal:    { color: [0.08, 0.08, 0.09], sprite: 'scorch', additive: false, scaleMul: 1.25, life: 3000, spark: true,  smoke: true },
  concrete: { color: [0.09, 0.09, 0.10], sprite: 'scorch', additive: false, scaleMul: 1.55, life: 3200, spark: true,  smoke: true },
  energy:   { color: [0.42, 0.95, 1.0],  sprite: 'spark',  additive: true,  scaleMul: 1.05, life: 130, spark: true,  smoke: false },
}

// Resolve a weapon's FX preset. `spec` is a weaponsConfig entry (or null for the
// remote/unknown case). Always returns a fully-populated object.
function resolveWeaponFx(spec) {
  if (!spec) return REMOTE_FX
  return WEAPON_FX[spec.index] || REMOTE_FX
}

// Classify the picked mesh into a surface key. Prefers an explicit tag
// (mesh.metadata.fragSurface, set by CharacterModel / obstacle factory), then falls
// back to a name heuristic. Never throws on a null/odd mesh.
function classifySurface(mesh) {
  if (!mesh) return 'concrete'
  const tag = mesh.metadata && mesh.metadata.fragSurface
  if (tag && SURFACE_FX[tag]) return tag
  const name = (mesh.name || '').toLowerCase()
  if (name.indexOf('player') !== -1 || name.indexOf('erebus') !== -1 || name.indexOf('char') !== -1) return 'flesh'
  if (name.indexOf('obstacle') !== -1 || name.indexOf('accent') !== -1) return 'stone'
  if (name.indexOf('ground') !== -1) return 'concrete'
  return 'concrete'
}

function surfaceFx(key) {
  return SURFACE_FX[key] || SURFACE_FX.concrete
}

// Fade envelope over an effect's life. t is 0..1 (age/life). `power` shapes the
// falloff: 1 = linear, 2 = punchy fast fade (muzzle). Always clamped to [0,1].
function fadeAlpha(t, power = 1) {
  if (t <= 0) return 1
  if (t >= 1) return 0
  const a = 1 - t
  return power === 1 ? a : Math.pow(a, power)
}

// Distance attenuation for a remote/positional shot's loudness. 1.0 at the camera,
// smoothly decreasing with distance (inverse-square-ish, floored so far shots stay
// faintly audible). `ref` is the ~half-volume distance in world units.
function distanceGain(distance, ref = 14) {
  const d = Math.max(0, distance || 0)
  const g = 1 / (1 + (d / ref) * (d / ref))
  return Math.max(0.05, Math.min(1, g))
}

export {
  WEAPON_FX,
  REMOTE_FX,
  SURFACE_FX,
  resolveWeaponFx,
  classifySurface,
  surfaceFx,
  fadeAlpha,
  distanceGain,
}
