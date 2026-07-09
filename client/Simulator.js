import BABYLONRenderer from './graphics/BABYLONRenderer'
import InputSystem from './InputSystem'
import MoveCommand from '../common/command/MoveCommand'
import FireCommand from '../common/command/FireCommand'
import SwitchWeaponCommand from '../common/command/SwitchWeaponCommand'
import DevUpdateWeaponConfigCommand from '../common/command/DevUpdateWeaponConfigCommand'
import createFactories from './factories/createFactories'
import reconcilePlayer from './reconcilePlayer'
import applyCommand, { DODGE_DIRS } from '../common/applyCommand'
import { fire } from '../common/weapon'
import Viewmodel from './graphics/Viewmodel'
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

		// first-person weapon, swap with 1-4 / Q / wheel. Only the EQUIPPED weapon's
		// rig lives in the scene: multiple copies of the same skeleton coexisting
		// cross-wire each other's poses in Babylon 4.0.3, so we dispose + reload on
		// switch (the .glb is browser-cached; the swap hitch is negligible).
		this.weaponIndex = 0
		this.viewmodel = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[0])
		this.viewmodel.setActive(true)
		this._setupWeaponSwitching()

		// Load settings with defaults
		this.sensitivity = parseFloat(localStorage.getItem('sens') || '1.0')
		this.fov = parseInt(localStorage.getItem('fov') || '95', 10)
		this.renderer.camera.fov = (this.fov * Math.PI) / 180
		this._setupSettingsUI()
		
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

		client.on('message::WeaponFired', message => {
			if (message.sourceId === this.mySmoothEntity.nid) {
				// hide our own shots.. we'll predict those instead
				return
			}
			this.renderer.drawHitscan(message, new BABYLON.Color3(1, 0, 0))
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

	// equip weapon by index (wraps around); updates the on-screen weapon name
	switchWeapon(index) {
		const n = weapons.length
		index = ((index % n) + n) % n
		if (index === this.weaponIndex) return
		this.viewmodel.dispose()
		this.weaponIndex = index
		this.viewmodel = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[index])
		this.viewmodel.setActive(true)
		
		if (this.myRawEntity) {
			this.myRawEntity.currentWeaponIndex = index
			this.client.addCommand(new SwitchWeaponCommand(index))
		}

		this._updateDevInspectorInputs()

		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[index].name
	}

	_setupWeaponSwitching() {
		document.addEventListener('keydown', (e) => {
			if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') {
				this.switchWeapon(parseInt(e.code.slice(5), 10) - 1)
			} else if (e.key === 'q' || e.key === 'Q') {
				this.switchWeapon(this.weaponIndex + 1)
			}
		})
		document.addEventListener('wheel', (e) => {
			this.switchWeapon(this.weaponIndex + (e.deltaY > 0 ? 1 : -1))
		})
		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[0].name
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
				this.viewmodel.cancelReload()
			}

			// Handle visual reload start if state.reloading became true (covers manual and auto-reload)
			if (!wasReloading && this.myRawEntity.weaponsState[this.weaponIndex].reloading) {
				this.viewmodel.reload()
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

			// move the camera to our entity
			Object.assign(this.renderer.camera.position, this.myRawEntity.mesh.position)

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
					const muzzle = this.viewmodel.muzzleWorldPos()
					const spec = {
						x: muzzle ? muzzle.x : this.myRawEntity.x,
						y: muzzle ? muzzle.y : this.myRawEntity.y,
						z: muzzle ? muzzle.z : this.myRawEntity.z,
						tx: ray.direction.x,
						ty: ray.direction.y,
						tz: ray.direction.z,
					}
					// draw a predicted shot locally for hitscan weapons
					if (ray.config.type === 'hitscan') {
						this.renderer.drawHitscan(spec, new BABYLON.Color3(1, 0.7, 0.2), { muzzle: false })
					}
					this.renderer.flashMuzzle(muzzle)

					// play the pack's fire animation (arms recoil + gun action)
					this.viewmodel.kick()
				}
			}

			// Update Ammo Counter HUD
			if (this.myRawEntity.weaponsState) {
				const ammoEl = document.getElementById('ammo-counter')
				if (ammoEl) {
					if (state.reloading) {
						ammoEl.textContent = 'RELOADING...'
					} else {
						ammoEl.textContent = `${state.magazineAmmo} / ${state.reserveAmmo}`
					}
				}
			}

			// bob the equipped weapon each frame (based on movement)
			this.viewmodel.update(delta, forwards || backwards || left || right)
		}

		// drive other players' character visuals (position/yaw follow + idle/run anim)
		this.characterModels.forEach(model => model.update(delta))

		this.renderer.update()
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

		document.addEventListener('pointerlockchange', () => {
			if (document.pointerLockElement === this.input.canvasEle) {
				if (menu) menu.classList.add('settings-closed')
			} else {
				if (menu && !this.devInspectorOpen) {
					menu.classList.remove('settings-closed')
				}
			}
		})
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
