import nengi from 'nengi'
import * as BABYLON from 'babylonjs'
import { weapons } from '../weaponsConfig'

const red = new BABYLON.Color4(1, 0, 0)
const blue = new BABYLON.Color4(0, 0, 1)
const faceColors = [red, blue, blue, blue, blue, blue]

class PlayerCharacter {
	constructor() {
		this.mesh = BABYLON.MeshBuilder.CreateBox('player', { size: 1, faceColors })
		this.mesh.ellipsoid = new BABYLON.Vector3(0.5, 0.5, 0.5)
		this.mesh.checkCollisions = true
		
		this.hitpoints = 100
		this.isAlive = true

		// match scoreboard (server-authoritative; UInt8 on the wire, so clamp at 255)
		this.kills = 0
		this.deaths = 0

		// movement state (see common/applyCommand.js) — velocities are synced +
		// predicted so reconciliation replays land on the server's trajectory
		this.velX = 0
		this.velY = 0
		this.velZ = 0
		this.grounded = false
		this.dodgeTimer = 0

		// Modular weapons state
		this.currentWeaponIndex = 0
		this.weaponsState = weapons.map(w => ({
			magazineAmmo: w.magazineCapacity,
			reserveAmmo: w.maxReserveAmmo,
			cooldownTimer: 0,
			onCooldown: false,
			heat: 0 // sustained-fire spread bloom (common/firePattern.js)
		}))

		// Keep legacy weapon object for backward compatibility with template checks
		this.weapon = {
			onCooldown: false,
			cooldown: 0.5,
			acc: 0
		}
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }

	get rotationX() { return this.mesh.rotation.x }
	set rotationX(value) { this.mesh.rotation.x = value }

	get rotationY() { return this.mesh.rotation.y }
	set rotationY(value) { this.mesh.rotation.y = value }

	get rotationZ() { return this.mesh.rotation.z }
	set rotationZ(value) { this.mesh.rotation.z = value }
}

PlayerCharacter.protocol = {
	x: { type: nengi.Float32, interp: true },
	y: { type: nengi.Float32, interp: true },
	z: { type: nengi.Float32, interp: true },
	rotationX: { type: nengi.RotationFloat32, interp: true },
	rotationY: { type: nengi.RotationFloat32, interp: true },
	rotationZ: { type: nengi.RotationFloat32, interp: true },
	velX: nengi.Float32,
	velY: nengi.Float32,
	velZ: nengi.Float32,
	isAlive: nengi.Boolean,
	hitpoints: nengi.UInt8,
	currentWeaponIndex: nengi.UInt8,
	kills: nengi.UInt8,
	deaths: nengi.UInt8
}

export default PlayerCharacter
