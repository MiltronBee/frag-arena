import CharacterModel from '../graphics/CharacterModel'
import { assets } from '../assets/assetManifest'

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
		},
		delete({ nid, entity }) {
			const model = simulator.characterModels.get(nid)
			if (model) {
				model.dispose()
				simulator.characterModels.delete(nid)
			}
			entity.mesh.dispose()
		},
		watch: {
			hitpoints({ entity, value }) {
				// this doesnt happen ever.. but this is an example hook
				console.log('hitpoints changed! time to update our ui or something')
			}
		}
	}
}
