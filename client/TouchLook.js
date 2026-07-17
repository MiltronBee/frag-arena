/* TouchLook — pure conversion of touch-drag deltas (CSS pixels) into camera
   yaw/pitch deltas (radians). No DOM, no module state, no smoothing and no
   acceleration yet: a slow drag and a fast flick of the same length produce the
   same rotation. Kept pure so it is trivially unit-testable
   (see scripts/verify-touchlook.mjs); TouchControls consumes it and Simulator
   applies the result behind its own pitch clamp.

   Calibration: at touch sensitivity 1.0 a horizontal drag yields
   YAW_DEG_PER_PX degrees of yaw per CSS pixel, so a ~400 px swipe turns ~88°
   and a full-width ~844 px swipe turns ~186°. Pitch uses VERTICAL_GAIN× the
   horizontal gain — shooters conventionally slow the vertical axis. */

export const YAW_DEG_PER_PX = 0.22                    // yaw degrees per CSS px @ sensitivity 1.0
export const YAW_RAD_PER_PX = (YAW_DEG_PER_PX * Math.PI) / 180
export const VERTICAL_GAIN = 0.8                      // pitch gain relative to yaw

// flick acceleration: a fast swipe multiplies the look gain so one swipe can
// spin ~180°, while slow micro-aim stays byte-for-byte at the base gain. Swipe
// speed is measured from the already-threaded dt (px per ms). Below FLICK_LO the
// multiplier is 1.0; it ramps linearly to FLICK_MAX at/above FLICK_HI, then clamps.
export const FLICK_LO = 0.35     // px/ms — at or below: no acceleration (multiplier 1.0)
export const FLICK_HI = 1.4      // px/ms — at or above: full acceleration
export const FLICK_MAX = 2.2     // peak gain multiplier for a fast flick

// coerce anything non-finite (NaN / undefined / Infinity) to `fallback`, so a
// bad setting or a bogus delta can never inject NaN into the camera rotation
const finite = (n, fallback) => (typeof n === 'number' && isFinite(n) ? n : fallback)

/* Map a swipe speed (px/ms) to the flick-acceleration multiplier: flat 1.0 up to
   FLICK_LO, linear ramp to FLICK_MAX at FLICK_HI, clamped above. A non-finite or
   non-positive dt (0, negative, NaN, undefined) yields no acceleration — the base
   1.0 multiplier — so slow drags and degenerate samples stay proportional. */
export function flickMultiplier(dx, dy, dt) {
	const t = finite(dt, 0)
	if (!(t > 0)) return 1
	const speed = Math.hypot(finite(dx, 0), finite(dy, 0)) / t   // px/ms
	if (speed <= FLICK_LO) return 1
	if (speed >= FLICK_HI) return FLICK_MAX
	const f = (speed - FLICK_LO) / (FLICK_HI - FLICK_LO)         // 0..1
	return 1 + f * (FLICK_MAX - 1)
}

/* Convert one drag sample into camera rotation deltas.
     dx, dy — finger movement in CSS px since the previous sample
     dt     — ms since the previous sample. Drives flick acceleration: fast
              swipes are scaled up (see flickMultiplier). A slow drag (speed
              ≤ FLICK_LO) or a degenerate dt (0, negative, NaN, undefined) leaves
              the mapping purely proportional — bit-identical to the pre-flick
              behavior — so micro-aim is unchanged.
     opts.sensitivity — touch sensitivity multiplier (default 1.0; non-finite
                        falls back to 1.0, negatives clamp to 0 rather than
                        inverting the axis)
     opts.invertY     — flip pitch sign (default false)
   Returns { yaw, pitch } in radians, ready to add onto camera.rotation.y / .x. */
export function computeLookDelta(dx, dy, dt, opts) {
	const settings = (opts && typeof opts === 'object') ? opts : {}
	const sensitivity = Math.max(0, finite(settings.sensitivity, 1))
	const invertY = settings.invertY === true

	const px = finite(dx, 0)
	const py = finite(dy, 0)
	const accel = flickMultiplier(px, py, dt)

	const yaw = px * YAW_RAD_PER_PX * sensitivity * accel
	let pitch = py * YAW_RAD_PER_PX * VERTICAL_GAIN * sensitivity * accel
	if (invertY) pitch = -pitch

	return { yaw, pitch }
}

export default computeLookDelta
