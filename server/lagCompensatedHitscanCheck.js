import * as BABYLON from '../common/babylon.node.js'

// Per-pellet tracer (HITSCAN_DEBUG=1). Hoisted once at module load — process.env
// lookups are far too slow for a per-pellet hot path.
const HITSCAN_DEBUG = process.env.HITSCAN_DEBUG === '1'

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

// ── BODY CAPSULE (replaces the collision BOX as the hittable bulk) ──────────────
// The box this used to raycast is the MOVEMENT collider, and PlayerCharacter maps
// rotationX/rotationY straight onto mesh.rotation — so it rotates with the victim's
// AIM. A 1x1x1 cube presents ±0.50 of width face-on, ±0.71 corner-on (yaw 45°), and
// grows to -0.65..+0.65 tall when the victim pitches ±60°. The hittable volume
// therefore changed size and shape with where the victim happened to be LOOKING, and
// at 45° yaw it stuck ~0.48m of phantom body out each side of a ~0.22m-wide model —
// which is what let shots that visually missed still register, and what let a player
// hugging cover be shot through it (their phantom width was inside the wall).
//
// A vertical capsule is radially symmetric: pitch/yaw-invariant by construction, the
// same property the ZONES spheres above already rely on. Sized to the RENDERED body
// (hero_male.glb at scale 0.577 -> ~1.05 tall, feet at entity.y-0.50, crown +0.55;
// see client/assets/assetManifest.js) plus a small aim-forgiveness margin:
//   segment y-0.30..+0.30, radius 0.36  ->  spans y-0.66..+0.66, lateral ±0.36.
// Sized from scripts/probe-silhouette.ts, which CPU-skins the actual locomotion
// clips (Idle/Jog x4 directions) and takes the widest radius per 5cm height band:
// swinging arms reach 0.356m, feet/soles ~0.33m — r=0.36 covers every band except
// the LEADING FOOT at full jog stride (up to 0.53m, fore-aft only). That last bit is
// deliberately uncovered: it is directional, and a radial volume wide enough to
// include it would put ~0.5m of phantom body back through every wall — the exact
// bug this capsule replaces.
// NOTHING here touches mesh geometry, mesh.ellipsoid or checkCollisions, so movement
// collision is provably identical — this file no longer reads the mesh at all.
const CAPSULE_A = -0.30   // lower segment end, entity-local
const CAPSULE_B = 0.30    // upper segment end, entity-local
const CAPSULE_R = 0.36    // radius

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

// Analytic ray/vertical-capsule ENTRY distance (world metres; `d` is unit-length).
// Capsule axis runs from (cx, cy+a, cz) to (cx, cy+b, cz) with radius r. Infinity on
// a miss, 0 when the muzzle is already inside. Body of the capsule is solved as an
// infinite cylinder in XZ clipped to the segment; the rounded ends reuse the sphere
// entry above. No Babylon mesh, no world matrix — a few dozen flops.
const rayCapsuleEntry = (ox, oy, oz, dx, dy, dz, cx, cy, cz, a, b, r) => {
	const my = oy - cy
	// muzzle inside? (distance to the segment, in capsule-local space)
	const clamped = my < a ? a : (my > b ? b : my)
	const ix = ox - cx, iz = oz - cz, iy = my - clamped
	if (ix * ix + iy * iy + iz * iz <= r * r) return 0

	let best = Infinity
	const A = dx * dx + dz * dz
	if (A > 1e-12) {                          // not a perfectly vertical ray
		const B = 2 * (ix * dx + iz * dz)
		const C = ix * ix + iz * iz - r * r
		const disc = B * B - 4 * A * C
		if (disc >= 0) {
			const sq = Math.sqrt(disc)
			const inv = 1 / (2 * A)
			const t0 = (-B - sq) * inv
			if (t0 >= 0) { const y = my + t0 * dy; if (y >= a && y <= b) best = t0 }
			if (best === Infinity) {
				const t1 = (-B + sq) * inv
				if (t1 >= 0) { const y = my + t1 * dy; if (y >= a && y <= b) best = t1 }
			}
		}
	}
	// rounded ends: only count a cap hit on the side of the segment it belongs to
	const tA = raySphereEntry(ox, oy, oz, dx, dy, dz, cx, cy + a, cz, r)
	if (tA < best && my + tA * dy <= a) best = tA
	const tB = raySphereEntry(ox, oy, oz, dx, dy, dz, cx, cy + b, cz, r)
	if (tB < best && my + tB * dy >= b) best = tB
	return best
}

// Classify a hit into a body zone. (px,py,pz) is the ALREADY-REWOUND entity position.
// The hittable VOLUME is the body capsule UNION the three zone spheres — every part
// of it radially symmetric, so it is pitch/yaw-invariant and needs only the POSITION
// the historian rewinds, never a rotation rewind. Returns null when the ray touches
// nothing, otherwise { zone, distance } where `distance` is the nearest surface of
// that volume (metres along the ray) and `zone` is the NEAREST zone sphere entered,
// defaulting to 'torso' when only the capsule is clipped (shoulder/arm — arms fold
// into torso, and there is no skeleton to say otherwise).
const classifyZone = (o, d, px, py, pz) => {
	let bestZoneDist = Infinity
	let zone = null
	for (let i = 0; i < ZONES.length; i++) {
		const z = ZONES[i]
		const t = raySphereEntry(o.x, o.y, o.z, d.x, d.y, d.z, px, py + z.cy, pz, z.r)
		if (t < bestZoneDist) { bestZoneDist = t; zone = z.name }
	}
	const capDist = rayCapsuleEntry(o.x, o.y, o.z, d.x, d.y, d.z, px, py, pz,
		CAPSULE_A, CAPSULE_B, CAPSULE_R)
	if (capDist === Infinity && zone === null) return null   // no hit at all
	// entry = first contact with the hit volume (capsule OR any sphere).
	const entry = capDist < bestZoneDist ? capDist : bestZoneDist
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
		// MENU SAFETY: spawn-immune bodies are GHOSTS to hitscan — the ray passes
		// through to whatever is behind (wall or player). Without this an immune
		// spawn absorbs shots as free cover for 1s (damage was gated, hits weren't).
		if (realEntity && !(realEntity.spawnImmunity > 0)) {
			// The whole hit volume (capsule + zone spheres) is built ANALYTICALLY at the
			// rewound position, so this no longer teleports the live entity onto its past
			// position, raycasts its mesh and teleports it back once PER PELLET, PER
			// VICTIM — the mesh, its world matrix and its collision state are never
			// touched here at all. That removes the save/rewind/restore invariant (and
			// the aliasing hazard where ray.origin pointed at the very vector being
			// rewound) rather than merely documenting it, and drops a
			// computeWorldMatrix + Ray.intersectsMesh per victim per pellet.
			const zoned = classifyZone(
				probe.origin, probe.direction,
				pastEntity.x, pastEntity.y, pastEntity.z
			)

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
	if (candidates.length === 0) {
		if (HITSCAN_DEBUG) {
			console.log('[hs] NO-CANDIDATE timeAgo=' + timeAgo + ' past=' + pastEntities.length
				+ ' o=(' + probe.origin.x.toFixed(2) + ',' + probe.origin.y.toFixed(2) + ',' + probe.origin.z.toFixed(2)
				+ ') d=(' + probe.direction.x.toFixed(3) + ',' + probe.direction.y.toFixed(3) + ',' + probe.direction.z.toFixed(3) + ')'
				+ ' pastPos=[' + pastEntities.map(e => e.nid + '@(' + e.x.toFixed(1) + ',' + e.y.toFixed(1) + ',' + e.z.toFixed(1) + ')').join(' ') + ']')
		}
		return []
	}

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

	if (HITSCAN_DEBUG) {
		console.log('[hs] o=(' + probe.origin.x.toFixed(2) + ',' + probe.origin.y.toFixed(2) + ',' + probe.origin.z.toFixed(2)
			+ ') d=(' + probe.direction.x.toFixed(3) + ',' + probe.direction.y.toFixed(3) + ',' + probe.direction.z.toFixed(3)
			+ ') timeAgo=' + timeAgo + ' past=' + pastEntities.length
			+ ' wallDist=' + (wallDist === Infinity ? 'CLEAR' : wallDist.toFixed(2))
			+ ' cand=[' + candidates.map(c => c.entity.nid + ':' + c.zone + '@' + c.distance.toFixed(2)).join(' ') + ']')
	}
	const hits = []
	for (let i = 0; i < candidates.length; i++) {
		// preserve the return CONTRACT: carry entity + zone + distance so performShot
		// can apply the per-zone damage multiplier and the headshot feedback.
		if (candidates[i].distance < wallDist) hits.push(candidates[i])
	}
	return hits
}
