import BABYLONRenderer from './graphics/BABYLONRenderer'
import InputSystem from './InputSystem'
import MoveCommand from '../common/command/MoveCommand'
import FireCommand from '../common/command/FireCommand'
import SwitchWeaponCommand from '../common/command/SwitchWeaponCommand'
import DevUpdateWeaponConfigCommand from '../common/command/DevUpdateWeaponConfigCommand'
import createFactories from './factories/createFactories'
import reconcilePlayer from './reconcilePlayer'
import applyCommand, { DODGE_DIRS } from '../common/applyCommand'
import TouchControls, { isTouchDevice } from './TouchControls'
import { fire } from '../common/weapon'
import { shotPattern, applyPattern } from '../common/firePattern'
import Viewmodel from './graphics/Viewmodel'
import WeaponAudio from './graphics/WeaponAudio'
import { resolveWeaponFx } from './graphics/firingFx'
import { assets, weapons } from './assets/assetManifest'

// ignoring certain data from the sever b/c we will be predicting these properties on the client
const ignoreProps = ['x', 'y', 'z', 'velX', 'velY', 'velZ']
const shouldIgnore = (myId, update) => {
	if (update.nid === myId) {
		if (ignoreProps.indexOf(update.prop) !== -1) {
			return true
		}
	}
	return false
}

class Simulator {
	constructor(client) {
		this.client = client
		this.renderer = new BABYLONRenderer()
		this.input = new InputSystem()
		this.obstacles = new Map()
		this.characterModels = new Map() // nid -> CharacterModel (other players' visuals)
		this._projectiles = new Map()    // nid -> {entity, prev pos} for the plasma streak

		// procedural weapon audio (WebAudio). Silent until resume() runs from a user
		// gesture (enter-arena / pointer-lock / touch).
		this.audio = new WeaponAudio()

		// AIM-SAFE camera recoil: a POSITION-only kick spring. It never rotates the
		// camera, so the fire ray + MoveCommand aim (both rotation-only) are byte-
		// identical — zero authority/cadence change. Reset from the entity each frame,
		// so it self-clears and can never drift the view.
		this._camKick = new BABYLON.Vector3(0, 0, 0)
		this._camKickVel = new BABYLON.Vector3(0, 0, 0)

		// first-person weapon, swap with 1-4 / Q / wheel. Only the EQUIPPED weapon's
		// rig lives in the scene: multiple copies of the same skeleton coexisting
		// cross-wire each other's poses in Babylon 4.0.3, so we dispose + reload on
		// switch (the .glb is browser-cached; the swap hitch is negligible).
		this.weaponIndex = 0
		this.viewmodel = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[0])
		this.viewmodel.setActive(true)
		this._viewmodelSwapId = 0
		this._viewmodelSwapQueue = Promise.resolve()
		this._setupWeaponSwitching()

		// isTouch must be known before the settings UI is built so the touch-only
		// rows (touch sensitivity, invert-Y) can be shown/hidden correctly
		this.isTouch = isTouchDevice()

		// Load settings with defaults. Desktop mouse sensitivity (`sens`) and touch
		// look sensitivity (`touchSens`) are persisted independently so tuning one
		// never disturbs the other.
		this.sensitivity = parseFloat(localStorage.getItem('sens') || '1.0')
		this.touchSensitivity = parseFloat(localStorage.getItem('touchSens') || '1.0')
		this.touchInvertY = localStorage.getItem('touchInvertY') === 'true'
		this.fov = parseInt(localStorage.getItem('fov') || '95', 10)
		this.renderer.camera.fov = (this.fov * Math.PI) / 180
		this._setupSettingsUI()

		// phones/tablets get the joystick + drag-look overlay instead of
		// pointer lock (which doesn't exist on mobile browsers)
		if (this.isTouch) {
			this.touchControls = new TouchControls(this)
		}
		this._setupGameUI()
		
		// dev-only tooling: the server ignores DevUpdateWeaponConfigCommand in
		// production, so predicting with modified configs would only desync us
		this.devToolsEnabled = process.env.NODE_ENV !== 'production'
		this.devInspectorOpen = false
		if (this.devToolsEnabled) this._setupDevInspector()

		this.myRawId = -1
		this.mySmoothId = -1

		this.myRawEntity = null
		this.mySmoothEntity = null

		client.factory = createFactories({
			/* dependency injection */
			simulator: this,
		})

		client.entityUpdateFilter = (update) => {
			return shouldIgnore(this.myRawId, update)
		}

		client.on('message::Identity', message => {
			// these are the ids of our two entities.. we just store them here on simulator until
			// we receive these entities over the network (see: createPlayerFactory)
			this.myRawId = message.rawId
			this.mySmoothId = message.smoothId
			// our own x/y/z updates are ignored (we predict them), so the server hands
			// us the spawn point here; applied when the raw entity arrives
			this.spawnPos = { x: message.x, z: message.z }
			console.log('identified as', message)
		})

		client.on('message::Respawned', message => {
			// server respawn teleport for our own predicted entity (own x/y/z
			// snapshots are ignored, so this message is the only way we move)
			if (!this.myRawEntity) return
			this.myRawEntity.x = message.x
			this.myRawEntity.y = 0
			this.myRawEntity.z = message.z
			this.myRawEntity.velX = 0
			this.myRawEntity.velY = 0
			this.myRawEntity.velZ = 0
		})

		client.on('message::WeaponFired', message => {
			if (this.mySmoothEntity && message.sourceId === this.mySmoothEntity.nid) {
				// hide our own shots.. we'll predict those instead
				return
			}
			// The message carries the weapon index + the shot's deterministic spread
			// inputs (seed/heat), so observers render the EXACT pellet pattern the
			// server judged damage with, plus the correct per-weapon FX + report.
			const spec = weapons[message.weaponIndex]
			const fx = resolveWeaponFx(spec)
			if (spec && spec.type === 'hitscan') {
				const offsets = shotPattern(spec, message.seed, message.heat)
				const maxTracers = (fx.tracer && fx.tracer.pelletTracers) || offsets.length
				offsets.forEach((off, i) => {
					const d = applyPattern({ x: message.tx, y: message.ty, z: message.tz }, off)
					this.renderer.drawHitscan(
						{ x: message.x, y: message.y, z: message.z, tx: d.x, ty: d.y, tz: d.z },
						{ fx, muzzle: i === 0, tracer: i < maxTracers }
					)
				})
			} else {
				this.renderer.drawHitscan(message, { fx })
			}
			const cam = this.renderer.camera.position
			const dist = Math.hypot(message.x - cam.x, message.y - cam.y, message.z - cam.z)
			this.audio.shoot(fx.report, { distance: dist })
		})

		client.on('predictionErrorFrame', predictionErrorFrame => {
			// a reconcile frame can arrive during the connect race, before our own
			// raw entity's create snapshot has been processed. Nothing to reconcile
			// against yet, so skip until it exists (avoids a null deref on startup).
			if (!this.myRawEntity) { return }
			reconcilePlayer(predictionErrorFrame, this.client, this.myRawEntity)
		})

		this.input.onmousemove = (e) => {
			// DIY camera control, first person shooter style
			this.renderer.camera.rotation.x += e.movementY * 0.001 * this.sensitivity
			this.renderer.camera.rotation.y += e.movementX * 0.001 * this.sensitivity

			// prevent us from doing flips
			if (this.renderer.camera.rotation.x > Math.PI * 0.499) {
				this.renderer.camera.rotation.x = Math.PI * 0.499
			}

			if (this.renderer.camera.rotation.x < -Math.PI * 0.499) {
				this.renderer.camera.rotation.x = -Math.PI * 0.499
			}
		}
	}

	// touch-only camera seam: apply a yaw/pitch delta (radians) already computed
	// by TouchLook. Kept separate from the mouse `onmousemove` path so desktop
	// pointer-lock behavior is untouched; the pitch clamp here is byte-for-byte
	// the same as the mouse path above (no flips past ~±89.8°).
	applyTouchLookDelta(yawRad, pitchRad) {
		const cam = this.renderer.camera
		cam.rotation.y += yawRad
		cam.rotation.x += pitchRad

		if (cam.rotation.x > Math.PI * 0.499) {
			cam.rotation.x = Math.PI * 0.499
		}

		if (cam.rotation.x < -Math.PI * 0.499) {
			cam.rotation.x = -Math.PI * 0.499
		}
	}

	// Eject one brass casing from the weapon's port (firingFx eject preset). The
	// camera-local port offset is transformed through the live camera matrix, and
	// the fling velocity is built on the camera basis (right + up + a touch back)
	// so brass always arcs off the gun's right side, whatever way we face.
	_spawnCasing(eject) {
		if (!eject) return
		const cam = this.renderer.camera
		const m = cam.getWorldMatrix()
		const pos = BABYLON.Vector3.TransformCoordinates(
			new BABYLON.Vector3(eject.x, eject.y, eject.z), m)
		const right = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Right(), m)
		const up = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Up(), m)
		const fwd = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Forward(), m)
		const vel = right.scale(1.3 + Math.random() * 0.7)
			.add(up.scale(1.8 + Math.random() * 0.6))
			.add(fwd.scale(-0.2 + Math.random() * 0.3))
		this.renderer.spawnCasing(pos, vel, eject)
	}

	// Inject a recoil impulse on fire. POSITION-only (world space): a shove back along
	// -aim, a slight rise, and a little lateral jitter. Never touches camera rotation,
	// so the fire ray + MoveCommand aim are unchanged. Gentler on touch (nausea).
	_applyCameraRecoil(recoil) {
		if (!recoil) return
		const scale = this.isTouch ? 0.55 : 1.0
		const fwd = this.renderer.camera.getForwardRay().direction
		const back = (recoil.back || 0) * scale
		const jit = (recoil.shake || 0) * 0.018 * scale
		this._camKickVel.x += -fwd.x * back + (Math.random() - 0.5) * jit
		this._camKickVel.y += (recoil.rise || 0) * scale + (Math.random() - 0.5) * jit * 0.5
		this._camKickVel.z += -fwd.z * back + (Math.random() - 0.5) * jit
	}

	// critically-ish damped spring returning the position kick to zero, clamped so a
	// sustained burst can never drift the view far.
	_springCameraRecoil(delta) {
		const dt = Math.min(delta || 0.016, 0.05)
		const tension = 240, damping = 24
		const k = this._camKick, v = this._camKickVel
		v.x += (-tension * k.x - damping * v.x) * dt
		v.y += (-tension * k.y - damping * v.y) * dt
		v.z += (-tension * k.z - damping * v.z) * dt
		k.x += v.x * dt; k.y += v.y * dt; k.z += v.z * dt
		const M = 0.14
		k.x = Math.max(-M, Math.min(M, k.x))
		k.y = Math.max(-M, Math.min(M, k.y))
		k.z = Math.max(-M, Math.min(M, k.z))
	}

	// flash the crosshair hit marker. One reused timer (cleared each call) so repeated
	// hits never pile up timers. kill = brighter/longer confirmation.
	_showHitMarker(kill) {
		const el = document.getElementById('hit-marker')
		if (!el) return
		el.classList.remove('hit-active', 'kill-active')
		void el.offsetWidth // restart the CSS animation
		el.classList.add(kill ? 'kill-active' : 'hit-active')
		clearTimeout(this._hitMarkerTimer)
		this._hitMarkerTimer = setTimeout(() => {
			el.classList.remove('hit-active', 'kill-active')
		}, kill ? 520 : 260)
	}

	// plasma bolt bookkeeping (called from the Projectile factory). Each bolt is
	// oriented + stretched into a travel streak every frame; on delete it emits a
	// pooled energetic impact + a positional zap.
	registerProjectile(entity) {
		if (!entity) return
		this._projectiles.set(entity.nid, { entity, px: entity.x, py: entity.y, pz: entity.z })
	}

	unregisterProjectile(nid) {
		const rec = this._projectiles.get(nid)
		if (!rec) return
		this._projectiles.delete(nid)
		const e = rec.entity
		const pos = new BABYLON.Vector3(e.x, e.y, e.z)
		this.renderer.plasmaImpact(pos)
		const cam = this.renderer.camera.position
		this.audio.impact('energy', { distance: BABYLON.Vector3.Distance(pos, cam) })
	}

	_updateProjectiles() {
		if (this._projectiles.size === 0) return
		const STREAK = 3.2
		this._projectiles.forEach((rec) => {
			const e = rec.entity
			const mesh = e && e.mesh
			if (!mesh || (mesh.isDisposed && mesh.isDisposed())) return
			const dx = e.x - rec.px, dy = e.y - rec.py, dz = e.z - rec.pz
			if ((dx * dx + dy * dy + dz * dz) > 1e-8) {
				mesh.lookAt(new BABYLON.Vector3(e.x + dx, e.y + dy, e.z + dz))
				mesh.scaling.set(1, 1, STREAK)
			}
			rec.px = e.x; rec.py = e.y; rec.pz = e.z
		})
	}

	// equip weapon by index (wraps around); updates the on-screen weapon name
	switchWeapon(index) {
		const n = weapons.length
		index = ((index % n) + n) % n
		if (index === this.weaponIndex) return
		this.weaponIndex = index
		this._queueViewmodelSwap(index)
		
		if (this.myRawEntity) {
			this.myRawEntity.currentWeaponIndex = index
			this.client.addCommand(new SwitchWeaponCommand(index))
		}

		this._updateDevInspectorInputs()

		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[index].name.toUpperCase()
	}

	_queueViewmodelSwap(index) {
		const requestId = ++this._viewmodelSwapId

		// GLB imports cannot be cancelled. Serialize swaps so an old rig finishes
		// disposing before the newest one starts, and skip requests superseded by
		// another wheel notch while cleanup was in flight.
		this._viewmodelSwapQueue = this._viewmodelSwapQueue
			.then(async () => {
				if (requestId !== this._viewmodelSwapId) return

				const previous = this.viewmodel
				this.viewmodel = null
				if (previous) await previous.dispose()

				if (requestId !== this._viewmodelSwapId) return

				const next = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[index])
				this.viewmodel = next
				next.setActive(!this.myRawEntity || this.myRawEntity.isAlive !== false)
			})
			.catch((error) => {
				console.error('Unable to switch viewmodel:', error)
			})
	}

	_setupWeaponSwitching() {
		document.addEventListener('keydown', (e) => {
			if (!this.input.pointerLocked) return
			if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') {
				this.switchWeapon(parseInt(e.code.slice(5), 10) - 1)
			} else if (e.key === 'q' || e.key === 'Q') {
				this.switchWeapon(this.weaponIndex + 1)
			}
		})
		document.addEventListener('wheel', (e) => {
			if (!this.input.pointerLocked) return
			this.switchWeapon(this.weaponIndex + (e.deltaY > 0 ? 1 : -1))
		})
		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[0].name.toUpperCase()
	}

	update(delta) {
		const input = this.input.frameState
		// one-shot flags must be read BEFORE releaseKeys — `input` is a live
		// reference to frameState and releaseKeys clears them in place
		const dodge = input.dodge
		this.input.releaseKeys()

		/* all of this is just for our own entity */
		if (this.myRawEntity) {
			if (!this._initialServerSyncDone) {
				this._initialServerSyncDone = true
				if (this.devToolsEnabled) this._syncWeaponsConfigToServer()
			}

			// which way are we pointing?
			const camRay = this.renderer.camera.getForwardRay().direction

			/* begin movement */
			const { forwards, left, backwards, right, jump } = input
			const command = new MoveCommand({
				camRayX: camRay.x,
				camRayY: camRay.y,
				camRayZ: camRay.z,
				forwards, backwards, left, right, jump,
				dodge: dodge ? DODGE_DIRS[dodge] : 0,
				weaponIndex: this.weaponIndex,
				reload: input.reload && !this._reloadHeld,
				fireInput: input.mouseDown,
				delta
			})
			// send command to the server
			this.client.addCommand(command)

			const wasReloading = this.myRawEntity.weaponsState[this.weaponIndex].reloading

			// predict our own movement locally (runs the exact same logic as the server)
			applyCommand(this.myRawEntity, command, this.obstacles)

			// Handle visual reload cancellation if state.reloading was interrupted
			if (wasReloading && !this.myRawEntity.weaponsState[this.weaponIndex].reloading) {
				if (this.viewmodel) this.viewmodel.cancelReload()
			}

			// Handle visual reload start if state.reloading became true (covers manual and auto-reload)
			if (!wasReloading && this.myRawEntity.weaponsState[this.weaponIndex].reloading) {
				if (this.viewmodel) this.viewmodel.reload()
			}

			// store state for reconciliation (in case the server disagrees later)
			const prediction = {
				x: this.myRawEntity.x,
				y: this.myRawEntity.y,
				z: this.myRawEntity.z,
				velX: this.myRawEntity.velX,
				velY: this.myRawEntity.velY,
				velZ: this.myRawEntity.velZ
			}
			this.client.addCustomPrediction(this.client.tick, prediction, ['x', 'y', 'z', 'velX', 'velY', 'velZ'])

			// move the camera to our entity, then add the AIM-SAFE recoil kick as a
			// position-only offset. Because camera.position is re-based from the entity
			// every frame, the kick self-clears and never accumulates into the aim.
			Object.assign(this.renderer.camera.position, this.myRawEntity.mesh.position)
			this._springCameraRecoil(delta)
			this.renderer.camera.position.addInPlace(this._camKick)

			const state = this.myRawEntity.weaponsState[this.weaponIndex]
			this._reloadHeld = input.reload

			/* shooting (blocked while the reload animation runs) */
			if (input.mouseDown && !state.reloading) {
				const ray = fire(this.myRawEntity)
				if (ray) {
					// send shot to the server
					this.client.addCommand(new FireCommand())

					// our own tracer + flash originate at the BARREL TIP so the shot
					// visibly leaves the gun (the ray itself — and the server's hit
					// check — still starts at the entity; this is presentation only)
					const muzzle = this.viewmodel ? this.viewmodel.muzzleWorldPos() : null
					const ox = muzzle ? muzzle.x : this.myRawEntity.x
					const oy = muzzle ? muzzle.y : this.myRawEntity.y
					const oz = muzzle ? muzzle.z : this.myRawEntity.z
					const fx = resolveWeaponFx(weapons[this.weaponIndex])

					// Predicted shot: fire() attached the same seed/heat the server will
					// derive for this shot, so the pattern we paint (every pellet's
					// tracer + wall mark) IS the server's damage pattern — instant
					// feedback, no round trip. Flesh hits flash the predicted marker.
					if (ray.config.type === 'hitscan') {
						const offsets = shotPattern(ray.config, ray.seed, ray.heat)
						const maxTracers = (fx.tracer && fx.tracer.pelletTracers) || offsets.length
						let hitFlesh = false
						offsets.forEach((off, i) => {
							const d = applyPattern(
								{ x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }, off)
							const info = this.renderer.drawHitscan(
								{ x: ox, y: oy, z: oz, tx: d.x, ty: d.y, tz: d.z },
								{ fx, muzzle: false, tracer: i < maxTracers }
							)
							if (info && info.hit && info.surface === 'flesh') hitFlesh = true
						})
						if (hitFlesh) {
							this._showHitMarker(false)
							this.audio.hitMarker(false)
						}
					}
					// flash on the VIEWMODEL layer so the gun can't paint over it
					this.renderer.flashMuzzle(muzzle, fx, { vmLayer: true })
					this._spawnCasing(fx.eject)

					// one synchronized shot event: audio transient + aim-safe camera
					// kick + procedural weapon recoil animation, all on this frame.
					this.audio.shoot(fx.report, { distance: 0 })
					if (fx.vmKick && fx.vmKick.pump) this.audio.pump(fx.vmKick.pump.delay / 1000)
					this._applyCameraRecoil(fx.recoil)
					if (this.viewmodel) this.viewmodel.kick(fx.vmKick)
				}
			}

			// bob the equipped weapon each frame (based on movement)
			if (this.viewmodel) this.viewmodel.update(delta, forwards || backwards || left || right)
		}

		// drive other players' character visuals (position/yaw follow + idle/run anim)
		this.characterModels.forEach(model => model.update(delta))

		// orient + stretch live plasma bolts into hot travel streaks
		this._updateProjectiles()

		this._updateHud()
		this.renderer.update()
	}

	setConnectionState(state) {
		this._connectionState = state
		const body = document.body
		body.classList.remove('connection-connecting', 'connection-connected', 'connection-disconnected')
		body.classList.add(`connection-${state}`)

		const label = document.getElementById('connection-label')
		if (label) {
			label.textContent = state === 'connected'
				? 'ONLINE'
				: state === 'disconnected' ? 'OFFLINE' : 'CONNECTING'
		}

		if (state === 'disconnected') {
			this._arenaEntered = false
			body.classList.remove('arena-entered')
			const overlay = document.getElementById('entry-overlay')
			if (overlay) overlay.classList.add('is-visible')
			this._closeSettings()
			if (document.pointerLockElement) document.exitPointerLock()
		}

		this._syncEntryState()
	}

	setArenaReady() {
		if (this._arenaReady) return
		this._arenaReady = true
		document.body.classList.add('arena-ready')
		this._syncEntryState()
	}

	_setupGameUI() {
		this._arenaEntered = false
		this._arenaReady = false
		this._connectionState = 'connecting'
		this._lastHealth = null
		this._wasDead = false

		const enterButton = document.getElementById('enter-arena')
		const resumeButton = document.getElementById('resume-game')
		if (enterButton) enterButton.addEventListener('click', () => this._enterArena())
		if (resumeButton) resumeButton.addEventListener('click', () => {
			if (this.isTouch) {
				this._closeSettings()
			} else {
				this.input.requestPointerLock()
			}
		})

		document.addEventListener('pointerlockchange', () => {
			const locked = document.pointerLockElement === this.input.canvasEle
			if (locked) {
				this.audio.resume() // ensure audio is live once we're in the arena
				this._arenaEntered = true
				document.body.classList.add('arena-entered')
				const overlay = document.getElementById('entry-overlay')
				if (overlay) overlay.classList.remove('is-visible')
				this._closeSettings()
			} else if (this._arenaEntered && !this.isTouch &&
				!this.devInspectorOpen && this._connectionState === 'connected') {
				this._openSettings()
			}
		})

		this._syncEntryState()
	}

	_syncEntryState() {
		const ready = this._connectionState === 'connected' && this._arenaReady
		const button = document.getElementById('enter-arena')
		const status = document.getElementById('entry-status')
		if (button) button.disabled = !ready
		if (status) {
			status.textContent = this._connectionState === 'disconnected'
				? 'CONNECTION LOST'
				: ready ? 'ARENA READY' : 'CONNECTING TO ARENA'
		}
	}

	_enterArena() {
		if (this._connectionState !== 'connected' || !this._arenaReady) return
		this.audio.resume() // WebAudio needs a user gesture — this click is one
		this._arenaEntered = true
		document.body.classList.add('arena-entered')
		this._closeSettings()

		const overlay = document.getElementById('entry-overlay')
		if (this.isTouch) {
			if (overlay) overlay.classList.remove('is-visible')
			if (this.touchControls) this.touchControls.enterFullscreen()
		} else {
			this.input.requestPointerLock()
		}
	}

	_openSettings() {
		const menu = document.getElementById('settings-menu')
		if (menu) menu.classList.remove('settings-closed')
		document.body.classList.add('menu-open')
	}

	_closeSettings() {
		const menu = document.getElementById('settings-menu')
		if (menu) menu.classList.add('settings-closed')
		document.body.classList.remove('menu-open')
	}

	toggleSettings() {
		const menu = document.getElementById('settings-menu')
		if (!menu || menu.classList.contains('settings-closed')) {
			this._openSettings()
		} else if (this.isTouch) {
			this._closeSettings()
		} else {
			this.input.requestPointerLock()
		}
	}

	_updateHud() {
		let playerCount = 0
		for (const entity of this.client.entities.values()) {
			if (entity.protocol && entity.protocol.name === 'PlayerCharacter' &&
				entity.nid !== this.myRawId) {
				playerCount++
			}
		}
		if (playerCount !== this._lastPlayerCount) {
			this._lastPlayerCount = playerCount
			const count = document.getElementById('player-count')
			if (count) count.textContent = `${playerCount} ${playerCount === 1 ? 'PLAYER' : 'PLAYERS'}`
		}

		if (!this.myRawEntity) return
		if (!this._arenaReady) this.setArenaReady()

		const health = Math.max(0, Math.min(100, this.myRawEntity.hitpoints))
		const healthValue = document.getElementById('health-value')
		const healthFill = document.getElementById('health-fill')
		if (healthValue) healthValue.textContent = Math.round(health)
		if (healthFill) healthFill.style.transform = `scaleX(${health / 100})`
		document.body.classList.toggle('low-health', health > 0 && health <= 30)

		if (this._lastHealth !== null && health < this._lastHealth) {
			clearTimeout(this._hitFlashTimer)
			document.body.classList.add('player-hit')
			this._hitFlashTimer = setTimeout(() => {
				document.body.classList.remove('player-hit')
			}, 90)
		}
		this._lastHealth = health

		const dead = this.myRawEntity.isAlive === false
		document.body.classList.toggle('player-dead', dead)
		const combatState = document.getElementById('combat-state')
		if (combatState) combatState.classList.toggle('combat-state-hidden', !dead)
		if (dead !== this._wasDead) {
			this._wasDead = dead
			if (this.viewmodel) this.viewmodel.setActive(!dead)
			if (!dead) {
				// we just respawned: mirror the server's respawn ammo reset
				// (GameInstance.respawnPlayer) so predicted fire/reload state stays
				// in lockstep — ammo isn't networked, it's predicted deterministically
				this.myRawEntity.weaponsState.forEach((state, i) => {
					state.magazineAmmo = weapons[i].magazineCapacity
					state.reserveAmmo = weapons[i].maxReserveAmmo
					state.cooldownTimer = 0
					state.onCooldown = false
					state.reloading = false
					state.reloadTimer = 0
					state.heat = 0
				})
				if (this.viewmodel) this.viewmodel.cancelReload()
			}
		}

		const frags = document.getElementById('frag-count')
		if (frags) {
			const k = this.myRawEntity.kills || 0
			const d = this.myRawEntity.deaths || 0
			const text = `${k} FRAG${k === 1 ? '' : 'S'} · ${d} DEATH${d === 1 ? '' : 'S'}`
			if (frags.textContent !== text) frags.textContent = text
		}

		const weapon = weapons[this.weaponIndex]
		const state = this.myRawEntity.weaponsState && this.myRawEntity.weaponsState[this.weaponIndex]
		const weaponName = document.getElementById('weapon-name')
		if (weaponName && weapon) weaponName.textContent = weapon.name.toUpperCase()
		if (!state) return

		const magazine = document.getElementById('magazine-ammo')
		const reserve = document.getElementById('reserve-ammo')
		const weaponPanel = document.getElementById('weapon-panel')
		if (magazine) magazine.textContent = state.magazineAmmo
		if (reserve) reserve.textContent = state.reserveAmmo
		if (weaponPanel) weaponPanel.classList.toggle('is-reloading', !!state.reloading)
	}

	_setupSettingsUI() {
		const menu = document.getElementById('settings-menu')
		const fovSlider = document.getElementById('fov-slider')
		const fovVal = document.getElementById('fov-val')
		const sensSlider = document.getElementById('sens-slider')
		const sensVal = document.getElementById('sens-val')

		if (fovSlider && fovVal) {
			fovSlider.value = this.fov
			fovVal.textContent = this.fov
			fovSlider.addEventListener('input', (e) => {
				const val = parseInt(e.target.value, 10)
				this.fov = val
				fovVal.textContent = val
				this.renderer.camera.fov = (val * Math.PI) / 180
				localStorage.setItem('fov', val)
			})
		}

		if (sensSlider && sensVal) {
			sensSlider.value = this.sensitivity.toFixed(2)
			sensVal.textContent = this.sensitivity.toFixed(2)
			sensSlider.addEventListener('input', (e) => {
				const val = parseFloat(e.target.value)
				this.sensitivity = val
				sensVal.textContent = val.toFixed(2)
				localStorage.setItem('sens', val)
			})
		}

		// touch-only look settings: independent sensitivity + invert-Y. These rows
		// are meaningless with a mouse, so hide them unless this is a touch device.
		const touchSensRow = document.getElementById('touch-sens-row')
		const touchSensSlider = document.getElementById('touch-sens-slider')
		const touchSensVal = document.getElementById('touch-sens-val')
		const touchInvertRow = document.getElementById('touch-invert-row')
		const touchInvert = document.getElementById('touch-invert-y')

		if (touchSensRow) touchSensRow.style.display = this.isTouch ? '' : 'none'
		if (touchInvertRow) touchInvertRow.style.display = this.isTouch ? '' : 'none'

		if (touchSensSlider && touchSensVal) {
			touchSensSlider.value = this.touchSensitivity.toFixed(2)
			touchSensVal.textContent = this.touchSensitivity.toFixed(2)
			touchSensSlider.addEventListener('input', (e) => {
				const val = parseFloat(e.target.value)
				this.touchSensitivity = val
				touchSensVal.textContent = val.toFixed(2)
				localStorage.setItem('touchSens', val)
			})
		}

		if (touchInvert) {
			touchInvert.checked = this.touchInvertY
			touchInvert.addEventListener('change', (e) => {
				this.touchInvertY = e.target.checked
				localStorage.setItem('touchInvertY', e.target.checked ? 'true' : 'false')
			})
		}
	}

	_syncWeaponsConfigToServer() {
		weapons.forEach((w, index) => {
			this.client.addCommand(new DevUpdateWeaponConfigCommand({
				index: index,
				type: w.type === 'hitscan' ? 0 : 1,
				fireCooldown: w.fireCooldown,
				reloadTime: w.reloadTime,
				magazineCapacity: w.magazineCapacity,
				maxReserveAmmo: w.maxReserveAmmo,
				damage: w.damage,
				range: w.range,
				projectileSpeed: w.projectileSpeed
			}))

			// Make sure the raw entity weaponsState matches the capacities from localStorage
			if (this.myRawEntity && this.myRawEntity.weaponsState && this.myRawEntity.weaponsState[index]) {
				const state = this.myRawEntity.weaponsState[index]
				state.magazineAmmo = w.magazineCapacity
				state.reserveAmmo = w.maxReserveAmmo
			}
		})
		console.log("[DEV] Persistent weapons config synchronized to server successfully.")
	}

	_updateDevInspectorInputs() {
		const w = weapons[this.weaponIndex]
		if (!w) return

		const typeEl = document.getElementById('dev-weapon-type')
		const fireEl = document.getElementById('dev-fire-cooldown')
		const reloadEl = document.getElementById('dev-reload-time')
		const magEl = document.getElementById('dev-mag-capacity')
		const resEl = document.getElementById('dev-max-reserve')
		const dmgEl = document.getElementById('dev-damage')
		const rngEl = document.getElementById('dev-range')
		const speedEl = document.getElementById('dev-proj-speed')

		if (typeEl) typeEl.value = w.type === 'hitscan' ? '0' : '1'
		if (fireEl) fireEl.value = w.fireCooldown
		if (reloadEl) reloadEl.value = w.reloadTime
		if (magEl) magEl.value = w.magazineCapacity
		if (resEl) resEl.value = w.maxReserveAmmo
		if (dmgEl) dmgEl.value = w.damage
		if (rngEl) rngEl.value = w.range || 0
		if (speedEl) speedEl.value = w.projectileSpeed || 0
	}

	_setupDevInspector() {
		// Load custom configurations from localStorage if they exist
		const savedConfigs = localStorage.getItem('dev_weapons_config')
		if (savedConfigs) {
			try {
				const parsed = JSON.parse(savedConfigs)
				parsed.forEach(saved => {
					const w = weapons[saved.index]
					if (w) {
						w.type = saved.type === 0 || saved.type === 'hitscan' ? 'hitscan' : 'projectile'
						w.fireCooldown = saved.fireCooldown
						w.reloadTime = saved.reloadTime
						w.magazineCapacity = saved.magazineCapacity
						w.maxReserveAmmo = saved.maxReserveAmmo
						w.damage = saved.damage
						w.range = saved.range
						w.projectileSpeed = saved.projectileSpeed
					}
				})
			} catch (e) {
				console.error("Failed to parse saved weapons config", e)
			}
		}

		// F2 toggle key
		document.addEventListener('keydown', (e) => {
			if (e.key === 'F2') {
				this.devInspectorOpen = !this.devInspectorOpen
				const el = document.getElementById('dev-inspector')
				if (el) {
					if (this.devInspectorOpen) {
						el.classList.remove('dev-closed')
						document.exitPointerLock()
					} else {
						el.classList.add('dev-closed')
						// Request pointer lock again when closing the inspector
						const mainCanvas = document.getElementById('main-canvas')
						if (mainCanvas) {
							mainCanvas.requestPointerLock()
						}
					}
				}
			}
		})

		// Inputs event listeners
		const typeEl = document.getElementById('dev-weapon-type')
		const fireEl = document.getElementById('dev-fire-cooldown')
		const reloadEl = document.getElementById('dev-reload-time')
		const magEl = document.getElementById('dev-mag-capacity')
		const resEl = document.getElementById('dev-max-reserve')
		const dmgEl = document.getElementById('dev-damage')
		const rngEl = document.getElementById('dev-range')
		const speedEl = document.getElementById('dev-proj-speed')

		const onInputChange = () => {
			const w = weapons[this.weaponIndex]
			if (!w) return

			w.type = typeEl.value === '0' ? 'hitscan' : 'projectile'
			w.fireCooldown = parseFloat(fireEl.value) || 0.1
			w.reloadTime = parseFloat(reloadEl.value) || 1.0
			w.magazineCapacity = parseInt(magEl.value, 10) || 10
			w.maxReserveAmmo = parseInt(resEl.value, 10) || 50
			w.damage = parseFloat(dmgEl.value) || 10
			w.range = parseFloat(rngEl.value) || 50
			w.projectileSpeed = parseFloat(speedEl.value) || 30

			// Save to localStorage
			const configsToSave = weapons.map(weapon => ({
				index: weapon.index,
				type: weapon.type,
				fireCooldown: weapon.fireCooldown,
				reloadTime: weapon.reloadTime,
				magazineCapacity: weapon.magazineCapacity,
				maxReserveAmmo: weapon.maxReserveAmmo,
				damage: weapon.damage,
				range: weapon.range,
				projectileSpeed: weapon.projectileSpeed
			}))
			localStorage.setItem('dev_weapons_config', JSON.stringify(configsToSave))

			// Sync command to server
			this.client.addCommand(new DevUpdateWeaponConfigCommand({
				index: this.weaponIndex,
				type: typeEl.value === '0' ? 0 : 1,
				fireCooldown: w.fireCooldown,
				reloadTime: w.reloadTime,
				magazineCapacity: w.magazineCapacity,
				maxReserveAmmo: w.maxReserveAmmo,
				damage: w.damage,
				range: w.range,
				projectileSpeed: w.projectileSpeed
			}))

			// Adjust active ammunition state boundaries if needed
			if (this.myRawEntity && this.myRawEntity.weaponsState) {
				const state = this.myRawEntity.weaponsState[this.weaponIndex]
				if (state.magazineAmmo > w.magazineCapacity) {
					state.magazineAmmo = w.magazineCapacity
				}
				if (state.reserveAmmo > w.maxReserveAmmo) {
					state.reserveAmmo = w.maxReserveAmmo
				}
			}
		}

		if (typeEl) typeEl.addEventListener('change', onInputChange)
		if (fireEl) fireEl.addEventListener('input', onInputChange)
		if (reloadEl) reloadEl.addEventListener('input', onInputChange)
		if (magEl) magEl.addEventListener('input', onInputChange)
		if (resEl) resEl.addEventListener('input', onInputChange)
		if (dmgEl) dmgEl.addEventListener('input', onInputChange)
		if (rngEl) rngEl.addEventListener('input', onInputChange)
		if (speedEl) speedEl.addEventListener('input', onInputChange)

		this._updateDevInspectorInputs()
	}
}

export default Simulator
