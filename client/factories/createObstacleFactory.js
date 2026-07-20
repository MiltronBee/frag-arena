import * as BABYLON from '../babylon.js'

export default ({ simulator }) => {
	return {
		create({ entity }) {
			simulator.obstacles.set(entity.nid, entity)

			const metadata = simulator.renderer.scene.metadata || {}
			const materials = metadata.obstacleMaterials || []
			const accents = metadata.obstacleAccentMaterials || []
			entity.mesh.material = materials[entity.style] || materials[0] || null
			// near-black edge grounding only — the emissive trim strip carries the
			// color identity now; neon outlines read cartoonish against the dusk scene
			entity.mesh.renderOutline = true
			entity.mesh.outlineColor = new BABYLON.Color3(0.02, 0.02, 0.03)
			entity.mesh.outlineWidth = 0.02

			const accent = BABYLON.MeshBuilder.CreateBox(
				`obstacleAccent-${entity.nid}`,
				{ size: 1 },
				simulator.renderer.scene
			)
			accent.parent = entity.mesh
			accent.position.y = 0.505
			if (entity.width >= entity.depth) {
				accent.scaling.set(0.86, 0.025, 0.06)
			} else {
				accent.scaling.set(0.06, 0.025, 0.86)
			}
			accent.material = accents[entity.style] || accents[0] || null
			accent.isPickable = false
			accent.checkCollisions = false
			// tag for surface-aware impacts (stone chips/dust). See firingFx.classifySurface.
			entity.mesh.metadata = { cosmetics: [accent], fragSurface: 'stone' }

			// SciFi kit skin: async-upgrades this box to instanced kit meshes and
			// hides it (still pickable). Legacy look above stays as the fallback.
			const dressing = simulator.renderer.arenaDressing
			if (dressing) dressing.attachObstacle(entity)
		},
		delete({ nid, entity }) {
			simulator.obstacles.delete(nid)
			const dressing = simulator.renderer.arenaDressing
			if (dressing) dressing.detachObstacle(nid)
			entity.mesh.dispose()
		}
	}
}
