// Pure unit checks for client/TouchLook.js — the touch look math (CSS-px drag
// deltas -> yaw/pitch radians). No browser, no server, no bundler: the real
// module is the single source of truth, loaded here as an ES module via a
// data: URL (it has no imports and touches only Math, so it runs under Node).
//
// Exit code 0 = all assertions passed, 1 = failure.
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/TouchLook.js', import.meta.url), 'utf8')
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src))
const { computeLookDelta, flickMultiplier, YAW_DEG_PER_PX, YAW_RAD_PER_PX, VERTICAL_GAIN,
  FLICK_LO, FLICK_HI, FLICK_MAX } = mod

// A "slow" drag stays below FLICK_LO px/ms so flick acceleration is inert and the
// mapping is purely proportional (the pre-flick behavior). Use a big dt so
// speed = distance/dt < FLICK_LO for the deltas below.
const SLOW_DT = 100000

const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const finite = (n) => typeof n === 'number' && Number.isFinite(n)
const DEG = Math.PI / 180

// --- constants / calibration -------------------------------------------------

check('constants: 0.22 deg/px, 0.8x vertical',
  YAW_DEG_PER_PX === 0.22 && VERTICAL_GAIN === 0.8 && approx(YAW_RAD_PER_PX, 0.22 * DEG),
  `deg/px=${YAW_DEG_PER_PX} vert=${VERTICAL_GAIN} rad/px=${YAW_RAD_PER_PX.toFixed(6)}`)

// yaw gain is exactly 0.22 deg per CSS px at sensitivity 1.0
{
  const one = computeLookDelta(1, 0, 16, { sensitivity: 1 })
  check('yaw gain = 0.22 deg/px @ sens 1.0', approx(one.yaw, 0.22 * DEG),
    `yaw(1px)=${one.yaw.toFixed(6)} rad (${(one.yaw / DEG).toFixed(4)} deg)`)
}

// a 400 px SLOW horizontal drag turns ~88 degrees at the default sensitivity
// (slow = below the flick threshold, so acceleration is inert)
{
  const r = computeLookDelta(400, 0, SLOW_DT, { sensitivity: 1 })
  const deg = r.yaw / DEG
  check('400px slow drag -> ~88 deg yaw', approx(deg, 88, 1e-6), `${deg.toFixed(3)} deg`)
}

// --- vertical gain -----------------------------------------------------------

{
  const h = computeLookDelta(100, 0, SLOW_DT, {})   // pure horizontal, slow
  const v = computeLookDelta(0, 100, SLOW_DT, {})   // pure vertical, same distance
  check('pitch is 0.8x yaw for equal deltas', approx(v.pitch / h.yaw, 0.8),
    `ratio=${(v.pitch / h.yaw).toFixed(6)}`)
  check('pure horizontal produces no pitch', v.pitch !== 0 && h.pitch === 0,
    `h.pitch=${h.pitch}`)
}

// --- touch sensitivity multiplier --------------------------------------------

{
  // same deltas + dt on both sides, so any flick multiplier is identical and the
  // sensitivity ratio still holds exactly
  const a = computeLookDelta(100, 80, 16, { sensitivity: 1 })
  const b = computeLookDelta(100, 80, 16, { sensitivity: 2 })
  check('sensitivity 2x doubles yaw and pitch',
    approx(b.yaw, a.yaw * 2) && approx(b.pitch, a.pitch * 2),
    `yaw ${a.yaw.toFixed(4)}->${b.yaw.toFixed(4)}, pitch ${a.pitch.toFixed(4)}->${b.pitch.toFixed(4)}`)
}

// --- invert-Y ----------------------------------------------------------------

{
  const def = computeLookDelta(0, 100, 16, {})                 // default
  const off = computeLookDelta(0, 100, 16, { invertY: false })
  const on = computeLookDelta(0, 100, 16, { invertY: true })
  check('invert-Y defaults to off', approx(def.pitch, off.pitch) && def.pitch > 0,
    `default pitch=${def.pitch.toFixed(4)}`)
  check('invert-Y flips pitch sign only (equal magnitude)',
    approx(on.pitch, -off.pitch) && approx(on.yaw, off.yaw),
    `off=${off.pitch.toFixed(4)} on=${on.pitch.toFixed(4)} yaw eq=${approx(on.yaw, off.yaw)}`)
}

// --- flick acceleration ------------------------------------------------------

check('flick constants: LO<HI, MAX>1',
  FLICK_LO === 0.35 && FLICK_HI === 1.4 && FLICK_MAX === 2.2 && FLICK_LO < FLICK_HI && FLICK_MAX > 1,
  `LO=${FLICK_LO} HI=${FLICK_HI} MAX=${FLICK_MAX}`)

{
  // multiplier curve: flat 1.0 up to LO, ramps to MAX at HI, clamps above
  const at = (speed) => flickMultiplier(speed, 0, 1)   // dt=1ms so px/ms == dx
  check('flick: slow speed (<=LO) => 1.0x', at(0) === 1 && at(FLICK_LO) === 1 && at(FLICK_LO - 0.1) === 1,
    `at(0)=${at(0)} at(LO)=${at(FLICK_LO)}`)
  check('flick: fast speed (>=HI) => MAX (clamped)', approx(at(FLICK_HI), FLICK_MAX) && approx(at(FLICK_HI + 10), FLICK_MAX),
    `at(HI)=${at(FLICK_HI).toFixed(4)} at(HI+10)=${at(FLICK_HI + 10).toFixed(4)}`)
  const mid = at((FLICK_LO + FLICK_HI) / 2)
  check('flick: midpoint speed is between 1 and MAX (monotonic ramp)',
    mid > 1 && mid < FLICK_MAX && approx(mid, 1 + 0.5 * (FLICK_MAX - 1)),
    `mid=${mid.toFixed(4)}`)
}

{
  // a fast flick scales the rotation up vs. the identical-distance slow drag
  const dist = 300
  const slow = computeLookDelta(dist, 0, SLOW_DT, {})     // ~0 px/ms -> 1.0x
  const fast = computeLookDelta(dist, 0, dist / 2, {})    // 2 px/ms -> clamps to MAX
  check('flick: fast drag scales up to MAX vs slow drag of same distance',
    approx(fast.yaw / slow.yaw, FLICK_MAX),
    `ratio=${(fast.yaw / slow.yaw).toFixed(4)} (expected ${FLICK_MAX})`)
  check('flick: slow drag is bit-identical to base gain (no acceleration)',
    approx(slow.yaw, dist * YAW_RAD_PER_PX),
    `slow.yaw=${slow.yaw.toFixed(6)} base=${(dist * YAW_RAD_PER_PX).toFixed(6)}`)
}

// --- zero / safety -----------------------------------------------------------

{
  const z = computeLookDelta(0, 0, 16, {})
  check('zero delta -> zero rotation', z.yaw === 0 && z.pitch === 0, JSON.stringify(z))
}

{
  // invalid/zero dt must never throw or produce NaN, and must yield NO
  // acceleration (multiplier 1.0) — i.e. the base proportional gain
  const ref = computeLookDelta(90, 30, SLOW_DT, {})   // slow drag == base gain
  const bad = [0, -50, NaN, undefined, Infinity].map((dt) => computeLookDelta(90, 30, dt, {}))
  const ok = bad.every((r) => finite(r.yaw) && finite(r.pitch) &&
    approx(r.yaw, ref.yaw) && approx(r.pitch, ref.pitch))
  check('invalid/zero dt is safe and inert (no acceleration)', ok,
    bad.map((r) => `${r.yaw.toFixed(4)}/${r.pitch.toFixed(4)}`).join(' '))
}

{
  // invalid sensitivity falls back to 1.0; negative clamps to 0 (no inversion)
  const base = computeLookDelta(100, 100, 16, { sensitivity: 1 })
  const nanS = computeLookDelta(100, 100, 16, { sensitivity: NaN })
  const noOpts = computeLookDelta(100, 100, 16)          // opts omitted entirely
  const neg = computeLookDelta(100, 100, 16, { sensitivity: -3 })
  check('invalid sensitivity falls back to 1.0',
    approx(nanS.yaw, base.yaw) && approx(noOpts.yaw, base.yaw) && approx(noOpts.pitch, base.pitch),
    `nan=${nanS.yaw.toFixed(4)} noOpts=${noOpts.yaw.toFixed(4)} base=${base.yaw.toFixed(4)}`)
  check('negative sensitivity clamps to 0 (no axis flip)',
    neg.yaw === 0 && neg.pitch === 0, `${neg.yaw}/${neg.pitch}`)
}

{
  // invalid deltas must not inject NaN into the camera
  const r = computeLookDelta(NaN, undefined, 16, { sensitivity: 1 })
  check('invalid dx/dy -> finite zero', finite(r.yaw) && finite(r.pitch) && r.yaw === 0 && r.pitch === 0,
    JSON.stringify(r))
}

// --- report ------------------------------------------------------------------

console.log('\n=== TouchLook pure verification ===')
let failed = 0
for (const c of checks) {
  const status = c.pass ? 'PASS' : 'FAIL'
  if (!c.pass) failed++
  console.log(`${status}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
