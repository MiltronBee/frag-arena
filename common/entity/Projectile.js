import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

class Projectile {
	constructor(startX = 0, startY = 0, startZ = 0) {
		this._x = startX
		this._y = startY
		this._z = startZ

		// Only create mesh in the scene if there is a LastCreatedScene available
		const scene = Engine.LastCreatedScene
		if (scene) {
			// A TIGHT hot core (was a 0.4 soft cyan orb — the cartoonish "slow toy
			// projectile"). Small + additive so it reads as a hot energy bolt, and the
			// Simulator stretches it along its travel direction each frame (a motion
			// streak) so it feels fast even at the unchanged authoritative speed.
			this.mesh = MeshBuilder.CreateSphere('projectile', { diameter: 0.15 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			// never let a bolt intercept another shot's presentation raycast / picking
			this.mesh.isPickable = false

			// Glowing material (only on client/visual engines; NullEngine stays bare
			// so the headless server + tests allocate nothing)
			if (scene.getEngine().name !== 'NullEngine') {
				const core = new StandardMaterial('projCore', scene)
				core.emissiveColor = new Color3(0.78, 1.0, 1.0) // white-hot cyan core
				core.diffuseColor = new Color3(0, 0, 0)
				core.disableLighting = true
				core.alphaMode = Engine.ALPHA_ADD
				this.mesh.material = core

				// a SMALL soft additive halo — a hot edge, not a giant neon blob. Parented
				// to the core so it follows position + the travel-streak scaling, and is
				// disposed with the core by the factory's mesh.dispose(false, true).
				const glow = MeshBuilder.CreateSphere('projGlow', { diameter: 0.30 }, scene)
				glow.parent = this.mesh
				glow.isPickable = false
				const glowMat = new StandardMaterial('projGlowMat', scene)
				glowMat.emissiveColor = new Color3(0.2, 0.85, 1.0)
				glowMat.diffuseColor = new Color3(0, 0, 0)
				glowMat.disableLighting = true
				glowMat.alpha = 0.5
				glowMat.alphaMode = Engine.ALPHA_ADD
				glowMat.backFaceCulling = false
				glow.material = glowMat
				this.glowMesh = glow
			}
		} else {
			// Fallback placeholder object for headless testing
			this.mesh = {
				position: new Vector3(startX, startY, startZ),
				dispose() {}
			}
		}

		// Server physics parameters
		this.dirX = 0
		this.dirY = 0
		this.dirZ = 0
		this.speed = 0
		this.damage = 0
		this.ownerNid = 0
		this.lifeTime = 3.0
		// Server-only collision radius for the projectile-vs-player hit test. Defaults
		// to the historic hardcoded 0.75m; the spawn site may scale it down for aimed
		// Plasma (ads.projSizeMult) so an ADS bolt is a thin, precise dart.
		this.radius = 0.75
		// Phase 2 (server-only): Flak shrapnel bounces off obstacles this many more
		// times before dying; Plasma bolts carry a slow debuff to apply on a player hit.
		this.bounceRemaining = 0
		this.slowFactor = 0
		this.slowDuration = 0
	}

	get x() { return this._x }
	set x(value) {
		this._x = value
		if (this.mesh) this.mesh.position.x = value
	}

	get y() { return this._y }
	set y(value) {
		this._y = value
		if (this.mesh) this.mesh.position.y = value
	}

	get z() { return this._z }
	set z(value) {
		this._z = value
		if (this.mesh) this.mesh.position.z = value
	}
}

Projectile.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true },
	ownerNid: nengi.UInt16
}

export default Projectile
