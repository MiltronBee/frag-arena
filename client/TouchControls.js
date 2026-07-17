/* Touch controls — the standard mobile-FPS layout that CoD Mobile / PUBG
   popularized: a floating movement joystick anywhere on the left half,
   drag-to-look anywhere on the right half, and a thumb-reach button set
   (fire / jump / reload / switch / gear). Reload + switch-weapon live inside the
   touch overlay (z above the look zone) so their taps register instead of being
   swallowed by drag-look; the weapon HUD plate is a pure display. Everything
   writes into the existing InputSystem state, so prediction/netcode is identical
   to keyboard+mouse.

   Look drags (right-half zone AND the fire button — the fire thumb keeps
   aiming) are converted to yaw/pitch by the pure TouchLook module and applied
   through Simulator.applyTouchLookDelta, honoring the separate touch-sensitivity
   / invert-Y settings. */

import { computeLookDelta } from './TouchLook'

const JOY_RADIUS = 60        // px the knob can travel from where the thumb landed
const JOY_DEADZONE = 10      // px of drift before movement registers
const SECTOR = Math.sin(Math.PI / 8) // 8-way sector edges at 22.5°
const RELOAD_PULSE_MS = 150  // hold the reload input true across ≥1 update frame

// overlay only on devices whose PRIMARY pointer is a finger — a desktop with a
// touchscreen still gets mouse controls
export const isTouchDevice = () =>
	('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
	window.matchMedia('(pointer: coarse)').matches

const el = (tag, id, parent, text) => {
	const e = document.createElement(tag)
	if (id) e.id = id
	if (text) e.textContent = text
	parent.appendChild(e)
	return e
}

class TouchControls {
	constructor(simulator) {
		this.simulator = simulator
		this.input = simulator.input

		this._joyId = null   // touch identifier owning the joystick
		this._lookId = null  // touch identifier owning the right-half look drag
		this._lookLast = null
		this._fireId = null  // touch identifier owning the fire button (also aims)
		this._fireLast = null
		this._triedFullscreen = false

		this._reloadPulseTimer = null   // pending release of a reload input pulse
		this._throwPulseTimer = null    // pending release of a grenade-throw input pulse

		this._buildDom()
		this._bindJoystick()
		this._bindLook()
		this._bindFire()
		this._bindButtons()
	}

	enterFullscreen() {
		this._tryFullscreen()
	}

	_buildDom() {
		const root = el('div', 'touch-controls', document.body)

		// zones sit under the buttons; buttons are siblings so their touches
		// never double as look/joystick input
		this.moveZone = el('div', 'touch-move-zone', root)
		this.lookZone = el('div', 'touch-look-zone', root)

		this.joyBase = el('div', 'touch-joy-base', root)
		this.joyKnob = el('div', 'touch-joy-knob', this.joyBase)

		this.fireBtn = el('div', 'touch-fire', root, '◉')
		this.jumpBtn = el('div', 'touch-jump', root, '▲')
		this.reloadBtn = el('div', 'touch-reload', root, '⟳')
		this.switchBtn = el('div', 'touch-switch', root, '⇄')
		this.throwBtn = el('div', 'touch-throw', root, '☀') // Phase 3 frag-grenade throw
		this.gearBtn = el('div', 'touch-gear', root, '⚙')
	}

	// browsers only allow fullscreen from a user gesture, so we piggyback on the
	// first touch; failures (iOS Safari) are fine to ignore. We do NOT lock
	// orientation: portrait is a supported, primary layout — the game never
	// forces landscape.
	_tryFullscreen() {
		if (this._triedFullscreen) return
		this._triedFullscreen = true
		const doc = document.documentElement
		if (doc.requestFullscreen) {
			doc.requestFullscreen().catch(() => {})
		}
	}

	_findTouch(e, id) {
		for (const t of e.changedTouches) {
			if (t.identifier === id) return t
		}
		return null
	}

	/* movement: floating joystick — the base appears under the thumb, the knob
	   clamps to JOY_RADIUS, and tracking continues even when the finger leaves
	   the visual circle (forgiveness) */
	_bindJoystick() {
		const zone = this.moveZone

		zone.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			if (this._joyId !== null) return
			const t = e.changedTouches[0]
			this._joyId = t.identifier
			this._joyOrigin = { x: t.clientX, y: t.clientY }
			this.joyBase.style.left = `${t.clientX}px`
			this.joyBase.style.top = `${t.clientY}px`
			this.joyKnob.style.transform = 'translate(-50%, -50%)'
			this.joyBase.classList.add('active')
		}, { passive: false })

		zone.addEventListener('touchmove', (e) => {
			e.preventDefault()
			const t = this._findTouch(e, this._joyId)
			if (!t) return
			const dx = t.clientX - this._joyOrigin.x
			const dy = t.clientY - this._joyOrigin.y
			const len = Math.hypot(dx, dy)
			const clamp = len > JOY_RADIUS ? JOY_RADIUS / len : 1
			this.joyKnob.style.transform =
				`translate(calc(${dx * clamp}px - 50%), calc(${dy * clamp}px - 50%))`
			this._applyJoy(dx, dy, len)
		}, { passive: false })

		const end = (e) => {
			if (!this._findTouch(e, this._joyId)) return
			this._joyId = null
			this.joyBase.classList.remove('active')
			this._applyJoy(0, 0, 0)
		}
		zone.addEventListener('touchend', end)
		zone.addEventListener('touchcancel', end)
	}

	_applyJoy(dx, dy, len) {
		const s = this.input._currentState
		s.forwards = s.backwards = s.left = s.right = false
		if (len < JOY_DEADZONE) return
		const nx = dx / len
		const ny = dy / len
		if (ny < -SECTOR) s.forwards = true
		if (ny > SECTOR) s.backwards = true
		if (nx < -SECTOR) s.left = true
		if (nx > SECTOR) s.right = true
	}

	/* convert one drag sample into a camera rotation, honoring the touch
	   sensitivity + invert-Y settings, and apply it via Simulator's touch-only
	   seam. Shared by the right-half look zone and the fire button so both aim
	   through the exact same pipeline. */
	_applyLook(dx, dy, dt) {
		const { yaw, pitch } = computeLookDelta(dx, dy, dt, {
			sensitivity: this.simulator.touchSensitivity,
			invertY: this.simulator.touchInvertY,
		})
		this.simulator.applyTouchLookDelta(yaw, pitch)
	}

	/* look: relative drag on the right half, converted to yaw/pitch by TouchLook.
	   (dt is threaded through for a future acceleration term; unused for now.) */
	_bindLook() {
		const zone = this.lookZone

		zone.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			if (this._lookId !== null) return
			const t = e.changedTouches[0]
			this._lookId = t.identifier
			this._lookLast = { x: t.clientX, y: t.clientY, t: e.timeStamp }
		}, { passive: false })

		zone.addEventListener('touchmove', (e) => {
			e.preventDefault()
			const t = this._findTouch(e, this._lookId)
			if (!t) return
			const dx = t.clientX - this._lookLast.x
			const dy = t.clientY - this._lookLast.y
			const dt = e.timeStamp - this._lookLast.t
			this._lookLast = { x: t.clientX, y: t.clientY, t: e.timeStamp }
			this._applyLook(dx, dy, dt)
		}, { passive: false })

		const end = (e) => {
			if (!this._findTouch(e, this._lookId)) return
			this._lookId = null
			this._lookLast = null
		}
		zone.addEventListener('touchend', end)
		zone.addEventListener('touchcancel', end)
	}

	/* fire: latches the shot on touchstart (zero added latency, exactly as
	   before) but the SAME finger can then drag to keep aiming — Touch Events
	   keep targeting the button where the touch started, so its moves reach us
	   here and feed the shared look pipeline. end/cancel always release fire so
	   it can never stick. */
	_bindFire() {
		const btn = this.fireBtn
		const s = this.input._currentState

		btn.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			if (this._fireId !== null) return   // one finger owns fire at a time
			const t = e.changedTouches[0]
			this._fireId = t.identifier
			this._fireLast = { x: t.clientX, y: t.clientY, t: e.timeStamp }
			s.mouseDown = true
			this.input.frameState.mouseDown = true   // catch a sub-frame tap
			btn.classList.add('active')
			if (navigator.vibrate) navigator.vibrate(8)
		}, { passive: false })

		btn.addEventListener('touchmove', (e) => {
			e.preventDefault()
			const t = this._findTouch(e, this._fireId)
			if (!t) return
			const dx = t.clientX - this._fireLast.x
			const dy = t.clientY - this._fireLast.y
			const dt = e.timeStamp - this._fireLast.t
			this._fireLast = { x: t.clientX, y: t.clientY, t: e.timeStamp }
			this._applyLook(dx, dy, dt)
		}, { passive: false })

		const end = (e) => {
			if (!this._findTouch(e, this._fireId)) return
			e.preventDefault()
			this._fireId = null
			this._fireLast = null
			s.mouseDown = false
			btn.classList.remove('active')
		}
		btn.addEventListener('touchend', end, { passive: false })
		btn.addEventListener('touchcancel', end, { passive: false })
	}

	_bindHold(btn, onDown, onUp) {
		btn.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			btn.classList.add('active')
			onDown()
		}, { passive: false })
		const end = (e) => {
			e.preventDefault()
			btn.classList.remove('active')
			if (onUp) onUp()
		}
		btn.addEventListener('touchend', end, { passive: false })
		btn.addEventListener('touchcancel', end, { passive: false })
	}

	_bindButtons() {
		const s = this.input._currentState

		// fire is bound separately (_bindFire) because it doubles as a look
		// surface — the fire thumb keeps aiming while shooting

		this._bindHold(this.jumpBtn, () => {
			s.jump = true
			this.input.frameState.jump = true
			if (navigator.vibrate) navigator.vibrate(8)
		}, () => { s.jump = false })

		this._bindHold(this.gearBtn, () => {
			this.simulator.toggleSettings()
		})

		// RELOAD — rising-edge pulse of the reload input, identical to a brief press
		// of the old reload button. Hold `reload` true long enough to span at least
		// one update frame (releaseKeys copies it into frameState, then Simulator's
		// rising-edge check `reload && !_reloadHeld` fires it exactly once), then
		// release so it can be re-triggered later.
		this._bindTap(this.reloadBtn, () => {
			if (this._reloadPulseTimer !== null) clearTimeout(this._reloadPulseTimer)
			s.reload = true
			this._reloadPulseTimer = setTimeout(() => {
				s.reload = false
				this._reloadPulseTimer = null
			}, RELOAD_PULSE_MS)
			if (navigator.vibrate) navigator.vibrate(8)
		})

		// SWITCH — cycle to the next weapon (switchWeapon wraps the index)
		this._bindTap(this.switchBtn, () => {
			this.simulator.switchWeapon(this.simulator.weaponIndex + 1)
			if (navigator.vibrate) navigator.vibrate(8)
		})

		// THROW — rising-edge pulse of the grenade throwInput, identical mechanism to
		// RELOAD above: hold the input true across ≥1 update frame so Simulator's
		// rising-edge check (`throwInput && !_throwHeld`) fires exactly once, then
		// release so it can be re-triggered.
		this._bindTap(this.throwBtn, () => {
			if (this._throwPulseTimer !== null) clearTimeout(this._throwPulseTimer)
			s.throwInput = true
			this._throwPulseTimer = setTimeout(() => {
				s.throwInput = false
				this._throwPulseTimer = null
			}, RELOAD_PULSE_MS)
			if (navigator.vibrate) navigator.vibrate(10)
		})
	}

	/* momentary tap button: fires `onTap` once on touchstart (rising edge) and
	   shows the .active press state until release. Used for reload/switch, which
	   are one-shot actions rather than held inputs. */
	_bindTap(btn, onTap) {
		btn.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			btn.classList.add('active')
			onTap()
		}, { passive: false })
		const end = (e) => {
			e.preventDefault()
			btn.classList.remove('active')
		}
		btn.addEventListener('touchend', end, { passive: false })
		btn.addEventListener('touchcancel', end, { passive: false })
	}

}

export default TouchControls
