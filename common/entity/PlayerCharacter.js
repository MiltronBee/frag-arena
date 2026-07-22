import nengi from 'nengi'
import * as BABYLON from '../babylon.node.js'
import { weapons, SPAWN_WEAPON_INDEX } from '../weaponsConfig'

const red = new BABYLON.Color4(1, 0, 0)
const blue = new BABYLON.Color4(0, 0, 1)
const faceColors = [red, blue, blue, blue, blue, blue]

// Spawn loadout: pistol only (SPAWN_WEAPON_INDEX). One place the "start with the
// pistol" rule lives — GameInstance.respawnPlayer resets to this too.
const PISTOL_ONLY = 1 << SPAWN_WEAPON_INDEX

class PlayerCharacter {
	constructor() {
		this.mesh = BABYLON.MeshBuilder.CreateBox('player', { size: 1, faceColors })
		this.mesh.ellipsoid = new BABYLON.Vector3(0.5, 0.5, 0.5)
		this.mesh.checkCollisions = true
		
		this.hitpoints = 100
		this.isAlive = true

		// MENU SAFETY (v1) SPAWN IMMUNITY (seconds remaining, server-authoritative).
		// Set to 1.0 by GameInstance on a deploy-spawn AND on every respawn, ticked
		// down at 40Hz server-side, and INSTANTLY revoked by the first movement /
		// fire / throw command or any pickup touch (never by menus or UI state —
		// opening Settings mid-match grants nothing). While > 0 damagePlayer drops
		// every hit. Networked (Float32) so the local HUD can show the SPAWN SHIELD
		// tell and probes can observe it; set on raw+smooth in LOCKSTEP like
		// hitpoints (the classic footgun). The client never asserts it (down-only).
		this.spawnImmunity = 0

		// UT-STYLE ARMOR (server-authoritative). 0..ARMOR_CAP(150). Absorbs a fixed
		// fraction of each incoming hit in damagePlayer (green-armor model) until
		// depleted. Networked (UInt8) so the local player's HUD can draw an armor bar;
		// set on raw+smooth in lockstep like hitpoints. Reset to 0 on respawn/death.
		this.armor = 0

		// UT UDAMAGE powerup timer (seconds remaining). While > 0, the player's OUTGOING
		// damage is multiplied (UDAMAGE_MULT) in damagePlayer. Server-decremented in
		// GameInstance.update (outside the reconciled applyCommand path, like the grenade
		// timers) and networked (Float32) so the client renders the buff (HUD countdown +
		// screen tint on self, glow on others). Set on raw+smooth in lockstep; cleared on
		// respawn.
		this.udamageTimer = 0

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

		// TDM team (0 or 1). Server-authoritative — assigned on join/spawn by
		// GameInstance auto-balance and networked down (UInt8). Drives friendly-fire,
		// team spawns, team scoring, bot targeting and the client's team colors.
		// Kept across respawns (respawnPlayer never resets it). The client NEVER
		// asserts it (down-only; a mismatch just snaps).
		this.teamId = 0

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

		// ADS aim ramp (0..1). NOT networked — both client (prediction) and server
		// (authority) derive it deterministically from command.aimInput in applyCommand,
		// so it reconciles exactly (like equipTimer). Drives ADS accuracy in weapon.fire().
		this.aimFactor = 0

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

		// UT-STYLE OWNERSHIP (v1). A player spawns owning ONLY the pistol (roster index
		// 3) and finds the rest on the map. `ownedWeapons` is a bitmask (bit i = owns
		// weapon i) and IS networked (UInt8) so the HUD greys unowned slots and the
		// client can predict its own refill on a grant. weapon.fire() and the switch
		// gate (applyCommand + the GameInstance switch handler) refuse an unowned index.
		// Server-authoritative: the client never asserts an ownership bit (down-only; a
		// mismatch just snaps). Bots are granted the full arsenal in GameInstance.addBot.
		this.ownedWeapons = PISTOL_ONLY

		// Modular weapons state. Non-owned weapons start with ZERO ammo (magazine +
		// reserve) so an ownership bug can never leak firepower; a weapon pickup refills
		// its own weapon on grant (GameInstance.updatePickups).
		// Equip the pistol (the one owned weapon) — index 0 is the rifle, which a fresh
		// spawn doesn't own, so equipping it meant holding an empty gun on first join.
		// respawnPlayer already re-equips this index; this makes first spawn match.
		this.currentWeaponIndex = SPAWN_WEAPON_INDEX
		this.weaponsState = weapons.map((w, i) => {
			const owned = (this.ownedWeapons & (1 << i)) !== 0
			return {
				magazineAmmo: owned ? w.magazineCapacity : 0,
				reserveAmmo: owned ? w.maxReserveAmmo : 0,
				cooldownTimer: 0,
				onCooldown: false,
				heat: 0 // sustained-fire spread bloom (common/firePattern.js)
			}
		})

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
	spawnImmunity: nengi.Float32,
	armor: nengi.UInt8,
	udamageTimer: nengi.Float32,
	slowTimer: nengi.Float32,
	currentWeaponIndex: nengi.UInt8,
	ownedWeapons: nengi.UInt8,
	grenadeCharges: nengi.UInt8,
	kills: nengi.UInt8,
	deaths: nengi.UInt8,
	nameIndex: nengi.UInt8,
	teamId: nengi.UInt8
}

// Exposed so server code (GameInstance.respawnPlayer) resets to the same spawn loadout.
PlayerCharacter.PISTOL_ONLY = PISTOL_ONLY
// "ALL" = every ENABLED weapon. Disabled roster entries (weaponsConfig `disabled`,
// e.g. Plasma since 2026-07-22) keep their index but are excluded here, so bots and
// full-arsenal grants can never equip or fire them.
PlayerCharacter.ALL_WEAPONS = weapons.reduce(
	(mask, w, i) => (w.disabled ? mask : mask | (1 << i)), 0)

export default PlayerCharacter
