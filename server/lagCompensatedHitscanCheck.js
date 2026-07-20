import * as BABYLON from '../common/babylon.node.js'

// Nearest WORLD-GEOMETRY hit distance (world units) along `ray`, or Infinity if the
// ray reaches `maxDist` unobstructed.
//
// `meshes` is whatever static collider the active map provides — the artist OBJ's
// submeshes on a mesh map (GameInstance._loadMapMesh) or the box arena's Obstacle
// meshes (setupObstacles). Both are plain Babylon meshes, so ONE path serves both.
//
// Cheap reject first: project each mesh's world bounding sphere onto the ray; a mesh
// whose sphere only starts beyond `maxDist` (or beyond the best hit found so far)
// cannot occlude anything we care about, so it never pays for a triangle test.
export const nearestWorldHit = (meshes, ray, maxDist) => {
	let best = Infinity
	if (!meshes || meshes.length === 0) return best
	const o = ray.origin
	const d = ray.direction
	for (let i = 0; i < meshes.length; i++) {
		const mesh = meshes[i]
		const bs = mesh.getBoundingInfo && mesh.getBoundingInfo().boundingSphere
		if (bs) {
			const c = bs.centerWorld
			// distance along the ray at which this mesh's bounding sphere could start
			const near = ((c.x - o.x) * d.x + (c.y - o.y) * d.y + (c.z - o.z) * d.z) - bs.radiusWorld
			if (near > maxDist || near > best) continue
		}
		const pi = ray.intersectsMesh(mesh)
		if (pi.hit && pi.distance < best) best = pi.distance
	}
	return best
}

// Lag-compensated hitscan resolution. Returns the entities this ray legitimately hit:
// rewound to the shooter's view of the world, inside the weapon's reach, and with an
// unobstructed line from the muzzle.
//
// `world` (optional) is supplied by GameInstance.performShot:
//   { meshes: <static collider meshes>, maxDistance: <weapon reach in metres> }
// Omit it (or pass empty meshes) and this degrades to the old players-only behaviour,
// which is what happens during the brief async map load at boot — see performShot.
export default (instance, ray, timeAgo, world = null) => {
	// this is querying the whole game area of the demo, but if the game had a lot of entities
	// it would make sense to query just the rectangle containing the ray + a little bit of padding
	const area = { x: 0, y: 0, z: 0, halfWidth: 999999, halfHeight: 999999, halfDepth: 999999 }

	const maxDist = (world && world.maxDistance > 0) ? world.maxDistance : Number.MAX_VALUE

	// Fixed probe ray. The caller's ray.origin ALIASES the shooter's mesh.position
	// (common/weapon.js builds the ray straight off entity.mesh.position), and the
	// rewind below mutates that very vector whenever the shooter is itself in the
	// historian sample. Cloning once means every distance measured here — players and
	// world alike — comes from one stable origin.
	const probe = new BABYLON.Ray(ray.origin.clone(), ray.direction)

	const candidates = []
	const pastEntities = instance.historian.getLagCompensatedArea(timeAgo, area)

	pastEntities.forEach(pastEntity => {
		// look up the real entity
		// -- the objects returned by instance.historian are just shallow copies from the past
		const realEntity = instance.entities.get(pastEntity.nid)

		// real entity may not still exist. Just b/c it did in the past is no guarantee!
		if (realEntity) {
			// save position
			const temp = Object.assign({}, realEntity.mesh.position)

			// rewind to the lag compensated position
			realEntity.x = pastEntity.x
			realEntity.y = pastEntity.y
			realEntity.z = pastEntity.z
			realEntity.mesh.computeWorldMatrix(true)

			// see if the ray collides with an entity at the lag compensated position
			const raycheck = probe.intersectsMesh(realEntity.mesh)

			// restore the entity back to its current position (undo the lag compensated translation)
			Object.assign(realEntity.mesh.position, temp)

			// RANGE: keep the hit distance so the weapon's reach and the world-geometry
			// occlusion below can both be judged by distance ALONG THE RAY.
			if (raycheck.hit && raycheck.distance <= maxDist) {
				candidates.push({ entity: realEntity, distance: raycheck.distance })
			}
		}

	})

	// Nothing to damage -> never touch the map geometry. Most pellets hit no one, so
	// the (relatively expensive) world raycast is only paid on pellets that would
	// otherwise deal damage.
	if (candidates.length === 0) return []

	// OCCLUSION, by distance along the ray. Only geometry BETWEEN the muzzle and a
	// candidate blocks that candidate — a wall behind the victim is irrelevant, so we
	// bound the search at the furthest candidate rather than asking "does this ray hit
	// a wall anywhere". World geometry is static: it needs no rewinding, and this runs
	// after the loop above has already restored every entity, so the save/restore
	// invariant is untouched and the probe origin is the shooter's real position.
	let furthest = 0
	for (let i = 0; i < candidates.length; i++) {
		if (candidates[i].distance > furthest) furthest = candidates[i].distance
	}
	const wallDist = nearestWorldHit(world && world.meshes, probe, Math.min(furthest, maxDist))

	const hits = []
	for (let i = 0; i < candidates.length; i++) {
		if (candidates[i].distance < wallDist) hits.push(candidates[i].entity)
	}
	return hits
}
