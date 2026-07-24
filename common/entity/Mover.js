import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

// UT99 LIFT PLATFORM (v1) — a server-authoritative moving platform, modeled on
// common/entity/Obstacle.js (interp x/y/z + static box dims) with the historian-safety
// rules of common/entity/Flag.js: it always holds a REAL, never-NaN position (recorded
// into the lag-comp historian every tick like every other entity), it is isPickable=false
// so it never intercepts a shot's raycast (hitscan tests occluderMeshes only, so the
// platform does NOT occlude), and it carries no `.client` so damage resolution filters it
// out.
//
// On the SERVER the mesh is a collidable floor: checkCollisions=true so the shared sim's
// moveWithCollisions floor probe lands a rider on the platform top, and the state machine
// resyncs the mesh position every tick. On the CLIENT the factory FORCES checkCollisions
// OFF: a moving collision box + nengi's ~100 ms interp lag ejects the rider out of the
// carry band mid-rise (DESIGN option a's documented failure — verified in _probe-lifts),
// so the client relies purely on the idempotent carry clamp (Simulator._carryClampSelf,
// DESIGN option b), reading this entity's INTERPOLATED position/dims. The default below is
// on for the server; the client factory turns it off.
//
// entity.y is the platform box CENTRE. The standable SURFACE TOP is y + height/2; a rider
// rests RIDE_REST above that. The carry (platform clamp) lives OUTSIDE applyCommand — in
// GameInstance (server) and Simulator (client) — see server/movers.js MOVER_CARRY.
//
// STATE (networked, for SFX/visual edges — see server/movers.js MOVER_STATE):
//   0 AT_BOTTOM   1 RISING   2 AT_TOP   3 DESCENDING
export const MOVER_STATE = { AT_BOTTOM: 0, RISING: 1, AT_TOP: 2, DESCENDING: 3 }

class Mover {
	constructor() {
		const scene = Engine.LastCreatedScene
		if (scene) {
			this.mesh = MeshBuilder.CreateBox('mover', { size: 1 }, scene)
			// STANDABLE (server only): the server's moveWithCollisions floor probe must land
			// on this so players/bots stand + the floor probe reads grounded. On the CLIENT
			// the box is NON-colliding: a rising collision box penetrates the predicted
			// capsule between interp-timed frames and moveWithCollisions ejects the rider out
			// of the carry band (the DESIGN's rejected option (a) — verified here), so the
			// client rides on the idempotent clamp alone (DESIGN option (b)). NullEngine ==
			// the headless server scene.
			this.mesh.checkCollisions = scene.getEngine().name === 'NullEngine'
			// never intercept a shot's raycast (hitscan reads occluderMeshes, not this) —
			// same historian-safety rule as Flag / Pickup.
			this.mesh.isPickable = false
			if (scene.getEngine().name !== 'NullEngine') {
				// v1 visual: a simple shaded box the size of the real UT platform. Additive-RGB
				// tint only (no DynamicTexture opacity — the corona lesson). A dim emissive edge
				// reads it as a powered lift without a neon glare.
				const mat = new StandardMaterial('moverMat', scene)
				mat.diffuseColor = new Color3(0.16, 0.17, 0.2)
				mat.emissiveColor = new Color3(0.12, 0.14, 0.18)
				mat.specularColor = new Color3(0.05, 0.05, 0.06)
				this.mesh.material = mat
				this.mat = mat
			}
		} else {
			this.mesh = { position: new Vector3(0, 0, 0), scaling: new Vector3(1, 1, 1), computeWorldMatrix() {}, dispose() {} }
		}

		this.width = 3
		this.height = 1
		this.depth = 3
		this.style = 0
		this.state = MOVER_STATE.AT_BOTTOM
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }

	get width() { return this.mesh.scaling.x }
	set width(value) { this.mesh.scaling.x = value }

	get height() { return this.mesh.scaling.y }
	set height(value) { this.mesh.scaling.y = value }

	get depth() { return this.mesh.scaling.z }
	set depth(value) { this.mesh.scaling.z = value }
}

Mover.protocol = {
	// x/z are static in practice (Deck16 lifts are pure vertical) but interp'd for free
	// so a future horizontal/rotating mover needs no protocol change. y is the moving axis.
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true },
	width: nengi.Float32,
	height: nengi.Float32,
	depth: nengi.Float32,
	style: nengi.UInt8,
	state: nengi.UInt8,
}

export default Mover
