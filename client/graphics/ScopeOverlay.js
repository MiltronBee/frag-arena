// THE SCOPE. Built from two radial gradients and four divs — no textures, no sprites,
// no new animation clips.
//
// Design from the round robin + judge in _work/sniper-roundrobin/ (Finch → Kovalenko →
// Raghavan → judge). Finch's standard was the one that mattered: does it behave like
// GLASS, or like a sticker drawn on top of an unchanged view? Three things separate the
// two, and all three are here:
//
//   1. OCCLUSION, not vignette. Outside the tube is not darkened, it is GONE — solid
//      #050708. A real scope's field is a tunnel, and giving up your peripheral vision
//      is the price you pay for the magnification.
//   2. The EYE-BOX shifts WHILE YOU MOVE. The black crescent that creeps in when your
//      cheek weld is off is what tells your hands the optic is a physical object in
//      front of your face.
//   3. It reacts to the SHOT. The exit pupil blacks out for a frame or two on recoil,
//      which is why real shooters lose the target through glass and have to re-find it.
//
// NO IDLE SWAY, DELIBERATELY. The 2026-07-26 sniper panel (scratch/sniper-scope/) ruled
// UNANIMOUSLY against scope sway and breath-hold: "unnecessary bloat that degrades the
// streamlined mobile HUD and detracts from fast-paced arena movement". That ruling still
// stands, so a player holding still on a sightline gets a rock-steady optic. The drift
// here is tied to ACTIONS the player takes — moving, and firing — which is a tell, not
// idle decoration, and it stops the moment they stop.
//
// COST: one element, transform/opacity only, updated from the ADS ramp that already runs
// each frame. Every write is gated on an epsilon, and a stationary scoped player settles
// to zero DOM writes per frame.
const SHADOW_MOVE = 26     // px of eye-box drift while moving
const MOVE_SETTLE = 6       // how fast the crescent re-centres once you stop (per second)
const KICK_MS = 40         // exit-pupil blackout on firing
const KICK_RECOVER_MS = 140

export default class ScopeOverlay {
	constructor() {
		this.root = document.getElementById('scope-viewport')
		this.shadow = document.getElementById('scope-shadow')
		if (!this.root) return
		// Cached so the hot path can skip the DOM entirely when nothing moved.
		this._lastOpacity = -1
		this._lastScale = -1
		this._lastShadow = ''
		this._active = false
		this._kickAt = 0
		this._t0 = performance.now()
	}

	/**
	 * @param t        0..1 eased ADS ramp (Simulator._adsEase(_adsT))
	 * @param scoped   does the EQUIPPED weapon have an optic (weaponsConfig ads.scope)
	 * @param moving   is the player moving (drives eye-box drift)
	 */
	update(t, scoped, moving) {
		if (!this.root) return
		// Not a scoped weapon, or not aiming: make sure the tube is fully gone. Checked
		// against cached state so this costs nothing on the 99% of frames where the
		// player is holding something else.
		if (!scoped || t <= 0.001) {
			if (this._active) {
				this.root.classList.remove('is-on')
				this.root.style.opacity = '0'
				this._active = false
				this._lastOpacity = 0
				this._lastScale = -1
			}
			return
		}
		if (!this._active) {
			this.root.classList.add('is-on')
			this._active = true
		}

		// OPACITY follows the ramp so the tube irises in with the FOV rather than
		// popping. Epsilon-gated: below ~0.4% a change is not visible.
		if (Math.abs(t - this._lastOpacity) > 0.004) {
			this.root.style.opacity = t.toFixed(3)
			this._lastOpacity = t
		}

		// SCALE: the mask starts slightly oversized and settles to 1. That is what sells
		// the eye ARRIVING at the glass — the tube grows into the frame instead of being
		// switched on at final size.
		const scale = 1.15 - 0.15 * t
		if (Math.abs(scale - this._lastScale) > 0.002) {
			this.root.style.transform = `scale(${scale.toFixed(3)})`
			this._lastScale = scale
		}

		if (!this.shadow) return
		// EYE-BOX DRIFT, driven by MOVEMENT ONLY. Walking with your eye at an optic is
		// exactly when you lose the eye box, and that is a thing the player is choosing to
		// do — unlike breathing, which would impose motion on someone holding still.
		//
		// `_moveAmt` ramps toward 1 while moving and decays back to 0 when stopped, so the
		// crescent slides away rather than snapping, and a stationary player converges to
		// exactly zero (at which point the transform stops changing and the DOM goes quiet).
		const now = performance.now()
		const dt = Math.min(0.1, (now - (this._lastNow || now)) / 1000)
		this._lastNow = now
		this._moveAmt = moving
			? Math.min(1, (this._moveAmt || 0) + dt * MOVE_SETTLE)
			: Math.max(0, (this._moveAmt || 0) - dt * MOVE_SETTLE)
		const age = (now - this._t0) / 1000
		const drift = SHADOW_MOVE * this._moveAmt
		// Two out-of-phase sines so the path is an unclosed figure rather than a circle
		// the eye can learn. Amplitude is zero when still, so this costs nothing then.
		let x = Math.sin(age * 1.7) * drift
		let y = Math.sin(age * 2.3 + 1.1) * drift * 0.7

		// FIRING KICK: the exit pupil collapses on recoil and the tube goes dark, then
		// recovers. This is the whole reason a scoped shot costs you the target.
		const since = now - this._kickAt
		if (since < KICK_MS + KICK_RECOVER_MS) {
			const k = since < KICK_MS ? 1 : 1 - (since - KICK_MS) / KICK_RECOVER_MS
			// Shove the eye box hard off-axis; the crescent swallows the field.
			y -= k * 90
			if (Math.abs(t * (1 - k * 0.95) - this._lastOpacity) > 0.004) {
				this._lastOpacity = t * (1 - k * 0.95)
				this.root.style.opacity = this._lastOpacity.toFixed(3)
			}
		}

		// One string per frame only while actually drifting; rounded to whole px so a
		// sub-pixel jitter cannot churn the cache.
		const s = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`
		if (s !== this._lastShadow) {
			this.shadow.style.transform = s
			this._lastShadow = s
		}
	}

	/** Called on a local shot: blacks the tube briefly (see the kick block above). */
	kick() {
		this._kickAt = performance.now()
	}
}
