import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

// CTF FLAG (v1) — a server-authoritative objective entity, modeled EXACTLY on
// common/entity/Pickup.js: a bare position-holder on the headless NullEngine and a
// tiny non-pickable placeholder box on visual engines (the client tints it as the
// flag marker — no bespoke model in v1). x/y/z getters proxy mesh.position so the
// entity always holds a REAL position — it is recorded into the lag-comp historian
// every tick like every other entity (server/lagCompensatedHitscanCheck.js reads
// realEntity.mesh.position), so it must never be NaN/undefined. Having no `.client`
// it is filtered out of damage resolution (performShot's PlayerCharacter gate) and
// it never occludes (occlusion tests occluderMeshes only), so it is historian-safe.
//
// STATE:
//   0 HOME     — resting on its team's stand (homeX/Y/Z)
//   1 CARRIED  — an enemy is carrying it; GameInstance copies the carrier's raw
//                position onto x/y/z every tick so it rides them (and follows
//                teleports on the next tick)
//   2 DROPPED  — the carrier died/left; sits on the floor with a return timer
export const FLAG_STATE = { HOME: 0, CARRIED: 1, DROPPED: 2 }

class Flag {
	// `team` is which team OWNS this flag (0 RED / 1 BLUE) — the ENEMY steals it and
	// scores their own team by returning it to their own home stand.
	constructor(startX = 0, startY = 0, startZ = 0, team = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			// a thin tall marker (reads as a flag pole); still isPickable=false so it
			// never intercepts a shot's raycast, exactly like Pickup.
			this.mesh = MeshBuilder.CreateBox('flag', { width: 0.4, height: 2.0, depth: 0.4 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false
			if (scene.getEngine().name !== 'NullEngine') {
				// additive-RGB team tint (no DynamicTexture opacity — the corona lesson).
				const mat = new StandardMaterial('flagMat', scene)
				mat.emissiveColor = team === 0 ? new Color3(1.0, 0.15, 0.12) : new Color3(0.2, 0.45, 1.0)
				mat.diffuseColor = new Color3(0.05, 0.05, 0.08)
				this.mesh.material = mat
				this.mat = mat
			}
		} else {
			this.mesh = { position: new Vector3(startX, startY, startZ), dispose() {} }
		}

		this.team = team
		this.state = FLAG_STATE.HOME
		// carrier's SMOOTH nid while CARRIED (canonical identity every client shares,
		// like the Killed feed), else 0.
		this.carrierNid = 0

		// server-only bookkeeping (NOT networked)
		this.homeX = startX
		this.homeY = startY
		this.homeZ = startZ
		this.droppedAt = 0        // wall-clock ms the flag entered DROPPED (return timer)
		this._carrier = null      // the carrying client/bot HANDLE while CARRIED
		this._removed = false
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

Flag.protocol = {
	// STATIC-ish placement — no interp. A HOME/DROPPED flag never moves; a CARRIED
	// flag is re-snapped to the carrier each tick (interp would smear it across the
	// map on a teleport — the same reason Pickup opts out).
	x: { type: nengi.Float32 },
	y: { type: nengi.Float32 },
	z: { type: nengi.Float32 },
	team: nengi.UInt8,
	state: nengi.UInt8,
	carrierNid: nengi.UInt16,
}

export default Flag
