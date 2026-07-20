import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

// Phase 4 MEGA-HEALTH PICKUP — the arena's "heartbeat". ONE contested power item
// near the center that heals big (min(150, hp+100), can overheal past 100) on a
// fixed 60s respawn clock the whole lobby fights over. Modeled on Grenade.js: a
// bare position-holder on the headless server (NullEngine) and a minimal
// placeholder mesh on visual engines (the REAL Quaternius health-pack model
// attaches via the client factory, mirroring the grenade). All pickup/respawn
// authority lives server-side in GameInstance.update.
//
// The wire protocol networks x/y/z (fixed, but keeps parity with the other
// entities) plus a single `state` UInt8 the client drives ALL presentation off:
//   0 = HIDDEN   (taken / charging silently — mesh off, hum off)
//   1 = CHARGING (last ~5s before respawn — the RISING-hum tell + scale/fade-in)
//   2 = AVAILABLE(present — ambient hum + bob/spin + amber glow, grabbable)
export const MEGA_STATE = { HIDDEN: 0, CHARGING: 1, AVAILABLE: 2 }

class MegaHealthPickup {
	constructor(startX = 0, startY = 0, startZ = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			// a small placeholder box — the position holder the real GLB model parents
			// onto (like the grenade's pebble). Kept tiny + non-pickable so it never
			// intercepts a shot's raycast.
			this.mesh = MeshBuilder.CreateBox('megaHealth', { size: 0.5 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false

			// only build a visual material on client/visual engines; the headless
			// server (NullEngine) stays bare so it allocates nothing.
			if (scene.getEngine().name !== 'NullEngine') {
				const mat = new StandardMaterial('megaHealthMat', scene)
				mat.emissiveColor = new Color3(1.0, 0.75, 0.2) // amber
				mat.diffuseColor = new Color3(0.2, 0.12, 0.0)
				mat.specularColor = new Color3(0.3, 0.25, 0.15)
				this.mesh.material = mat
				this.mat = mat
			}
		} else {
			// headless fallback placeholder (matches Grenade.js / Projectile.js)
			this.mesh = {
				position: new Vector3(startX, startY, startZ),
				dispose() {}
			}
		}

		// networked presentation state (see MEGA_STATE). Starts AVAILABLE — the pickup
		// is present the moment the arena boots.
		this.state = MEGA_STATE.AVAILABLE

		// server-only respawn bookkeeping (NOT networked): wall-clock ms the pickup
		// returns after being taken. GameInstance.update drives state off this.
		this.respawnAt = 0
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

MegaHealthPickup.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true },
	state: nengi.UInt8
}

export default MegaHealthPickup
