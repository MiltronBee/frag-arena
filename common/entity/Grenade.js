import nengi from 'nengi'
import { Engine, MeshBuilder, StandardMaterial, Color3, Vector3 } from '../babylon.node.js'

// Phase 3 THROWN FRAG GRENADE. Modeled on Projectile.js but a fundamentally
// different projectile: it bounces (restitution) off floor + obstacles, does NOT
// deal contact damage, and detonates on a FUSE timer into an AoE blast. All of
// that physics lives server-side (GameInstance.update); the protocol networks
// only x/y/z (like Projectile) so remote clients just render the moving pebble
// and fire an explosion FX when it's deleted.
class Grenade {
	constructor(startX = 0, startY = 0, startZ = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			// a small dark sphere — the "pebble" that arcs through the air. Kept tiny
			// so it reads as a thrown object, not another energy bolt.
			this.mesh = MeshBuilder.CreateSphere('grenade', { diameter: 0.22 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false

			// only build visual materials on client/visual engines; the headless
			// server (NullEngine) stays bare so it allocates nothing
			if (scene.getEngine().name !== 'NullEngine') {
				const body = new StandardMaterial('grenadeBody', scene)
				body.diffuseColor = new Color3(0.10, 0.11, 0.09) // dark casing
				body.specularColor = new Color3(0.2, 0.2, 0.2)
				body.emissiveColor = new Color3(0, 0, 0)
				this.mesh.material = body

				// a small emissive "arming light" that the client blinks (faster as the
				// fuse nears 0). Parented so it follows position and is disposed with the
				// body by the factory's mesh.dispose(false, true).
				const light = MeshBuilder.CreateSphere('grenadeLight', { diameter: 0.10 }, scene)
				light.parent = this.mesh
				light.isPickable = false
				const lightMat = new StandardMaterial('grenadeLightMat', scene)
				lightMat.emissiveColor = new Color3(1.0, 0.35, 0.1) // orange-red
				lightMat.diffuseColor = new Color3(0, 0, 0)
				lightMat.disableLighting = true
				lightMat.alphaMode = Engine.ALPHA_ADD
				light.material = lightMat
				this.lightMesh = light
				this.lightMat = lightMat
			}
		} else {
			// headless fallback placeholder (matches Projectile.js)
			this.mesh = {
				position: new Vector3(startX, startY, startZ),
				dispose() {}
			}
		}

		// Server physics parameters (server-only; not networked)
		this.velocity = new Vector3(0, 0, 0)
		this.ownerNid = 0
		this.fuse = 1.8       // seconds until detonation (regardless of bounces)
		this.restitution = 0.4 // energy kept per bounce
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

Grenade.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true }
}

export default Grenade
