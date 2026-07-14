// Pure unit checks for client/TouchLook.js — the touch look math (CSS-px drag
// deltas -> yaw/pitch radians). No browser, no server, no bundler: the real
// module is the single source of truth, loaded here as an ES module via a
// data: URL (it has no imports and touches only Math, so it runs under Node).
//
// Exit code 0 = all assertions passed, 1 = failure.
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/TouchLook.js', import.meta.url), 'utf8')
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src))
const { computeLookDelta, YAW_DEG_PER_PX, YAW_RAD_PER_PX, VERTICAL_GAIN } = mod

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

// a 400 px horizontal swipe turns ~88 degrees at the default sensitivity
{
  const r = computeLookDelta(400, 0, 16, { sensitivity: 1 })
  const deg = r.yaw / DEG
  check('400px swipe -> ~88 deg yaw', approx(deg, 88, 1e-6), `${deg.toFixed(3)} deg`)
}

// --- vertical gain -----------------------------------------------------------

{
  const h = computeLookDelta(100, 0, 16, {})   // pure horizontal
  const v = computeLookDelta(0, 100, 16, {})   // pure vertical, same distance
  check('pitch is 0.8x yaw for equal deltas', approx(v.pitch / h.yaw, 0.8),
    `ratio=${(v.pitch / h.yaw).toFixed(6)}`)
  check('pure horizontal produces no pitch', v.pitch !== 0 && h.pitch === 0,
    `h.pitch=${h.pitch}`)
}

// --- touch sensitivity multiplier --------------------------------------------

{
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

// --- no smoothing / no acceleration yet --------------------------------------

{
  // output must not depend on dt (no velocity term); a fast flick and a slow
  // drag of the same distance produce identical rotation
  const fast = computeLookDelta(120, 40, 5, {})     // 5ms  -> 32 px/ms
  const slow = computeLookDelta(120, 40, 500, {})   // 500ms -> 0.32 px/ms
  check('no acceleration: dt does not change output (ratio 1.0)',
    approx(fast.yaw, slow.yaw) && approx(fast.pitch, slow.pitch),
    `fast.yaw=${fast.yaw.toFixed(6)} slow.yaw=${slow.yaw.toFixed(6)}`)
}

// --- zero / safety -----------------------------------------------------------

{
  const z = computeLookDelta(0, 0, 16, {})
  check('zero delta -> zero rotation', z.yaw === 0 && z.pitch === 0, JSON.stringify(z))
}

{
  // invalid dt must never throw or produce NaN, and must match a valid-dt result
  const ref = computeLookDelta(90, 30, 16, {})
  const bad = [0, -50, NaN, undefined, Infinity].map((dt) => computeLookDelta(90, 30, dt, {}))
  const ok = bad.every((r) => finite(r.yaw) && finite(r.pitch) &&
    approx(r.yaw, ref.yaw) && approx(r.pitch, ref.pitch))
  check('invalid/zero dt is safe and inert', ok,
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
