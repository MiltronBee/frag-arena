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

// ── Body-zone POSE MODEL (v1: hitscan) ──────────────────────────────────────────
// The server has NO skeleton: a player is ONE CreateBox(size 1) spanning y-0.5..+0.5
// (common/entity/PlayerCharacter.js). Body zones are therefore three ON-AXIS spheres
// in ENTITY-LOCAL units, matched to the VISIBLE model (feet at y-0.5, head top at
// y+0.60). Because they sit on the vertical axis they are radially symmetric — pitch/
// yaw-invariant — so they need NO rotation rewind, only the POSITION the historian
// already rewinds. Placed at (past.x, past.y + cy, past.z). Kept server-side only
// (never networked; the client never asserts a zone).
//
// head reaches y+0.60, ABOVE the collision box (+0.5) — so the hittable VOLUME here is
// the box UNION these spheres (see classifyZone). That closes the "top of the visible
// head misses the box" gap WITHOUT touching the box mesh / its ellipsoid, so movement
// collision is provably unaffected (the box geometry and ellipsoid are untouched).
const ZONES = [
	{ name: 'head',  cy: 0.47, r: 0.13 },   // covers y+0.34..+0.60 (visible head, incl. top)
	{ name: 'torso', cy: 0.15, r: 0.28 },   // chest/abdomen (arms fold in here — no skeleton)
	{ name: 'legs',  cy: -0.28, r: 0.26 },  // hips down to feet
]

// Analytic ray/sphere ENTRY distance (world metres, since `d` is unit-length — see the
// probe below and common/firePattern.applyPattern, which returns a normalized dir).
// Returns Infinity on a miss / sphere fully behind the muzzle; 0 if the muzzle is
// inside the sphere. No Babylon mesh is created — this is a handful of flops per zone.
const raySphereEntry = (ox, oy, oz, dx, dy, dz, cx, cy, cz, r) => {
	const lx = cx - ox, ly = cy - oy, lz = cz - oz
	const tca = lx * dx + ly * dy + lz * dz
	const d2 = (lx * lx + ly * ly + lz * lz) - tca * tca
	const r2 = r * r
	if (d2 > r2) return Infinity            // ray misses the sphere entirely
	const thc = Math.sqrt(r2 - d2)
	const t1 = tca + thc
	if (t1 < 0) return Infinity             // whole sphere is behind the muzzle
	const t0 = tca - thc
	return t0 >= 0 ? t0 : 0                  // origin inside sphere -> entry at 0
}

// Classify a rewound hit into a body zone. `boxHit`/`boxDist` come from the existing
// box raycast; (px,py,pz) is the ALREADY-REWOUND entity position. Returns null when
// the ray touches neither the box nor any zone sphere (no hit), otherwise
// { zone, distance } where `distance` is the nearest surface of the hit volume (metres
// along the ray) and `zone` is the NEAREST zone entered — defaulting to 'torso' when
// only the box is clipped (e.g. a shoulder outside every sphere).
const classifyZone = (o, d, boxHit, boxDist, px, py, pz) => {
	let bestZoneDist = Infinity
	let zone = null
	for (let i = 0; i < ZONES.length; i++) {
		const z = ZONES[i]
		const t = raySphereEntry(o.x, o.y, o.z, d.x, d.y, d.z, px, py + z.cy, pz, z.r)
		if (t < bestZoneDist) { bestZoneDist = t; zone = z.name }
	}
	if (!boxHit && zone === null) return null          // no hit at all
	// entry = first contact with the hit volume (box OR any sphere).
	const entry = Math.min(boxHit ? boxDist : Infinity, bestZoneDist)
	// box clipped but no sphere -> baseline torso (shoulder/arm; arms fold into torso).
	return { zone: zone !== null ? zone : 'torso', distance: entry }
}

// Lag-compensated hitscan resolution. Returns the HITS this ray legitimately landed:
// rewound to the shooter's view of the world, inside the weapon's reach, unobstructed
// from the muzzle, and CLASSIFIED into a body zone. Shape:
//   [ { entity, zone, distance }, ... ]   (was: [ entity, ... ] before body zones)
// `zone` is 'head' | 'torso' | 'legs'; `distance` is metres along the ray. Callers
// (GameInstance.performShot) read hit.entity for the victim and hit.zone for the
// damage multiplier + headshot feedback.
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
	// world alike — comes from one stable origin. ray.direction is unit-length, so the
	// analytic zone-sphere entries below are in the same metres as the box/world hits.
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

			// see if the ray collides with the box at the lag compensated position
			const raycheck = probe.intersectsMesh(realEntity.mesh)

			// BODY-ZONE classification rides this same rewound block: the three on-axis
			// zone spheres are built at the ALREADY-REWOUND position (pastEntity x/y/z,
			// no rotation — they are yaw/pitch-invariant), ray-tested analytically, and
			// the NEAREST zone is returned. The hittable VOLUME is the box UNION the
			// spheres, so a shot at the top of the visible head (above the box) still
			// registers. Default 'torso' when the box is clipped but no sphere is.
			const zoned = classifyZone(
				probe.origin, probe.direction,
				raycheck.hit, raycheck.distance,
				pastEntity.x, pastEntity.y, pastEntity.z
			)

			// restore the entity back to its current position (undo the lag compensated translation)
			Object.assign(realEntity.mesh.position, temp)

			// RANGE: keep the hit distance so the weapon's reach and the world-geometry
			// occlusion below can both be judged by distance ALONG THE RAY.
			if (zoned && zoned.distance <= maxDist) {
				candidates.push({ entity: realEntity, distance: zoned.distance, zone: zoned.zone })
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
		// preserve the return CONTRACT: carry entity + zone + distance so performShot
		// can apply the per-zone damage multiplier and the headshot feedback.
		if (candidates[i].distance < wallDist) hits.push(candidates[i])
	}
	return hits
}
