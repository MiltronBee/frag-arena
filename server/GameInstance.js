import nengi from 'nengi'
import nengiConfig from '../common/nengiConfig'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import Identity from '../common/message/Identity'
import WeaponFired from '../common/message/WeaponFired'
import Respawned from '../common/message/Respawned'
import HitConfirmed from '../common/message/HitConfirmed'
import Killed from '../common/message/Killed'
import DamageTaken from '../common/message/DamageTaken'
import followPath from './followPath'
import damagePlayer from './damagePlayer' // TODO
import niceInstanceExtension from './niceInstanceExtension'
import applyCommand, { MAX_SPEED } from '../common/applyCommand'
import setupObstacles from './setupObstacles'
import { fire } from '../common/weapon'
import { shotPattern, applyPattern } from '../common/firePattern'
import lagCompensatedHitscanCheck from './lagCompensatedHitscanCheck'
import Projectile from '../common/entity/Projectile'
import { weapons } from '../common/weaponsConfig'
import BotController from './BotController'

import * as BABYLON from 'babylonjs'
//import 'babylonjs-loaders' // mutates something globally
global.XMLHttpRequest = require('xhr2').XMLHttpRequest

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
		// (the rest is just attached to client objects when they connect)

		// AI players: real PlayerCharacter entities driven by BotController through
		// the same applyCommand physics + performShot weapon authority as humans.
		// Each bot is wrapped in a client-like handle whose rawEntity and
		// smoothEntity are the SAME entity, so damagePlayer/respawnPlayer and the
		// hitscan victim resolution work identically for bots and people.
		this.bots = []
		const botCount = process.env.BOTS !== undefined ? (parseInt(process.env.BOTS, 10) || 0) : 4
		for (let i = 0; i < botCount; i++) this.addBot(i)

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
			const offsets = shotPattern(config, ray.seed, ray.heat)
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
							this.damagePlayer(victim.client, shooter, config.damage, config.name, config.index)
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
				ray.heat
			))
		} else if (config.type === 'projectile') {
			// Projectile weapon: Spawn a Projectile entity
			const proj = new Projectile(ray.origin.x, ray.origin.y, ray.origin.z)
			proj.dirX = ray.direction.x
			proj.dirY = ray.direction.y
			proj.dirZ = ray.direction.z
			proj.speed = config.projectileSpeed || 30
			proj.damage = config.damage || 25
			proj.ownerNid = entity.nid
			proj.weaponIndex = config.index
			proj.velocity = ray.direction.scale(proj.speed)
			proj.lifeTime = 3.0 // 3 seconds max lifetime

			this.instance.addEntity(proj)
			this.projectiles.add(proj)
			console.log(`Spawned projectile ${proj.nid} from player ${entity.nid}`)
		}
	}

	addBot(index) {
		const entity = new PlayerCharacter()
		entity.mesh.checkCollisions = true
		const spawn = this.spawnPoint()
		entity.x = spawn.x
		entity.z = spawn.z
		// spread the loadouts: rifle / smg / shotgun / pistol
		entity.currentWeaponIndex = index % weapons.length
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

					// Collision cylinder check (height 1m, radius 0.75m)
					if (dist < 0.75 && Math.abs(dy) < 1.0) {
						let attacker = null
						this.instance.clients.forEach(ac => {
							if (ac.rawEntity && ac.rawEntity.nid === proj.ownerNid) attacker = ac
						})
						if (!attacker) attacker = this.bots.find(b => b.rawEntity.nid === proj.ownerNid) || null
						this.damagePlayer(c, attacker, proj.damage, 'projectile', proj.weaponIndex)

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
					this.instance.removeEntity(proj)
					if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
					this.projectiles.delete(proj)
					break
				}
			}
		})

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
