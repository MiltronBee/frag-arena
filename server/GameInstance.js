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

		this.instance.on('command::FireCommand', ({ command, client, tick }) => {
			// shoot from the perspective of this client's entity
			const entity = client.rawEntity
			const smoothEntity = client.smoothEntity

			const ray = fire(entity)
			if (ray) {
				const timeAgo = client.latency + 100
				const hits = lagCompensatedHitscanCheck(this.instance, ray, timeAgo)

				hits.forEach(victim => {
					// if the victim isn't ourself...
					if (victim.nid !== entity.nid && victim.nid !== smoothEntity.nid) {
						console.log('hit', victim.nid)

						if (victim instanceof PlayerCharacter) {
							console.log('you hit a player!')
						}
					}
				})

				// send a network message (causes all clients to draw the specified ray)
				// NOTE: we fire the shot from the RAW entity for accuracy that matches 
				// what the player experienced on their own screen. But for apperances, we 
				// tell everyone that the shot came from the smooth entity's position.
				this.instance.addLocalMessage(new WeaponFired(
					smoothEntity.nid,
					smoothEntity.x,
					smoothEntity.y,
					smoothEntity.z,
					ray.direction.x,
					ray.direction.y,
					ray.direction.z,
				))
			}
		})
	}

	update(delta, tick, now) {
		this.instance.emitCommands()

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
