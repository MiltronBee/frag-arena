import BABYLONRenderer from './graphics/BABYLONRenderer'
import InputSystem from './InputSystem'
import MoveCommand from '../common/command/MoveCommand'
import FireCommand from '../common/command/FireCommand'
import createFactories from './factories/createFactories'
import reconcilePlayer from './reconcilePlayer'
import applyCommand from '../common/applyCommand'
import { fire } from '../common/weapon'
import Viewmodel from './graphics/Viewmodel'
import { assets, weapons } from './assets/assetManifest'

// ignoring certain data from the sever b/c we will be predicting these properties on the client
const ignoreProps = ['x', 'y', 'z']
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
			this.renderer.camera.rotation.x += e.movementY * 0.001 // sens
			this.renderer.camera.rotation.y += e.movementX * 0.001

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
		this.input.releaseKeys()

		/* all of this is just for our own entity */
		if (this.myRawEntity) {
			// which way are we pointing?
			const camRay = this.renderer.camera.getForwardRay().direction

			/* begin movement */
			const { forwards, left, backwards, right, jump } = input
			const moveCommand = new MoveCommand({
				camRayX: camRay.x,
				camRayY: camRay.y,
				camRayZ: camRay.z,
				forwards, backwards, left, right, jump,
				delta
			})
			// send moveCommand to the server
			this.client.addCommand(moveCommand)

			// apply moveCommand  to our local entity
			applyCommand(this.myRawEntity, moveCommand)

			// save the result of applying the command as a prediction
			const prediction = {
				nid: this.myRawEntity.nid,
				x: this.myRawEntity.x,
				y: this.myRawEntity.y,
				z: this.myRawEntity.z
			}
			this.client.addCustomPrediction(this.client.tick, prediction, ['x', 'y', 'z'])

			// move the camera to our entity
			Object.assign(this.renderer.camera.position, this.myRawEntity.mesh.position)

			/* reloading (R) — edge-triggered so holding the key doesn't restart it */
			if (input.reload && !this._reloadHeld) {
				this.viewmodel.reload()
			}
			this._reloadHeld = input.reload

			/* shooting (blocked while the reload animation runs) */
			if (input.mouseDown && !this.viewmodel.isReloading) {
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
					// draw a predicted shot locally (no center-screen flash — ours
					// comes off the muzzle)
					this.renderer.drawHitscan(spec, new BABYLON.Color3(1, 0.7, 0.2), { muzzle: false })
					this.renderer.flashMuzzle(muzzle)

						// play the pack's fire animation (arms recoil + gun action)
						this.viewmodel.kick()
				}
			}

			// bob the equipped weapon each frame (based on movement)
			this.viewmodel.update(delta, forwards || backwards || left || right)
		}

		// drive other players' character visuals (position/yaw follow + idle/run anim)
		this.characterModels.forEach(model => model.update(delta))

		this.renderer.update()
	}
}

export default Simulator
