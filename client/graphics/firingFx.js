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
// Per-weapon presentation presets, keyed by the weapon's gameplay index (0..4).
// tracer:null => the weapon renders no hitscan tracer (plasma uses a projectile).
// projectile != null => plasma bolt visual params.
// report => procedural WebAudio synth params (see WeaponAudio.voiceParams).
// recoil => AIM-SAFE kick: camera POSITIONAL offset only (world units) + shake
//           amplitude. It never rotates the aim, so fire-ray / MoveCommand
//           authority is byte-identical (getForwardRay().direction is rotation-only).
// ---------------------------------------------------------------------------
// vmKick = per-weapon PROCEDURAL viewmodel recoil personality (Viewmodel.kick):
//   back/up/pitch/yaw impulse scale + spring tension/damping (snappy vs heavy),
//   optional pump = a delayed second rack impulse (shotgun).
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
    tracer: { color: [1.0, 0.86, 0.46], core: [1.0, 1.0, 0.85], width: 0.016, life: 42, chance: 1.0 },
    muzzle: { color: [1.0, 0.80, 0.42], scale: 0.24, glowScale: 0.40, life: 40 },
    impact: { scale: 0.22 },
    recoil: { back: 0.040, rise: 0.020, shake: 0.55 },
    vmKick: { back: 0.5, up: 0.06, pitch: 0.35, yaw: 0.06, tension: 150, damping: 18 },
    eject: { x: 0.14, y: -0.10, z: 0.55, delay: 0, size: 0.020, color: [0.85, 0.62, 0.22] },
    light: { intensity: 1.7, range: 9, life: 70 },
    smoke: { chance: 0.45, scale: 0.15, life: 650, gray: 0.5 },
    report: { kind: 'ballistic', level: 0.85, bodyFreq: 220, bodyDrop: 62, noiseHz: 2200, noiseQ: 0.9, decay: 0.14, mech: 0.5 },
    projectile: null,
  },
  // 1 — SMG: rapid compact staccato. Thinner, shorter tracer, and NOT every round
  // (chance<1) so full-auto cadence stays readable instead of a solid rope.
  // Minigun-lesson feel: tiny fast buzzy kicks, brass FOUNTAIN.
  1: {
    tracer: { color: [1.0, 0.82, 0.44], core: [1.0, 0.98, 0.8], width: 0.012, life: 34, chance: 0.5 },
    muzzle: { color: [1.0, 0.82, 0.45], scale: 0.17, glowScale: 0.26, life: 30 },
    impact: { scale: 0.18 },
    recoil: { back: 0.024, rise: 0.012, shake: 0.34 },
    vmKick: { back: 0.22, up: 0.03, pitch: 0.16, yaw: 0.10, tension: 220, damping: 15 },
    eject: { x: 0.13, y: -0.11, z: 0.45, delay: 0, size: 0.016, color: [0.85, 0.62, 0.22] },
    light: { intensity: 1.15, range: 8, life: 55 },
    smoke: { chance: 0.22, scale: 0.11, life: 520, gray: 0.45 },
    report: { kind: 'ballistic', level: 0.62, bodyFreq: 262, bodyDrop: 92, noiseHz: 2850, noiseQ: 1.0, decay: 0.075, mech: 0.42 },
    projectile: null,
  },
  // 2 — Shotgun (flak lesson): violent muzzle volume, HEAVY slow-recover shove,
  // then a pump rack (second kick + clack + shell out) ~350ms later.
  2: {
    tracer: { color: [1.0, 0.72, 0.36], core: [1.0, 0.92, 0.7], width: 0.014, life: 38, chance: 1.0, pelletTracers: 4 },
    muzzle: { color: [1.0, 0.72, 0.36], scale: 0.42, glowScale: 0.66, life: 48 },
    impact: { scale: 0.24 },
    recoil: { back: 0.090, rise: 0.048, shake: 1.15 },
    vmKick: { back: 1.0, up: 0.16, pitch: 0.65, yaw: 0.05, tension: 95, damping: 13,
              pump: { delay: 350, back: 0.35, pitch: 0.22 } },
    eject: { x: 0.10, y: -0.12, z: 0.50, delay: 350, size: 0.030, color: [0.75, 0.16, 0.10] },
    light: { intensity: 3.2, range: 13, life: 110 },
    smoke: { chance: 1.0, scale: 0.42, life: 1200, gray: 0.55 },
    report: { kind: 'shotgun', level: 1.0, bodyFreq: 140, bodyDrop: 46, noiseHz: 1400, noiseQ: 0.6, decay: 0.30, mech: 0.7 },
    projectile: null,
  },
  // 3 — Pistol (Enforcer lesson): hard single crack, snappy high muzzle flick,
  // laser-accurate. One clean hole per trigger pull.
  3: {
    tracer: { color: [1.0, 0.86, 0.5], core: [1.0, 1.0, 0.88], width: 0.013, life: 40, chance: 1.0 },
    muzzle: { color: [1.0, 0.82, 0.45], scale: 0.20, glowScale: 0.32, life: 36 },
    impact: { scale: 0.20 },
    recoil: { back: 0.050, rise: 0.030, shake: 0.62 },
    vmKick: { back: 0.45, up: 0.11, pitch: 0.6, yaw: 0.04, tension: 195, damping: 17 },
    eject: { x: 0.20, y: -0.02, z: 0.60, delay: 0, size: 0.018, color: [0.85, 0.62, 0.22] },
    light: { intensity: 1.9, range: 9, life: 80 },
    // the UT99 enforcer signature: one clean hole, one lazy smoke wisp
    smoke: { chance: 1.0, scale: 0.17, life: 950, gray: 0.5 },
    report: { kind: 'ballistic', level: 0.9, bodyFreq: 200, bodyDrop: 70, noiseHz: 2000, noiseQ: 1.1, decay: 0.12, mech: 0.6 },
    projectile: null,
  },
  // (index 4, the plasma preset, was removed with the weapon slot — see
  // weaponsConfig.js. The projectile/energy FX plumbing it drove is kept.)
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
  eject: null,
  light: { intensity: 1.5, range: 9, life: 70 },
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
  flesh:    { color: [0.82, 0.06, 0.06], sprite: 'hit',    additive: false, scaleMul: 0.95, life: 150, spark: false, smoke: false },
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
