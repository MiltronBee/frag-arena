import nengi from 'nengi'
import * as BABYLON from 'babylonjs'

class Projectile {
	constructor(startX = 0, startY = 0, startZ = 0) {
		// Only create mesh in the scene if there is a LastCreatedScene available
		const scene = BABYLON.Engine.LastCreatedScene
		if (scene) {
			// A TIGHT hot core (was a 0.4 soft cyan orb — the cartoonish "slow toy
			// projectile"). Small + additive so it reads as a hot energy bolt, and the
			// Simulator stretches it along its travel direction each frame (a motion
			// streak) so it feels fast even at the unchanged authoritative speed.
			this.mesh = BABYLON.MeshBuilder.CreateSphere('projectile', { diameter: 0.15 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			// never let a bolt intercept another shot's presentation raycast / picking
			this.mesh.isPickable = false

			// Glowing material (only on client/visual engines; NullEngine stays bare
			// so the headless server + tests allocate nothing)
			if (scene.getEngine().name !== 'NullEngine') {
				const core = new BABYLON.StandardMaterial('projCore', scene)
				core.emissiveColor = new BABYLON.Color3(0.78, 1.0, 1.0) // white-hot cyan core
				core.diffuseColor = new BABYLON.Color3(0, 0, 0)
				core.disableLighting = true
				core.alphaMode = BABYLON.Engine.ALPHA_ADD
				this.mesh.material = core

				// a SMALL soft additive halo — a hot edge, not a giant neon blob. Parented
				// to the core so it follows position + the travel-streak scaling, and is
				// disposed with the core by the factory's mesh.dispose(false, true).
				const glow = BABYLON.MeshBuilder.CreateSphere('projGlow', { diameter: 0.30 }, scene)
				glow.parent = this.mesh
				glow.isPickable = false
				const glowMat = new BABYLON.StandardMaterial('projGlowMat', scene)
				glowMat.emissiveColor = new BABYLON.Color3(0.2, 0.85, 1.0)
				glowMat.diffuseColor = new BABYLON.Color3(0, 0, 0)
				glowMat.disableLighting = true
				glowMat.alpha = 0.5
				glowMat.alphaMode = BABYLON.Engine.ALPHA_ADD
				glowMat.backFaceCulling = false
				glow.material = glowMat
				this.glowMesh = glow
			}
		} else {
			// Fallback placeholder object for headless testing
			this.mesh = {
				position: new BABYLON.Vector3(startX, startY, startZ),
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
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

Projectile.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true }
}

export default Projectile
