/* Touch controls — the standard mobile-FPS layout that CoD Mobile / PUBG
   popularized: a floating movement joystick anywhere on the left half,
   drag-to-look anywhere on the right half, and a thumb-reach button cluster
   (fire / jump / reload / weapon switch). Everything writes into the existing
   InputSystem state, so prediction/netcode is identical to keyboard+mouse. */

const TOUCH_LOOK_SCALE = 3   // touch drags are short — amplify vs mouse pixels
const JOY_RADIUS = 60        // px the knob can travel from where the thumb landed
const JOY_DEADZONE = 12      // px of drift before movement registers
const SECTOR = Math.sin(Math.PI / 8) // 8-way sector edges at 22.5°

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
		this._lookId = null  // touch identifier owning the look drag
		this._lookLast = null
		this._triedFullscreen = false

		this._buildDom()
		this._bindJoystick()
		this._bindLook()
		this._bindButtons()

		// keyboard hints are noise on a phone
		const hint = document.getElementById('weapon-hint')
		if (hint) hint.style.display = 'none'
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
		this.reloadBtn = el('div', 'touch-reload', root, 'R')
		this.switchBtn = el('div', 'touch-switch', root, '⇄')
		this.gearBtn = el('div', 'touch-gear', root, '⚙')
	}

	// browsers only allow fullscreen/orientation from a user gesture, so we
	// piggyback on the first touch; failures (iOS Safari) are fine to ignore
	_tryFullscreen() {
		if (this._triedFullscreen) return
		this._triedFullscreen = true
		const doc = document.documentElement
		if (doc.requestFullscreen) {
			doc.requestFullscreen().then(() => {
				if (screen.orientation && screen.orientation.lock) {
					screen.orientation.lock('landscape').catch(() => {})
				}
			}).catch(() => {})
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

	/* look: relative drag on the right half, fed through the same
	   onmousemove path as the mouse so the sensitivity setting applies */
	_bindLook() {
		const zone = this.lookZone

		zone.addEventListener('touchstart', (e) => {
			e.preventDefault()
			this._tryFullscreen()
			if (this._lookId !== null) return
			const t = e.changedTouches[0]
			this._lookId = t.identifier
			this._lookLast = { x: t.clientX, y: t.clientY }
		}, { passive: false })

		zone.addEventListener('touchmove', (e) => {
			e.preventDefault()
			const t = this._findTouch(e, this._lookId)
			if (!t) return
			const dx = t.clientX - this._lookLast.x
			const dy = t.clientY - this._lookLast.y
			this._lookLast = { x: t.clientX, y: t.clientY }
			if (this.input.onmousemove) {
				this.input.onmousemove({
					movementX: dx * TOUCH_LOOK_SCALE,
					movementY: dy * TOUCH_LOOK_SCALE
				})
			}
		}, { passive: false })

		const end = (e) => {
			if (!this._findTouch(e, this._lookId)) return
			this._lookId = null
			this._lookLast = null
		}
		zone.addEventListener('touchend', end)
		zone.addEventListener('touchcancel', end)
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

		this._bindHold(this.fireBtn, () => {
			s.mouseDown = true
			this.input.frameState.mouseDown = true
			if (navigator.vibrate) navigator.vibrate(8)
		}, () => { s.mouseDown = false })

		this._bindHold(this.jumpBtn, () => {
			s.jump = true
			this.input.frameState.jump = true
		}, () => { s.jump = false })

		this._bindHold(this.reloadBtn, () => {
			s.reload = true
		}, () => { s.reload = false })

		this._bindHold(this.switchBtn, () => {
			this.simulator.switchWeapon(this.simulator.weaponIndex + 1)
		})

		this._bindHold(this.gearBtn, () => {
			const menu = document.getElementById('settings-menu')
			if (menu) menu.classList.toggle('settings-closed')
		})
	}
}

export default TouchControls
