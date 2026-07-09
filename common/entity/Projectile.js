import nengi from 'nengi'
import * as BABYLON from 'babylonjs'

class Projectile {
	constructor(startX = 0, startY = 0, startZ = 0) {
		// Only create mesh in the scene if there is a LastCreatedScene available
		const scene = BABYLON.Engine.LastCreatedScene
		if (scene) {
			this.mesh = BABYLON.MeshBuilder.CreateSphere('projectile', { diameter: 0.4 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			
			// Glowing cyan material for visual projection (only on the client/visual engines)
			if (scene.getEngine().name !== 'NullEngine') {
				const mat = new BABYLON.StandardMaterial('projMat', scene)
				mat.emissiveColor = new BABYLON.Color3(0, 1, 1)
				mat.disableLighting = true
				this.mesh.material = mat
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
