import nengi from 'nengi'
import nengiConfig from '../common/nengiConfig'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import Identity from '../common/message/Identity'
import WeaponFired from '../common/message/WeaponFired'
import Respawned from '../common/message/Respawned'
import HitConfirmed from '../common/message/HitConfirmed'
import Killed from '../common/message/Killed'
import DamageTaken from '../common/message/DamageTaken'
import PlayerName from '../common/message/PlayerName'
import { HUMAN_NAME_SENTINEL, decodeName } from '../common/playerNames'
import followPath from './followPath'
import damagePlayer from './damagePlayer' // TODO
import niceInstanceExtension from './niceInstanceExtension'
import applyCommand, { MAX_SPEED } from '../common/applyCommand'
import setupObstacles from './setupObstacles'
import { fire } from '../common/weapon'
import { shotPattern, applyPattern } from '../common/firePattern'
import { damageFalloffMult } from '../common/damageFalloff'
import lagCompensatedHitscanCheck from './lagCompensatedHitscanCheck'
import Projectile from '../common/entity/Projectile'
import Grenade from '../common/entity/Grenade'
import MegaHealthPickup, { MEGA_STATE } from '../common/entity/MegaHealthPickup'
import { weapons } from '../common/weaponsConfig'
import { PLAYER_NAMES } from '../common/playerNames'
import BotController from './BotController'

import * as BABYLON from 'babylonjs'
//import 'babylonjs-loaders' // mutates something globally
global.XMLHttpRequest = require('xhr2').XMLHttpRequest

// Phase 3 frag-grenade tuning (locked design numbers). Server-only physics.
const GRENADE = {
	MAX_CHARGES: 2,
	RECHARGE_TIME: 12.0,   // seconds to regen one spent charge (up to MAX)
	THROW_INTERVAL: 0.6,   // min seconds between throws
	SPEED: 22,             // launch speed (m/s)
	PITCH_DEG: 15,         // degrees ABOVE the aim vector
	GRAVITY: 18,           // matches applyCommand.js GRAVITY (native player arc)
	FUSE: 1.8,             // seconds until detonation
	RESTITUTION: 0.4,      // energy kept per bounce
	RADIUS: 5.0,           // AoE radius (m)
	DMG_CENTER: 120,       // damage at the center
	DMG_EDGE: 20,          // damage at RADIUS (linear falloff to 0 beyond)
	GROUND_Y: 0            // floor plane (matches applyCommand GROUND_Y)
}

// Phase 4 MEGA-HEALTH pickup tuning (locked design numbers). Server-only.
const MEGA = {
	// arena CENTER is occupied by the reactor landmark (OBSTACLE_SPECS: x0 z0, 4x4),
	// so the pickup sits 6m north of it — open floor, still the visual "heart" of the
	// arena, verified clear of every obstacle + wall (reactor z-max=2; nearest cover
	// (-5,9)/(5,-9) both clear x=0,z=6). Tune here after a live playtest.
	X: 0,
	Y: 1.0,                // bob height — reachable/centered on a standing player's torso
	Z: 6,
	HEAL: 100,             // added on pickup
	MAX: 150,              // overheal cap: min(150, hp+HEAL)
	RADIUS: 2.2,           // pickup radius (living players only)
	RESPAWN: 60.0,         // seconds from taken -> available again
	CHARGE_LEAD: 5.0,      // seconds before respawn the CHARGING tell (rising hum) starts
	OVERHEAL_GRACE: 3.0,   // seconds after pickup before overheal starts decaying
	OVERHEAL_RATE: 2.0     // HP/sec decay while hitpoints > 100 (after the grace)
}

class GameInstance {
	static RESPAWN_DELAY_MS = 2500

	constructor() {
		const engine = new BABYLON.NullEngine()
		engine.enableOfflineSupport = false
		const scene = new BABYLON.Scene(engine)
		scene.collisionsEnabled = true
		//const camera = new BABYLON.ArcRotateCamera("Camera", 0, 0.8, 100, BABYLON.Vector3.Zero(), scene)

		this.instance = new nengi.Instance(nengiConfig, { port: 8079 })
		niceInstanceExtension(this.instance)

		// game-related state
		this.obstacles = setupObstacles(this.instance)
		this.projectiles = new Set()
		// Phase 3: thrown frag grenades (mirrors this.projectiles). Server-only
		// physics (gravity+bounce+fuse) + AoE detonation live in update().
		this.grenades = new Set()

		// Phase 4: the ONE mega-health pickup, near the arena center at bob height.
		// Present (AVAILABLE) from boot; update() runs the proximity heal + 60s respawn
		// clock and drives its networked `state` (which the client renders the tell off).
		this.megaHealth = new MegaHealthPickup(MEGA.X, MEGA.Y, MEGA.Z)
		this.megaHealth.state = MEGA_STATE.AVAILABLE
		this.instance.addEntity(this.megaHealth)
		// (the rest is just attached to client objects when they connect)

		// AI players: real PlayerCharacter entities driven by BotController through
		// the same applyCommand physics + performShot weapon authority as humans.
		// Each bot is wrapped in a client-like handle whose rawEntity and
		// smoothEntity are the SAME entity, so damagePlayer/respawnPlayer and the
		// hitscan victim resolution work identically for bots and people.
		this._nameCounter = 0
		// server-only: smooth nid -> human callsign (bots never appear here). Used to
		// replay existing human names to late joiners and cleaned up on disconnect.
		this._humanNames = new Map()
		this.bots = []
		// Default 0 = 1v1 player-vs-player (no bots). Set BOTS=N in the env to add
		// practice bots back for local testing (e.g. `BOTS=4 npm start`).
		const botCount = process.env.BOTS !== undefined ? (parseInt(process.env.BOTS, 10) || 0) : 0
		for (let i = 0; i < botCount; i++) this.addBot(i)

		// GODMODE: real players are immortal (set GODMODE=1/true). Bots still take
		// damage so you can frag them and watch death anims while wandering unkillable.
		this._godmode = process.env.GODMODE === '1' || process.env.GODMODE === 'true'
		if (this._godmode) console.log('[GODMODE] real players are immortal')

		this.instance.on('connect', ({ client, callback }) => {
			// PER player-related state, attached to clients

			// create a entity for this client
			const rawEntity = new PlayerCharacter()
			rawEntity.mesh.checkCollisions = true

			// spread spawns out — spawning everyone at the exact origin puts players
			// INSIDE each other's collision boxes, and moveWithCollisions can't escape
			// from inside a collider (you'd be frozen until the other player moves)
			const spawn = this.spawnPoint()
			rawEntity.x = spawn.x
			rawEntity.z = spawn.z

			// make the raw entity only visible to this client
			const channel = this.instance.createChannel()
			channel.subscribe(client)
			channel.addEntity(rawEntity)
			//this.instance.addEntity(rawEntity)
			client.channel = channel

			// smooth entity is visible to everyone
			const smoothEntity = new PlayerCharacter()
			smoothEntity.mesh.checkCollisions = false
			smoothEntity.x = rawEntity.x
			smoothEntity.z = rawEntity.z
			this.instance.addEntity(smoothEntity)

			// Human players are flagged with HUMAN_NAME_SENTINEL on both entities; their
			// real callsign (typed at the menu) arrives via SetNameCommand and is
			// broadcast to everyone as a PlayerName message. Bots still use the round-
			// robin PLAYER_NAMES index (see addBot). Same lockstep rule as hitpoints —
			// the victim reads raw (private channel), everyone else reads smooth.
			rawEntity.nameIndex = HUMAN_NAME_SENTINEL
			smoothEntity.nameIndex = HUMAN_NAME_SENTINEL

			// tell the client which entities it controls + where it spawned
			this.instance.message(new Identity(rawEntity.nid, smoothEntity.nid, rawEntity.x, rawEntity.z), client)

			// establish a relation between this entity and the client
			rawEntity.client = client
			client.rawEntity = rawEntity
			smoothEntity.client = client
			client.smoothEntity = smoothEntity
			client.positions = []

			// The network view is a FIXED box at the origin sized to cover the ENTIRE
			// arena (ARENA_SIZE 44) with generous margin, so nothing is ever
			// network-culled at this scale — walls, players and projectiles all stay
			// visible and their meshes never get disposed. It is deliberately NOT
			// re-centered on the player (there is no 3D view culler in nengi yet).
			client.view = {
				x: 0,
				y: 0,
				z: 0,
				halfWidth: 64,
				halfHeight: 64,
				halfDepth: 64
			}

			// accept the connection
			callback({ accepted: true, text: 'Welcome!' })

			// replay existing human players' names to the new joiner so their nametags
			// resolve immediately (their SetNameCommand fired before this client existed)
			this._humanNames.forEach((name, nid) => {
				this.instance.message(new PlayerName(nid, name), client)
			})
		})

		this.instance.on('disconnect', client => {
			// clean up per client state.
			// NOTE: a socket can connect and drop *before* completing nengi's handshake
			// (never reaching the 'connect' handler that assigns these), so everything
			// here may be undefined. Guard each cleanup — an unguarded throw in this
			// handler would take down the whole server on any half-open connection.
			if (client.rawEntity) {
				client.rawEntity.mesh.dispose()
				this.instance.removeEntity(client.rawEntity)
			}
			if (client.smoothEntity) {
				this._humanNames.delete(client.smoothEntity.nid)
				client.smoothEntity.mesh.dispose()
				this.instance.removeEntity(client.smoothEntity)
			}
			if (client.channel) {
				client.channel.destroy()
			}
		})

		this.instance.on('command::MoveCommand', ({ command, client, tick }) => {
			// move this client's entity
			const entity = client.rawEntity

			applyCommand(entity, command, this.obstacles)

			// Phase 3: frag-grenade throw. The client edge-triggers throwInput (rising
			// edge only), but we also gate server-side on charges + cooldown so a
			// spoofed always-true throwInput can't dump grenades. Uses the aim vector
			// carried in the command (same ray applyCommand looks along).
			if (command.throwInput) {
				this.throwGrenade(client, command)
			}

			client.positions.push({
				x: entity.x,
				y: entity.y,
				z: entity.z,
				rotation: entity.rotation
			})
		})

		this.instance.on('command::SwitchWeaponCommand', ({ command, client, tick }) => {
			const entity = client.rawEntity
			if (entity && command.index !== undefined && command.index >= 0 && command.index < weapons.length) {
				// swap commitment: start the equip lock when the index actually changes,
				// matching the client's switchWeapon() + applyCommand so fire() gates in
				// lockstep. (This handler sets currentWeaponIndex directly, so the next
				// MoveCommand's applyCommand won't see a change — set it here too.)
				if (command.index !== entity.currentWeaponIndex) {
					entity.equipTimer = (weapons[command.index] && weapons[command.index].drawTime) || 0
				}
				entity.currentWeaponIndex = command.index
				// mirror to the smooth entity — remote clients read THAT one (same
				// lockstep rule as hitpoints in damagePlayer); without this everyone
				// appears to hold weapon 0 forever
				if (client.smoothEntity) client.smoothEntity.currentWeaponIndex = command.index
			}
		})

		this.instance.on('command::DevUpdateWeaponConfigCommand', ({ command, client, tick }) => {
			// weapon config is global + authoritative — only honor this in local dev
			if (process.env.ALLOW_DEV_TOOLS !== '1') return
			if (command.index !== undefined && command.index >= 0 && command.index < weapons.length) {
				const w = weapons[command.index]
				w.type = command.type === 0 ? 'hitscan' : 'projectile'
				w.fireCooldown = command.fireCooldown
				w.reloadTime = command.reloadTime
				w.magazineCapacity = command.magazineCapacity
				w.maxReserveAmmo = command.maxReserveAmmo
				w.damage = command.damage
				w.range = command.range
				w.projectileSpeed = command.projectileSpeed
				console.log(`[DEV] Authoritative weapon config updated at runtime for index ${command.index} (${w.name}):`, w)

				// Adjust the client's player entity weaponsState limits immediately
				const entity = client.rawEntity
				if (entity && entity.weaponsState && entity.weaponsState[command.index]) {
					const state = entity.weaponsState[command.index]
					if (state.magazineAmmo > w.magazineCapacity) {
						state.magazineAmmo = w.magazineCapacity
					}
					if (state.reserveAmmo > w.maxReserveAmmo) {
						state.reserveAmmo = w.maxReserveAmmo
					}
				}
			}
		})

		this.instance.on('command::FireCommand', ({ command, client, tick }) => {
			// shoot from the perspective of this client's entity
			this.performShot(client)
		})

		this.instance.on('command::SetNameCommand', ({ command, client }) => {
			// a human's chosen callsign: keyed by smooth nid (the shared identity),
			// stored server-side for late-joiner replay, and broadcast to everyone.
			if (!client.smoothEntity) return
			const name = decodeName(command)
			const nid = client.smoothEntity.nid
			this._humanNames.set(nid, name)
			this.instance.messageAll(new PlayerName(nid, name))
		})
	}

	// Fire the shooter's current weapon and resolve its effects. `shooter` is a
	// client OR a bot handle — anything with rawEntity/smoothEntity (bots point
	// both at the same entity) and optionally latency. Shared by the FireCommand
	// handler and the bot AI so both go through identical weapon authority.
	performShot(shooter) {
		const entity = shooter.rawEntity
		const smoothEntity = shooter.smoothEntity

		const ray = fire(entity)
		if (!ray) return
		const config = ray.config
		const timeAgo = (shooter.latency || 0) + 100

		if (config.type === 'hitscan') {
			// Deterministic per-weapon spread (common/firePattern.js): the SAME
			// seeded pattern the firing client predicted (seed derives from
			// nid/weapon/ammo on both sides), so the wall marks a player painted
			// are the rays that judged damage. One entry for single-bullet
			// weapons, a rosette for the shotgun.
			const offsets = shotPattern(config, ray.seed, ray.heat, ray.aimFactor)
			offsets.forEach(off => {
				const d = applyPattern(ray.direction, off)
				const pelletRay = new BABYLON.Ray(ray.origin, new BABYLON.Vector3(d.x, d.y, d.z))
				const hits = lagCompensatedHitscanCheck(this.instance, pelletRay, timeAgo)
				// a single pellet ray can intersect BOTH of a victim's entities
				// (raw + smooth are the same player at slightly different
				// lag-compensated spots) — dedupe per pellet so one pellet is
				// one hit, applied once to the player's canonical state
				const damagedThisPellet = new Set()
				hits.forEach(victim => {
					if (victim.nid !== entity.nid && victim.nid !== smoothEntity.nid) {
						if (victim instanceof PlayerCharacter && victim.isAlive &&
							victim.client && !damagedThisPellet.has(victim.client)) {
							damagedThisPellet.add(victim.client)
							// Distance-based damage falloff (common/damageFalloff.js): opt-in
							// per weapon, flat for weapons without a falloff window. Distance is
							// shooter (ray.origin) -> victim position; ADS (ray.aimFactor, the
							// ramp this shot fired with) extends the pistol's full-damage range.
							const dist = BABYLON.Vector3.Distance(ray.origin, victim.mesh.position)
							const dmg = Math.round(config.damage * damageFalloffMult(config, dist, ray.aimFactor))
							this.damagePlayer(victim.client, shooter, dmg, config.name, config.index)
						}
					}
				})
			})

			// Send WeaponFired to observers with the weapon identity + spread
			// inputs so they render the exact same pattern + per-weapon FX
			this.instance.addLocalMessage(new WeaponFired(
				smoothEntity.nid,
				smoothEntity.x,
				smoothEntity.y,
				smoothEntity.z,
				ray.direction.x,
				ray.direction.y,
				ray.direction.z,
				config.index,
				ray.seed,
				ray.heat,
				ray.aimFactor
			))
		} else if (config.type === 'projectile') {
			// Projectile weapon. Flak (config.pellets > 1) fires a cone burst of
			// shrapnel; Plasma (no pellets) fires one bolt. Each pellet is its own
			// Projectile entity carrying the shrapnel bounce budget + slow debuff.
			const pellets = (config.pellets && config.pellets > 1) ? config.pellets : 1
			for (let i = 0; i < pellets; i++) {
				// jitter each pellet within a cone of half-angle ~spreadBase around the
				// aim vector (single-pellet weapons keep the exact aim). Uses the shared
				// applyPattern basis math; Math.random is acceptable here — projectiles
				// are server-authoritative and NOT part of the reconciled client sim.
				let d = ray.direction
				if (pellets > 1) {
					const spread = config.spreadBase || 0.03
					const off = { dx: (Math.random() - 0.5) * 2 * spread, dy: (Math.random() - 0.5) * 2 * spread }
					d = applyPattern({ x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }, off)
				}
				const proj = new Projectile(ray.origin.x, ray.origin.y, ray.origin.z)
				proj.dirX = d.x
				proj.dirY = d.y
				proj.dirZ = d.z
				// ADS speeds the bolt (aimFactor 0..1 * the weapon's projSpeedMult) so
				// aimed shots need less lead at range (Hale). Non-ADS weapons unaffected.
				const _af = Math.min(1, Math.max(0, ray.aimFactor || 0))
				const _psm = (config.ads && config.ads.projSpeedMult) ? (1 + (config.ads.projSpeedMult - 1) * _af) : 1
				proj.speed = (config.projectileSpeed || 30) * _psm
				// ADS also THINS the bolt (aimFactor 0..1 * the weapon's projSizeMult):
				// aimed = a smaller collision radius (a precise dart) vs the fat hip ball.
				// hip (aimFactor 0) keeps the full default radius; non-ADS weapons unaffected.
				const _pzm = (config.ads && config.ads.projSizeMult) ? (1 + (config.ads.projSizeMult - 1) * _af) : 1
				proj.radius = proj.radius * _pzm
				proj.damage = config.damage || 25
				proj.ownerNid = entity.nid
				proj.weaponIndex = config.index
				proj.bounceRemaining = config.bounceCount || 0
				proj.slowFactor = config.slowFactor || 0
				proj.slowDuration = config.slowDuration || 0
				proj.velocity = new BABYLON.Vector3(d.x, d.y, d.z).scale(proj.speed)
				proj.lifeTime = 3.0 // 3 seconds max lifetime

				this.instance.addEntity(proj)
				this.projectiles.add(proj)
			}
		}
	}

	// Phase 3: spawn a thrown frag grenade for `shooter` (a client OR bot handle).
	// Gated on charges + throwCooldown so it fires only on a real, allowed throw.
	// Launch is from the eye/aim position along the aim vector, pitched 15° up.
	throwGrenade(shooter, command) {
		const entity = shooter.rawEntity
		if (!entity || !entity.isAlive) return
		if (entity.throwCooldown > 0) return
		if (entity.grenadeCharges <= 0) return

		// spend a charge + start the min-interval lock. Mirror the count to the
		// smooth entity so any smooth-reading HUD stays in lockstep (the HUD reads
		// the client's own raw entity, but keep them consistent like hitpoints).
		entity.grenadeCharges -= 1
		entity.throwCooldown = GRENADE.THROW_INTERVAL
		if (shooter.smoothEntity) shooter.smoothEntity.grenadeCharges = entity.grenadeCharges

		// aim vector from the command (already normalized-ish camera forward)
		let ax = command.camRayX, ay = command.camRayY, az = command.camRayZ
		const aLen = Math.hypot(ax, ay, az) || 1
		ax /= aLen; ay /= aLen; az /= aLen

		// pitch the launch 15° ABOVE the aim vector: rotate the aim about the
		// horizontal axis perpendicular to it (i.e. add upward tilt). Cheap approach:
		// blend in +Y then renormalize, scaled so the resulting angle rises ~15°.
		const pitch = (GRENADE.PITCH_DEG * Math.PI) / 180
		// horizontal component of the aim (for building the tilt)
		const hLen = Math.hypot(ax, az) || 0.0001
		// new direction: keep heading, raise elevation by `pitch`
		const curElev = Math.asin(Math.max(-1, Math.min(1, ay)))
		const newElev = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, curElev + pitch))
		const cosE = Math.cos(newElev)
		const dx = (ax / hLen) * cosE
		const dz = (az / hLen) * cosE
		const dy = Math.sin(newElev)

		// launch position: the player's eye (roughly head height above the entity)
		const eyeY = entity.y + 0.6
		const grenade = new Grenade(entity.x + dx * 0.5, eyeY + dy * 0.5, entity.z + dz * 0.5)
		grenade.velocity = new BABYLON.Vector3(dx, dy, dz).scale(GRENADE.SPEED)
		grenade.ownerNid = entity.nid
		grenade.fuse = GRENADE.FUSE
		grenade.restitution = GRENADE.RESTITUTION

		this.instance.addEntity(grenade)
		this.grenades.add(grenade)
	}

	// Phase 3: AoE detonation. Damages every living player within RADIUS (including
	// the thrower — self-damage is intentional) with LINEAR falloff from DMG_CENTER
	// at 0m to DMG_EDGE at RADIUS, 0 beyond. Attributes damage to the thrower so
	// frags credit correctly. Routes through damagePlayer so kills/messages/feedback
	// fire, applying to raw+smooth in lockstep. Removing the entity triggers the
	// client explosion FX (Grenade factory delete → renderer.grenadeExplosion).
	detonateGrenade(grenade) {
		const gx = grenade.x, gy = grenade.y, gz = grenade.z

		// resolve the thrower handle (client or bot) from ownerNid
		let attacker = null
		this.instance.clients.forEach(ac => {
			if (ac.rawEntity && ac.rawEntity.nid === grenade.ownerNid) attacker = ac
		})
		if (!attacker) attacker = this.bots.find(b => b.rawEntity.nid === grenade.ownerNid) || null

		// every candidate victim (humans + bots), each hit at most once
		const targets = []
		this.instance.clients.forEach(c => targets.push(c))
		targets.push(...this.bots)

		targets.forEach(c => {
			const v = c.rawEntity
			if (!v || !v.isAlive) return
			const dx = v.x - gx, dy = v.y - gy, dz = v.z - gz
			const dist = Math.hypot(dx, dy, dz)
			if (dist >= GRENADE.RADIUS) return
			// linear falloff: t=0 at center → DMG_CENTER, t=1 at edge → DMG_EDGE
			const t = dist / GRENADE.RADIUS
			const dmg = Math.round(GRENADE.DMG_CENTER + (GRENADE.DMG_EDGE - GRENADE.DMG_CENTER) * t)
			if (dmg <= 0) return
			this.damagePlayer(c, attacker, dmg, 'grenade', 0)
		})

		// remove the grenade — its factory.delete on each client fires the blast FX
		this.instance.removeEntity(grenade)
		if (grenade.mesh && grenade.mesh.dispose) grenade.mesh.dispose()
		this.grenades.delete(grenade)
	}

	// Phase 4: drive the mega-health pickup each tick. When AVAILABLE, proximity-check
	// every living player (humans + bots) within RADIUS → heal to min(MAX, hp+HEAL),
	// arm their overheal grace timer, then take it (state→HIDDEN, respawnAt = now+60s).
	// While taken, flip to CHARGING in the last CHARGE_LEAD seconds (drives the client's
	// rising-hum tell + scale-in), then back to AVAILABLE at respawnAt. Heal is applied
	// to raw+smooth in lockstep (same rule as damagePlayer). `now` is wall-clock ms.
	updateMegaHealth(now) {
		const mh = this.megaHealth
		if (!mh) return

		if (mh.state === MEGA_STATE.AVAILABLE) {
			// every candidate grabber (humans + bots)
			const targets = []
			this.instance.clients.forEach(c => targets.push(c))
			targets.push(...this.bots)
			for (const c of targets) {
				const raw = c.rawEntity
				const smooth = c.smoothEntity
				if (!raw || !raw.isAlive) continue
				const dx = raw.x - mh.x, dy = raw.y - mh.y, dz = raw.z - mh.z
				if (Math.hypot(dx, dy, dz) > MEGA.RADIUS) continue

				// GRAB (first-come, no ownership). Heal to the overheal cap; arm the grace
				// timer so the >100 portion holds for OVERHEAL_GRACE before decaying.
				const hp = Math.min(MEGA.MAX, raw.hitpoints + MEGA.HEAL)
				raw.hitpoints = hp
				if (smooth) smooth.hitpoints = hp
				raw.overhealDecayTimer = MEGA.OVERHEAL_GRACE
				if (smooth) smooth.overhealDecayTimer = MEGA.OVERHEAL_GRACE

				// take it: hide + start the respawn clock. The AVAILABLE→HIDDEN transition
				// is what the client reacts to (pickup chime + hum stop).
				mh.state = MEGA_STATE.HIDDEN
				mh.respawnAt = now + MEGA.RESPAWN * 1000
				console.log(`Player ${raw.nid} grabbed MEGA-HEALTH → HP ${hp}`)
				break
			}
			return
		}

		// taken: run the respawn clock. CHARGING in the final CHARGE_LEAD seconds so the
		// client can time the grab (rising hum + scale/fade-in), then AVAILABLE.
		if (now >= mh.respawnAt) {
			mh.state = MEGA_STATE.AVAILABLE
		} else if (now >= mh.respawnAt - MEGA.CHARGE_LEAD * 1000) {
			if (mh.state !== MEGA_STATE.CHARGING) mh.state = MEGA_STATE.CHARGING
		}
	}

	// Phase 4: decay each player's overheal (hitpoints > 100) at OVERHEAL_RATE/sec,
	// but only after the per-player grace timer expires. Never touches base health
	// (floors at 100). Server-authoritative + applied to raw+smooth in lockstep like
	// damagePlayer — deliberately OUTSIDE the reconciled applyCommand path (hitpoints
	// isn't client-predicted, so this can't perturb prediction). Fractional decay is
	// accumulated on the raw entity's float hitpoints and floored to the wire UInt8.
	updateOverhealDecay(delta) {
		const decay = (raw, smooth) => {
			if (!raw || !raw.isAlive) return
			if (raw.hitpoints <= 100) { raw.overhealDecayTimer = 0; return }
			if (raw.overhealDecayTimer > 0) {
				raw.overhealDecayTimer -= delta
				if (raw.overhealDecayTimer < 0) raw.overhealDecayTimer = 0
				return
			}
			const hp = Math.max(100, raw.hitpoints - MEGA.OVERHEAL_RATE * delta)
			raw.hitpoints = hp
			if (smooth) smooth.hitpoints = hp
		}
		this.instance.clients.forEach(c => decay(c.rawEntity, c.smoothEntity))
		this.bots.forEach(b => decay(b.rawEntity, b.smoothEntity))
	}

	addBot(index) {
		const entity = new PlayerCharacter()
		entity.mesh.checkCollisions = true
		const spawn = this.spawnPoint()
		entity.x = spawn.x
		entity.z = spawn.z
		// spread the loadouts: rifle / smg / shotgun / pistol
		entity.currentWeaponIndex = index % weapons.length
		entity.nameIndex = this._nameCounter++ % PLAYER_NAMES.length
		this.instance.addEntity(entity)

		const handle = { bot: true, rawEntity: entity, smoothEntity: entity, respawnAt: null }
		handle.controller = new BotController(entity, entity.currentWeaponIndex)
		entity.client = handle // hitscan victims resolve to their owner via .client
		this.bots.push(handle)
		console.log(`Bot ${entity.nid} joined with ${weapons[entity.currentWeaponIndex].name}`)
	}

	// every living entity `except` could fight: human raw entities + bots
	combatants(except) {
		const out = []
		this.instance.clients.forEach(client => {
			const e = client.rawEntity
			if (e && e.isAlive && e !== except) out.push(e)
		})
		this.bots.forEach(bot => {
			if (bot.rawEntity.isAlive && bot.rawEntity !== except) out.push(bot.rawEntity)
		})
		return out
	}

	// a fresh spawn location: spread out from the origin so players never spawn
	// inside each other's collision boxes (moveWithCollisions can't escape from
	// inside a collider), and clear of the obstacle ring
	spawnPoint() {
		const angle = Math.random() * Math.PI * 2
		const radius = 3 + Math.random() * 5
		return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }
	}

	// Canonical damage: a player's authoritative hitpoints live on the CLIENT's
	// pair of entities and must move in lockstep — the victim reads their own
	// rawEntity (private channel), everyone else reads the smoothEntity. Applying
	// damage to whichever entity a ray happened to hit desyncs the two views.
	damagePlayer(victimClient, attackerClient, damage, sourceName, weaponIndex) {
		const raw = victimClient.rawEntity
		const smooth = victimClient.smoothEntity
		if (!raw || !raw.isAlive) return
		// GODMODE: real players take no damage (bots still do — go frag them)
		if (this._godmode && !victimClient.bot) return

		// hp BEFORE this hit — overkill is damage beyond what the kill needed
		const hpBefore = raw.hitpoints
		const hp = Math.max(0, hpBefore - damage)
		raw.hitpoints = hp
		smooth.hitpoints = hp
		const wasKill = hp <= 0
		console.log(`Player ${raw.nid} hit by ${sourceName}! HP: ${hp}`)

		// combat events use SMOOTH nids — the canonical identity every client shares
		// (each client learns its own raw+smooth pair via Identity; bots share one
		// entity). attackerClient may be null or a socketless bot handle.
		const victimNid = smooth.nid
		const isRealAttacker = attackerClient && !attackerClient.bot && attackerClient.smoothEntity
		const attackerNid = attackerClient && attackerClient.smoothEntity ? attackerClient.smoothEntity.nid : victimNid

		// DamageTaken → the victim only (skip bots: no socket). directionYaw points
		// from the victim toward the attacker so the client can draw a directional arc.
		if (!victimClient.bot) {
			let dirYaw = 0
			if (attackerClient && attackerClient.smoothEntity) {
				const src = attackerClient.smoothEntity
				dirYaw = Math.atan2(src.x - smooth.x, src.z - smooth.z)
			}
			this.instance.message(new DamageTaken(attackerNid, Math.min(255, damage), dirYaw), victimClient)
		}

		// HitConfirmed → the attacker only (real clients; bots have no socket)
		if (isRealAttacker) {
			this.instance.message(new HitConfirmed(victimNid, Math.min(255, damage), wasKill), attackerClient)
		}

		if (wasKill) {
			raw.isAlive = false
			smooth.isAlive = false
			// freeze the corpse where it dropped (applyCommand ignores dead players
			// on both sides, so client prediction stays in sync through death)
			raw.velX = 0; raw.velY = 0; raw.velZ = 0
			raw.deaths = Math.min(255, raw.deaths + 1)
			smooth.deaths = raw.deaths
			victimClient.respawnAt = Date.now() + GameInstance.RESPAWN_DELAY_MS
			if (attackerClient && attackerClient.rawEntity) {
				const ak = Math.min(255, attackerClient.rawEntity.kills + 1)
				attackerClient.rawEntity.kills = ak
				attackerClient.smoothEntity.kills = ak
			}

			// Killed → broadcast to EVERYONE via instance.messageAll. (addLocalMessage
			// is NOT usable here: nengi local events are spatially culled and REQUIRE
			// x/y in their schema — Killed carries none — and they decode through the
			// localMessages protocol map, not `messages`, so an addLocalMessage(Killed)
			// silently never reaches any client. messageAll uses the same per-client
			// message path HitConfirmed/DamageTaken already work through, delivered to
			// every connected socket.) overkill = damage past what the kill needed. If
			// there's no attacker, killerNid = victimNid (suicide-style, unattributed).
			const overkill = Math.min(255, Math.max(0, damage - hpBefore))
			this.instance.messageAll(new Killed(attackerNid, victimNid, weaponIndex || 0, overkill))

			console.log(`Player ${raw.nid} died from ${sourceName}!`)
		}
	}

	// UT99-style respawn: full health, fresh ammo for every weapon (same weapon
	// still equipped), at a new spawn point. The client learns the teleport via
	// reconciliation (its dead entity predicted staying put, the server says
	// spawn point → snap) and mirrors the ammo reset when it observes its own
	// isAlive flip back to true (Simulator._updateHud).
	respawnPlayer(client) {
		const spawn = this.spawnPoint()
		for (const entity of [client.rawEntity, client.smoothEntity]) {
			if (!entity) continue
			entity.x = spawn.x
			entity.y = 0
			entity.z = spawn.z
			entity.hitpoints = 100
			entity.isAlive = true
			entity.velX = 0; entity.velY = 0; entity.velZ = 0
			// Phase 4: clear any pending overheal decay so a respawn is a clean 100
			entity.overhealDecayTimer = 0
			// Phase 3: refresh grenades to full on respawn (mirrors the ammo reset)
			entity.grenadeCharges = GRENADE.MAX_CHARGES
			entity.throwCooldown = 0
			entity.rechargeAccum = 0
			entity.weaponsState.forEach((state, i) => {
				state.magazineAmmo = weapons[i].magazineCapacity
				state.reserveAmmo = weapons[i].maxReserveAmmo
				state.cooldownTimer = 0
				state.onCooldown = false
				state.reloading = false
				state.reloadTimer = 0
				state.heat = 0
			})
		}
		// the client ignores server x/y/z for its own entity (it predicts them),
		// so hand the teleport over explicitly — same contract as Identity's spawn.
		// Bots have no socket to message; the server-side teleport IS their move.
		if (!client.bot) this.instance.message(new Respawned(spawn.x, spawn.z), client)
		console.log(`${client.bot ? 'Bot' : 'Player'} ${client.rawEntity.nid} respawned at (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`)
	}

	update(delta, tick, now) {
		this.instance.emitCommands()

		// respawn any players whose death timer has run out
		const wallNow = Date.now()
		this.instance.clients.forEach(client => {
			if (client.respawnAt && wallNow >= client.respawnAt) {
				client.respawnAt = null
				this.respawnPlayer(client)
			}
		})

		// drive the bots: respawn, think, move, shoot — all through the same
		// code paths a human's commands take
		this.bots.forEach(bot => {
			if (bot.respawnAt && wallNow >= bot.respawnAt) {
				bot.respawnAt = null
				this.respawnPlayer(bot)
			}
			const entity = bot.rawEntity
			if (!entity.isAlive) return
			const command = bot.controller.think(delta, wallNow, this.combatants(entity), this.obstacles)
			applyCommand(entity, command, this.obstacles)
			// only attempt the shot when the weapon can actually fire — fire()
			// would reject it anyway, but noisily (WEAPON_FIRE_FAIL log per tick)
			const state = entity.weaponsState[entity.currentWeaponIndex]
			if (command.fireInput && !state.onCooldown && !state.reloading && state.magazineAmmo > 0) {
				this.performShot(bot)
			}
		})

		// Update all active projectiles
		this.projectiles.forEach(proj => {
			proj.x += proj.velocity.x * delta
			proj.y += proj.velocity.y * delta
			proj.z += proj.velocity.z * delta
			proj.lifeTime -= delta

			// Check if out of lifetime
			if (proj.lifeTime <= 0) {
				this.instance.removeEntity(proj)
				if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
				this.projectiles.delete(proj)
				return
			}

			let hitOccurred = false

			// Check collisions with players (humans and bots alike)
			const projectileTargets = []
			this.instance.clients.forEach(c => projectileTargets.push(c))
			projectileTargets.push(...this.bots)
			projectileTargets.forEach(c => {
				if (hitOccurred) return
				const target = c.rawEntity
				if (target && target.isAlive && target.nid !== proj.ownerNid) {
					const dx = target.x - proj.x
					const dy = target.y - proj.y
					const dz = target.z - proj.z
					const dist = Math.hypot(dx, dy, dz)

					// Collision cylinder check (height 1m, radius = proj.radius, default
					// 0.75m; aimed Plasma bolts spawn with a smaller radius — see spawn).
					if (dist < proj.radius && Math.abs(dy) < 1.0) {
						let attacker = null
						this.instance.clients.forEach(ac => {
							if (ac.rawEntity && ac.rawEntity.nid === proj.ownerNid) attacker = ac
						})
						if (!attacker) attacker = this.bots.find(b => b.rawEntity.nid === proj.ownerNid) || null
						this.damagePlayer(c, attacker, proj.damage, 'projectile', proj.weaponIndex)

						// Plasma slow-on-hit: refresh (don't stack) the debuff on the
						// victim. Set on BOTH raw+smooth in lockstep — same rule as
						// damagePlayer's hp sync (the victim reads raw, everyone smooth).
						if (proj.slowFactor > 0 && c.rawEntity && c.rawEntity.isAlive) {
							c.rawEntity.slowTimer = proj.slowDuration
							c.rawEntity.slowFactor = proj.slowFactor
							if (c.smoothEntity) {
								c.smoothEntity.slowTimer = proj.slowDuration
								c.smoothEntity.slowFactor = proj.slowFactor
							}
						}

						this.instance.removeEntity(proj)
						if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
						this.projectiles.delete(proj)
						hitOccurred = true
					}
				}
			})

			if (hitOccurred) return

			// Check collisions with obstacles
			for (const obstacle of this.obstacles.values()) {
				const dx = obstacle.x - proj.x
				const dy = obstacle.y - proj.y
				const dz = obstacle.z - proj.z
				const dist = Math.hypot(dx, dy, dz)

				// Obstacle is 3x3x3 size box, so bounding radius is ~2.0
				if (dist < 2.0) {
					// Flak shrapnel with bounces left: reflect off the struck face
					// instead of dying. Obstacles are axis-aligned; pick the axis the
					// bolt is travelling toward the box center along most strongly
					// (cheap, robust — this is shrapnel, not a physics showcase) and
					// negate that velocity + dir component.
					if (proj.bounceRemaining > 0) {
						const vx = proj.velocity.x, vy = proj.velocity.y, vz = proj.velocity.z
						// component of the box-center direction the bolt is closing on
						const ax = Math.abs(dx) * (vx * dx > 0 ? 1 : 0)
						const ay = Math.abs(dy) * (vy * dy > 0 ? 1 : 0)
						const az = Math.abs(dz) * (vz * dz > 0 ? 1 : 0)
						if (ax >= ay && ax >= az && ax > 0) {
							proj.velocity.x = -vx; proj.dirX = -proj.dirX
						} else if (ay >= ax && ay >= az && ay > 0) {
							proj.velocity.y = -vy; proj.dirY = -proj.dirY
						} else if (az > 0) {
							proj.velocity.z = -vz; proj.dirZ = -proj.dirZ
						} else {
							// fallback: reflect the dominant travel axis
							const mx = Math.abs(vx), my = Math.abs(vy), mz = Math.abs(vz)
							if (mx >= my && mx >= mz) { proj.velocity.x = -vx; proj.dirX = -proj.dirX }
							else if (my >= mz) { proj.velocity.y = -vy; proj.dirY = -proj.dirY }
							else { proj.velocity.z = -vz; proj.dirZ = -proj.dirZ }
						}
						proj.bounceRemaining -= 1
						// nudge out of the box along the new velocity so we don't
						// re-collide with the same obstacle next frame
						proj.x += proj.velocity.x * delta
						proj.y += proj.velocity.y * delta
						proj.z += proj.velocity.z * delta
						break
					}
					this.instance.removeEntity(proj)
					if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
					this.projectiles.delete(proj)
					break
				}
			}
		})

		// Phase 3: update thrown frag grenades — gravity + velocity integration,
		// bounce off floor/obstacles with restitution, fuse countdown → AoE detonation.
		// Cheap server-only physics (no client prediction). Snapshot to an array first
		// so detonateGrenade can safely mutate this.grenades mid-iteration.
		this.grenades.forEach(g => {
			// gravity + integrate
			g.velocity.y -= GRENADE.GRAVITY * delta
			g.x += g.velocity.x * delta
			g.y += g.velocity.y * delta
			g.z += g.velocity.z * delta

			// floor bounce: reflect Y with restitution + damp horizontal a touch so it
			// settles instead of skating forever
			if (g.y <= GRENADE.GROUND_Y) {
				g.y = GRENADE.GROUND_Y
				if (g.velocity.y < 0) {
					g.velocity.y = -g.velocity.y * g.restitution
					g.velocity.x *= 0.8
					g.velocity.z *= 0.8
					// kill tiny residual bounces so it comes to rest-ish
					if (g.velocity.y < 0.6) g.velocity.y = 0
				}
			}

			// obstacle bounce (reuse the projectile's axis-aligned box test). Reflect
			// the closing axis with restitution rather than removing the grenade.
			for (const obstacle of this.obstacles.values()) {
				const ox = obstacle.x - g.x
				const oy = obstacle.y - g.y
				const oz = obstacle.z - g.z
				const dist = Math.hypot(ox, oy, oz)
				if (dist < 2.0) {
					const vx = g.velocity.x, vy = g.velocity.y, vz = g.velocity.z
					const ax = Math.abs(ox) * (vx * ox > 0 ? 1 : 0)
					const ay = Math.abs(oy) * (vy * oy > 0 ? 1 : 0)
					const az = Math.abs(oz) * (vz * oz > 0 ? 1 : 0)
					if (ax >= ay && ax >= az && ax > 0) { g.velocity.x = -vx * g.restitution }
					else if (ay >= ax && ay >= az && ay > 0) { g.velocity.y = -vy * g.restitution }
					else if (az > 0) { g.velocity.z = -vz * g.restitution }
					else {
						const mx = Math.abs(vx), my = Math.abs(vy), mz = Math.abs(vz)
						if (mx >= my && mx >= mz) g.velocity.x = -vx * g.restitution
						else if (my >= mz) g.velocity.y = -vy * g.restitution
						else g.velocity.z = -vz * g.restitution
					}
					// nudge out along the new velocity so we don't re-collide next tick
					g.x += g.velocity.x * delta
					g.y += g.velocity.y * delta
					g.z += g.velocity.z * delta
					break
				}
			}

			// fuse: detonate regardless of bounces
			g.fuse -= delta
			if (g.fuse <= 0) {
				this.detonateGrenade(g)
			}
		})

		// Phase 3: tick each combatant's throw cooldown + grenade recharge. Recharge
		// accrues 1 charge per RECHARGE_TIME up to MAX_CHARGES (independent of the
		// min-interval throwCooldown). Applied to both the raw + smooth entity so the
		// networked grenadeCharges stays in lockstep for the HUD.
		const tickGrenades = (raw, smooth) => {
			if (!raw) return
			if (raw.throwCooldown > 0) {
				raw.throwCooldown -= delta
				if (raw.throwCooldown < 0) raw.throwCooldown = 0
			}
			if (raw.grenadeCharges < GRENADE.MAX_CHARGES) {
				raw.rechargeAccum += delta
				if (raw.rechargeAccum >= GRENADE.RECHARGE_TIME) {
					raw.rechargeAccum -= GRENADE.RECHARGE_TIME
					raw.grenadeCharges += 1
					if (smooth) smooth.grenadeCharges = raw.grenadeCharges
				}
			} else {
				raw.rechargeAccum = 0
			}
		}
		this.instance.clients.forEach(client => tickGrenades(client.rawEntity, client.smoothEntity))
		this.bots.forEach(bot => tickGrenades(bot.rawEntity, bot.smoothEntity))

		// Phase 4: mega-health pickup (proximity heal + 60s respawn clock) and the
		// per-player overheal decay. Server-authoritative, outside client prediction.
		this.updateMegaHealth(wallNow)
		this.updateOverhealDecay(delta)

		// for each player ...
		this.instance.clients.forEach(client => {
			const { rawEntity, smoothEntity } = client

			// the network view is a fixed full-arena box (set on connect) and is
			// intentionally never re-centered — nothing is culled at this scale

			// smooth entity will follow raw entity's path at *up to* 110% of the
			// fastest legit movement (dodge speed) — falls can briefly exceed this
			// and catch up on landing
			const movementBudget = MAX_SPEED * 1.1 * delta
			followPath(smoothEntity, client.positions, movementBudget)
			smoothEntity.rotationX = rawEntity.rotationX
			smoothEntity.rotationY = rawEntity.rotationY
		})

		// TECHNICALLY we should call scene.render(), but as this game is so simple and
		// computeWorldMatrix is called on every object after it is moved, i skipped it.
		// that's all scene.render() was going to do for us

		// when instance.updates, nengi sends out snapshots to every client
		this.instance.update()
	}
}

export default GameInstance
