import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

// DOM CONTROL POINT (v1) — a server-authoritative objective entity, same shape as
// common/entity/Flag.js / Pickup.js: a bare position-holder on the headless
// NullEngine and a non-pickable placeholder box on visual engines (the client tints
// it by owner). It holds a REAL position every tick (historian-safe — see Flag.js),
// has no `.client` (never a damage target) and never occludes.
//
// OWNER:  2 NEUTRAL / 0 team0 (RED) / 1 team1 (BLUE)
export const CP_OWNER = { NEUTRAL: 2, RED: 0, BLUE: 1 }

class ControlPoint {
	// `index` (0/1/2) maps to the display label A/B/C on the HUD.
	constructor(startX = 0, startY = 0, startZ = 0, index = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			// a low wide pad marker
			this.mesh = MeshBuilder.CreateBox('controlPoint', { width: 1.6, height: 0.35, depth: 1.6 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false
			if (scene.getEngine().name !== 'NullEngine') {
				const mat = new StandardMaterial('cpMat', scene)
				mat.emissiveColor = new Color3(0.6, 0.6, 0.6) // NEUTRAL grey
				mat.diffuseColor = new Color3(0.05, 0.05, 0.06)
				this.mesh.material = mat
				this.mat = mat
			}
		} else {
			this.mesh = { position: new Vector3(startX, startY, startZ), dispose() {} }
		}

		this.index = index
		this.owner = CP_OWNER.NEUTRAL
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

ControlPoint.protocol = {
	x: { type: nengi.Float32 },
	y: { type: nengi.Float32 },
	z: { type: nengi.Float32 },
	owner: nengi.UInt8,
	index: nengi.UInt8,
}

export default ControlPoint
