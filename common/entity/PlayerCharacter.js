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

		// Phase 4 mega-health OVERHEAL decay (server-only, NOT networked — the decay
		// runs server-side in GameInstance.update and the resulting hitpoints ARE
		// networked). While hitpoints > 100, HP decays 2/sec, but only AFTER this
		// grace timer (set to 3.0 on pickup) has counted down to 0. Cleared on respawn.
		this.overhealDecayTimer = 0

		// callsign: index into common/playerNames.js PLAYER_NAMES (UInt8 on the wire).
		// A value of HUMAN_NAME_SENTINEL (30) means "human player — real name arrives
		// via the PlayerName message" (the callsign the human typed); bots use 0–29.
		this.nameIndex = 0

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

		// Phase 2 debuff: a Plasma hit slows ground accel + max speed by slowFactor
		// for slowTimer seconds. slowTimer is networked so the victim's own client
		// prediction applies the debuff deterministically during reconciliation;
		// slowFactor is server-derived (set alongside slowTimer on hit).
		this.slowTimer = 0
		this.slowFactor = 0

		// Phase 2 swap commitment: seconds left before the just-equipped weapon can
		// fire. Predicted + server-computed from the same switch event (not networked).
		this.equipTimer = 0

		// Phase 3 frag grenades (server-authoritative; the throw is NOT predicted).
		// grenadeCharges is networked (UInt8) so the HUD shows the live count.
		// throwCooldown gates min-interval between throws; rechargeAccum accrues the
		// 12s-per-charge regen. Both are server-only (ticked in GameInstance.update).
		this.grenadeCharges = 2       // start full
		this.throwCooldown = 0        // seconds until the next throw is allowed
		this.rechargeAccum = 0        // seconds accrued toward the next +1 charge

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
	slowTimer: nengi.Float32,
	currentWeaponIndex: nengi.UInt8,
	grenadeCharges: nengi.UInt8,
	kills: nengi.UInt8,
	deaths: nengi.UInt8,
	nameIndex: nengi.UInt8
}

export default PlayerCharacter
