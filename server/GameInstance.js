import nengi from 'nengi'
import nengiConfig from '../common/nengiConfig'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import Identity from '../common/message/Identity'
import WeaponFired from '../common/message/WeaponFired'
import followPath from './followPath'
import damagePlayer from './damagePlayer' // TODO
import niceInstanceExtension from './niceInstanceExtension'
import applyCommand, { MAX_SPEED } from '../common/applyCommand'
import setupObstacles from './setupObstacles'
import { fire } from '../common/weapon'
import lagCompensatedHitscanCheck from './lagCompensatedHitscanCheck'
import Projectile from '../common/entity/Projectile'
import { weapons } from '../common/weaponsConfig'

import * as BABYLON from 'babylonjs'
//import 'babylonjs-loaders' // mutates something globally
global.XMLHttpRequest = require('xhr2').XMLHttpRequest

class GameInstance {
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

		this.instance.on('connect', ({ client, callback }) => {
			// PER player-related state, attached to clients

			// create a entity for this client
			const rawEntity = new PlayerCharacter()
			rawEntity.mesh.checkCollisions = true

			// spread spawns out — spawning everyone at the exact origin puts players
			// INSIDE each other's collision boxes, and moveWithCollisions can't escape
			// from inside a collider (you'd be frozen until the other player moves)
			const spawnAngle = Math.random() * Math.PI * 2
			const spawnRadius = 3 + Math.random() * 5
			rawEntity.x = Math.cos(spawnAngle) * spawnRadius
			rawEntity.z = Math.sin(spawnAngle) * spawnRadius

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

			// define the view (the area of the game visible to this client, all else is culled)
			// there is no 3D view culler in nengi yet, so we just use a big view (there will be one soon tho)
			client.view = {
				x: rawEntity.x,
				y: rawEntity.y,
				z: rawEntity.z,
				halfWidth: 20,
				halfHeight: 20,
				halfDepth: 20
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
			}
		})

		this.instance.on('command::DevUpdateWeaponConfigCommand', ({ command, client, tick }) => {
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
			const entity = client.rawEntity
			const smoothEntity = client.smoothEntity

			const ray = fire(entity)
			if (ray) {
				const config = ray.config
				const timeAgo = client.latency + 100

				if (config.type === 'hitscan') {
					if (config.name === 'Shotgun') {
						// Shotgun: Multi-pellet hitscan check
						const spread = config.spread || 0.08
						for (let i = 0; i < config.pellets; i++) {
							const offsetDir = ray.direction.clone()
							offsetDir.x += (Math.random() - 0.5) * spread
							offsetDir.y += (Math.random() - 0.5) * spread
							offsetDir.z += (Math.random() - 0.5) * spread
							offsetDir.normalize()

							const pelletRay = new BABYLON.Ray(ray.origin, offsetDir)
							const hits = lagCompensatedHitscanCheck(this.instance, pelletRay, timeAgo)
							hits.forEach(victim => {
								if (victim.nid !== entity.nid && victim.nid !== smoothEntity.nid) {
									if (victim instanceof PlayerCharacter && victim.isAlive) {
										victim.hitpoints = Math.max(0, victim.hitpoints - config.damage)
										console.log(`Shotgun pellet hit Player ${victim.nid}! HP: ${victim.hitpoints}`)
										if (victim.hitpoints <= 0) {
											victim.isAlive = false
											console.log(`Player ${victim.nid} died from Shotgun!`)
										}
									}
								}
							})
						}
					} else {
						// Standard Hitscan: Single trace check
						const hits = lagCompensatedHitscanCheck(this.instance, ray, timeAgo)
						hits.forEach(victim => {
							if (victim.nid !== entity.nid && victim.nid !== smoothEntity.nid) {
								if (victim instanceof PlayerCharacter && victim.isAlive) {
									victim.hitpoints = Math.max(0, victim.hitpoints - config.damage)
									console.log(`Player ${victim.nid} hit by ${config.name}! HP: ${victim.hitpoints}`)
									if (victim.hitpoints <= 0) {
										victim.isAlive = false
										console.log(`Player ${victim.nid} died from ${config.name}!`)
									}
								}
							}
						})
					}

					// Send WeaponFired message to client to render tracers
					this.instance.addLocalMessage(new WeaponFired(
						smoothEntity.nid,
						smoothEntity.x,
						smoothEntity.y,
						smoothEntity.z,
						ray.direction.x,
						ray.direction.y,
						ray.direction.z,
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
					proj.velocity = ray.direction.scale(proj.speed)
					proj.lifeTime = 3.0 // 3 seconds max lifetime

					this.instance.addEntity(proj)
					this.projectiles.add(proj)
					console.log(`Spawned projectile ${proj.nid} from player ${entity.nid}`);
				}
			}
		})
	}

	update(delta, tick, now) {
		this.instance.emitCommands()

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

			// Check collisions with players
			this.instance.clients.forEach(c => {
				if (hitOccurred) return
				const target = c.rawEntity
				if (target && target.isAlive && target.nid !== proj.ownerNid) {
					const dx = target.x - proj.x
					const dy = target.y - proj.y
					const dz = target.z - proj.z
					const dist = Math.hypot(dx, dy, dz)

					// Collision cylinder check (height 1m, radius 0.75m)
					if (dist < 0.75 && Math.abs(dy) < 1.0) {
						target.hitpoints = Math.max(0, target.hitpoints - proj.damage)
						console.log(`Player ${target.nid} was hit by projectile from ${proj.ownerNid}! HP: ${target.hitpoints}`)
						
						if (target.hitpoints <= 0) {
							target.isAlive = false
							console.log(`Player ${target.nid} was killed!`)
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

			// center client's network view on the entity they control
			client.view.x = rawEntity.x
			client.view.y = rawEntity.y
			client.view.z = rawEntity.z

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
