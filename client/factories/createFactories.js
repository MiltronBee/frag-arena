import createPlayerFactory from './createPlayerFactory'
import createObstacleFactory from './createObstacleFactory'

export default ({ simulator /* inject depenencies here */ }) => {
	return {
		'PlayerCharacter': createPlayerFactory({ simulator, /* inject depenencies here */ }),
		'Obstacle': createObstacleFactory({ simulator }),
		// A FACTORY OBJECT, not a function: nengi calls factory.create/.delete
		// directly (see niceClientExtension). Registering the bare arrow left
		// factory.create/.delete undefined -> "factory.create is not a function"
		// for every replicated projectile (Plasma Rifle). The projectile's sphere
		// mesh is built in the Projectile constructor and auto-added to the scene,
		// so create() is a no-op; delete() disposes it (guarded against a
		// double-delete leaving a disposed/absent mesh).
		'Projectile': {
			create({ data, entity }) {
				// track the bolt so the Simulator can orient + stretch it into a hot
				// travel streak each frame (presentation only)
				simulator.registerProjectile(entity)
			},
			delete({ nid, entity }) {
				// emit a pooled energetic impact + positional zap where the bolt ended,
				// then stop tracking it
				simulator.unregisterProjectile(nid)
				// dispose(doNotRecurse=false, disposeMaterialAndTextures=true): the
				// Projectile constructor builds fresh StandardMaterials per shot (core +
				// glow), so a bare mesh.dispose() (materials default OFF) leaks one per
				// bolt. Recursing also disposes the parented glow child + its material.
				// The headless placeholder mesh ignores args.
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose(false, true)
				}
			}
		}
	}
}
