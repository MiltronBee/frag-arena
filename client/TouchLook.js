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

// coerce anything non-finite (NaN / undefined / Infinity) to `fallback`, so a
// bad setting or a bogus delta can never inject NaN into the camera rotation
const finite = (n, fallback) => (typeof n === 'number' && isFinite(n) ? n : fallback)

/* Convert one drag sample into camera rotation deltas.
     dx, dy — finger movement in CSS px since the previous sample
     dt     — ms since the previous sample. RESERVED for a future acceleration
              term and currently unused in the math: with no acceleration the
              mapping is purely proportional, so the result does NOT depend on
              dt (any dt — 0, negative, NaN, undefined — yields the same finite
              deltas). Accepted now so the call sites and tests already thread it.
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

	const yaw = px * YAW_RAD_PER_PX * sensitivity
	let pitch = py * YAW_RAD_PER_PX * VERTICAL_GAIN * sensitivity
	if (invertY) pitch = -pitch

	return { yaw, pitch }
}

export default computeLookDelta
