import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'
import { MEGA_STATE } from './MegaHealthPickup.js'

// UT-STYLE PICKUP (v1) — the generalized sibling of MegaHealthPickup.js: one entity type
// for every map item (weapon / ammo / health / armor / powerup). Same shape as the mega:
// a bare position-holder on the headless server (NullEngine) and a tiny non-pickable
// placeholder box on visual engines that the REAL model parents onto via the client
// factory (client/factories/createFactories.js). ALL pickup/respawn authority is
// server-side (GameInstance.updatePickups); the client only renders + predicts its own
// refill off the networked `state`.
//
// STATE reuses MEGA_STATE so the client's bob/spin/glow/charge presentation is shared:
//   0 HIDDEN    (taken / silently charging — mesh off)
//   1 CHARGING  (final ~5s before respawn — scale/fade-in tell)
//   2 AVAILABLE (present + grabbable)
export { MEGA_STATE as PICKUP_STATE }

class Pickup {
	// type/weaponIndex identify WHAT this is (see common/pickupConfig.js PICKUP_TYPE):
	// for a WEAPON, weaponIndex is the granted roster weapon; for AMMO, the weapon whose
	// reserve it tops up; unused (0) for health/armor/powerup.
	constructor(startX = 0, startY = 0, startZ = 0, type = 0, weaponIndex = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			this.mesh = MeshBuilder.CreateBox('pickup', { size: 0.5 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false // never intercept a shot's raycast

			if (scene.getEngine().name !== 'NullEngine') {
				// placeholder tint (the real GLB replaces the box on the client). Cyan so an
				// un-modeled type (armor/powerup, v1-deferred assets) is at least visible.
				const mat = new StandardMaterial('pickupMat', scene)
				mat.emissiveColor = new Color3(0.2, 0.8, 1.0)
				mat.diffuseColor = new Color3(0.05, 0.2, 0.3)
				this.mesh.material = mat
				this.mat = mat
			}
		} else {
			this.mesh = { position: new Vector3(startX, startY, startZ), dispose() {} }
		}

		this.type = type
		this.weaponIndex = weaponIndex

		// present the moment the map finishes loading
		this.state = MEGA_STATE.AVAILABLE

		// server-only respawn bookkeeping (NOT networked). GameInstance.updatePickups
		// drives `state` off this.
		this.respawnAt = 0
		// server-only: cached respawn duration + rest height for logging/tuning.
		this.respawnMs = 0
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

Pickup.protocol = {
	// STATIC placement — no interp (unlike the mega, which keeps interp for parity).
	// A pickup never moves, so interpolation would only add per-snapshot cost.
	x: { type: nengi.Float32 },
	y: { type: nengi.Float32 },
	z: { type: nengi.Float32 },
	type: nengi.UInt8,
	state: nengi.UInt8,
	weaponIndex: nengi.UInt8,
}

export default Pickup
