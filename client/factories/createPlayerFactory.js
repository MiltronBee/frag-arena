import CharacterModel from '../graphics/CharacterModel'
import { assets } from '../assets/assetManifest'
import { PLAYER_NAMES, HUMAN_NAME_SENTINEL } from '../../common/playerNames'

// base hit-stop duration (ms) when an observed player takes damage; CharacterModel
// scales nothing but clamps to its own HIT_STOP_MAX_MS, so heavier hits (which we
// nudge up by damage) still can't stall the body. Conservative — tune from play.
const HIT_STOP_MS = 70

export default ({ simulator }) => {
	return {
		create({ entity }) {
			/* self, raw */
			if (entity.nid === simulator.myRawId) {
				// this is *OUR* entity, enable collisions for it
				// we'll be using these in clientside prediction
				entity.mesh.checkCollisions = true
				// place it at the server-assigned spawn (x/y/z updates for our own
				// entity are ignored — we predict them — so this is the only handoff)
				if (simulator.spawnPos) {
					entity.x = simulator.spawnPos.x
					entity.z = simulator.spawnPos.z
				}
				simulator.myRawEntity = entity
				simulator.setArenaReady()
				return
			}

			/* self, smooth */
			if (entity.nid === simulator.mySmoothId) {
				// this is also *OUR* entity as seen by others.. but this client should just hide it
				entity.mesh.checkCollisions = false
				simulator.mySmoothEntity = entity
				entity.mesh.setEnabled(false) // hide it (we're in first person)
				return
			}

			/* another player: replace the bare collision box with a visual character
			   model that rides the box. The box stays as the (invisible) transform we
			   read position/yaw from; the model is cosmetic and client-only. */
			entity.mesh.isVisible = false
			const model = new CharacterModel(simulator.renderer.scene, entity.mesh, assets.playerBody)
			simulator.characterModels.set(entity.nid, model)
			const isHuman = entity.nameIndex >= HUMAN_NAME_SENTINEL
			if (isHuman) {
				// name arrives via PlayerName message; it may already be registered if
				// that message beat this create (welcome-replay or a fast SetNameCommand)
				const existing = simulator._nameRegistry.get(entity.nid)
				if (existing) model.setName(existing)
			} else {
				const name = PLAYER_NAMES[entity.nameIndex] || `Bot ${entity.nid}`
				simulator._nameRegistry.set(entity.nid, name)
				model.setName(name)
			}
		},
		delete({ nid, entity }) {
			const model = simulator.characterModels.get(nid)
			if (model) {
				model.dispose()
				simulator.characterModels.delete(nid)
			}
			simulator._nameRegistry.delete(nid)
			entity.mesh.dispose()
		},
		watch: {
			// swap the held weapon prop when the replicated index changes. The watch
			// also fires on create with the initial value, so a player already holding
			// a non-default gun shows it correctly to a client that joins later.
			// (CharacterModel's host is the entity MESH, which has no protocol fields —
			// replicated props must come through here.)
			currentWeaponIndex({ entity, value }) {
				const model = simulator.characterModels.get(entity.nid)
				if (model) model.setWeapon(value)
			},
			// callsign arrives as a replicated index (also fires on create with the
			// initial value); resolve + register it so the nametag + kill feed match.
			nameIndex({ entity, value }) {
				const name = PLAYER_NAMES[value] || `Player ${entity.nid}`
				simulator._nameRegistry.set(entity.nid, name)
				const model = simulator.characterModels.get(entity.nid)
				if (model) model.setName(name)
			},
			// observers can detect damage on any remote player via replicated hitpoints
			// decreasing — play a brief hit-react one-shot (RecieveHit). Priority in
			// CharacterModel keeps this from stomping an active shoot/death.
			hitpoints({ entity, value }) {
				const prev = entity._prevHitpoints
				entity._prevHitpoints = value
				if (prev == null || value >= prev) return // spawn/heal, not a hit
				const model = simulator.characterModels.get(entity.nid)
				if (model) {
					model.playHit()
					// micro hit-stop: base + a small bump by damage (CharacterModel clamps).
					model.hitStop(HIT_STOP_MS + Math.min(prev - value, 20) * 1.5)
					// victim pain grunt (sample-only), spatialized from the remote player's
					// world position so it comes from THEIR direction (distance kept as a
					// 2D fallback when audio has no live ctx / panner).
					if (simulator.audio) {
						const cam = simulator.renderer && simulator.renderer.camera
						const dist = cam ? Math.hypot(entity.x - cam.position.x, entity.y - cam.position.y, entity.z - cam.position.z) : 0
						simulator.audio.pain({ distance: dist, pos: { x: entity.x, y: entity.y, z: entity.z } })
					}
				}
			}
		}
	}
}
