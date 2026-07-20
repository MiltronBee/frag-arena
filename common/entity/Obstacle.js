import nengi from 'nengi'
import * as BABYLON from '../babylon.node.js'

class Obstacle {
	constructor() {
		this.mesh = BABYLON.MeshBuilder.CreateBox('obstacle', { size: 1 })
		this.mesh.checkCollisions = true
		this.width = 3
		this.height = 3
		this.depth = 3
		this.style = 0
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

Obstacle.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true },
	width: nengi.Float32,
	height: nengi.Float32,
	depth: nengi.Float32,
	style: nengi.UInt8
}

export default Obstacle
