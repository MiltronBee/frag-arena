// OFFLINE vertex-light bake: the runtime distance-only bake (client/graphics/
// mapLights.js) plus what it cannot afford per-load — SHADOW OCCLUSION (a ray per
// vertex per in-range light against the whole map) and AMBIENT OCCLUSION (16
// cosine-weighted hemisphere rays per vertex). Output is a per-map sidecar
// public/assets/maps/<MAP>/<objbase>.vertexlight.json that the client applies
// verbatim when it matches the OBJ (BABYLONRenderer._bakeMapLights), falling back
// to the runtime bake on any mismatch.
//
//   node scripts/bake-map-lighting.mjs grove        # one map (registry id)
//   node scripts/bake-map-lighting.mjs --all        # every mesh map in the registry
//
// Space: everything runs in the OBJ's NATIVE Z-up meter space — the same space the
// lights sidecar and the runtime bake use — so NO rotation/scale is applied. The
// OBJ is loaded exactly like server/GameInstance._loadMapMesh (same Babylon, same
// USE_LEGACY_BEHAVIOR=true, same 'data:,' trick): the legacy flag changes vertex
// mirror-X and MUST match or every baked color lands on the wrong side of the map.
//
// Winding note: these OBJ exports carry MIXED normal orientation (measured: many
// Visage meshes are half-and-half, Grove is flagged inverted in the registry). The
// runtime bake tolerates that via its 0.35 incidence floor, but raycasts do not:
// offsetting a shadow-ray origin along an inward normal buries it inside the wall
// and the surface self-shadows black. So the bake resolves an OUTWARD normal PER
// VERTEX geometrically: closest-hit probes along +n and -n — the side with more
// open space is the playable side. That outward normal seeds ray origins and the
// AO hemisphere, while bakeVertexColors keeps the RAW normals so the accumulation
// math stays bit-consistent with the runtime bake. Triangle intersection is
// double-sided (no backface culling) for the same reason.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NullEngine, Scene, SceneLoader, OBJFileLoader, VertexBuffer } from '../common/babylon.node.js'
import { mapRecords, getMapRecord } from '../common/mapRegistry.js'
import { bakeVertexColors } from '../client/graphics/mapLights.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const AO_RAYS = 16
const AO_MAX_DIST = 3.0      // meters (native) — corner/crevice scale, not room scale
const AO_FLOOR = 0.55        // ao remaps [0..1] -> [AO_FLOOR..1]
// Occlusion removes 85-92% of the through-wall light the runtime bake leaked, so the
// offline path needs a higher ambient than the runtime default (0.25) or combat
// legibility dies (the ACES-revert lesson: readable beats moody). Shadow CONTRAST
// still comes from occluded direct light; ambient just keeps floors visible.
const BAKE_AMBIENT = 0.34
const RAY_EPS = 0.05         // ray-origin lift off the surface
const LIGHT_EPS = 0.1        // stop shadow rays this short of the light (self/coplanar guard)

// ---------------------------------------------------------------------------
// BVH over the whole map's triangle soup (median split on centroids).
// ---------------------------------------------------------------------------
function buildBVH(tris) { // tris: Float32Array, 9 floats per triangle
	const n = tris.length / 9
	const cent = new Float32Array(n * 3)
	for (let i = 0; i < n; i++) {
		const o = i * 9
		cent[i * 3] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3
		cent[i * 3 + 1] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3
		cent[i * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3
	}
	const order = new Uint32Array(n)
	for (let i = 0; i < n; i++) order[i] = i
	// nodes as parallel arrays: bounds + (leaf ? triStart/triCount : leftChild)
	const nb = [] // {minx..maxz, start, count, left, right}
	const build = (start, count) => {
		const node = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity, start, count, left: -1, right: -1 }
		for (let i = start; i < start + count; i++) {
			const o = order[i] * 9
			for (let v = 0; v < 3; v++) {
				const x = tris[o + v * 3], y = tris[o + v * 3 + 1], z = tris[o + v * 3 + 2]
				if (x < node.minx) node.minx = x; if (x > node.maxx) node.maxx = x
				if (y < node.miny) node.miny = y; if (y > node.maxy) node.maxy = y
				if (z < node.minz) node.minz = z; if (z > node.maxz) node.maxz = z
			}
		}
		const idx = nb.length
		nb.push(node)
		if (count <= 8) return idx
		// median split along the widest centroid axis
		let cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity]
		for (let i = start; i < start + count; i++) {
			for (let a = 0; a < 3; a++) {
				const c = cent[order[i] * 3 + a]
				if (c < cmin[a]) cmin[a] = c
				if (c > cmax[a]) cmax[a] = c
			}
		}
		let axis = 0, w = cmax[0] - cmin[0]
		if (cmax[1] - cmin[1] > w) { axis = 1; w = cmax[1] - cmin[1] }
		if (cmax[2] - cmin[2] > w) { axis = 2; w = cmax[2] - cmin[2] }
		if (w < 1e-9) return idx // degenerate cluster: keep as leaf
		const sub = Array.from(order.subarray(start, start + count))
		sub.sort((a, b) => cent[a * 3 + axis] - cent[b * 3 + axis])
		for (let i = 0; i < count; i++) order[start + i] = sub[i]
		const half = count >> 1
		node.count = 0 // interior
		node.left = build(start, half)
		node.right = build(start + half, count - half)
		return idx
	}
	if (n > 0) build(0, n)
	return { tris, order, nodes: nb }
}

// Any-hit occlusion query: does the segment origin + dir*[0, tMax] hit a triangle?
// Double-sided (no backface culling) — see the winding note up top.
function occludedRay(bvh, ox, oy, oz, dx, dy, dz, tMax) {
	const { tris, order, nodes } = bvh
	if (nodes.length === 0) return false
	const inx = 1 / dx, iny = 1 / dy, inz = 1 / dz
	const stack = [0]
	while (stack.length) {
		const node = nodes[stack.pop()]
		// slab test
		let t0 = (node.minx - ox) * inx, t1 = (node.maxx - ox) * inx
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		let tmin = t0, tmaxb = t1
		t0 = (node.miny - oy) * iny; t1 = (node.maxy - oy) * iny
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		if (t0 > tmin) tmin = t0
		if (t1 < tmaxb) tmaxb = t1
		t0 = (node.minz - oz) * inz; t1 = (node.maxz - oz) * inz
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		if (t0 > tmin) tmin = t0
		if (t1 < tmaxb) tmaxb = t1
		if (tmaxb < Math.max(tmin, 0) || tmin > tMax) continue
		if (node.count > 0) { // leaf: Möller–Trumbore, double-sided, any hit
			for (let i = node.start; i < node.start + node.count; i++) {
				const o = order[i] * 9
				const ax = tris[o], ay = tris[o + 1], az = tris[o + 2]
				const e1x = tris[o + 3] - ax, e1y = tris[o + 4] - ay, e1z = tris[o + 5] - az
				const e2x = tris[o + 6] - ax, e2y = tris[o + 7] - ay, e2z = tris[o + 8] - az
				const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
				const det = e1x * px + e1y * py + e1z * pz
				if (det > -1e-9 && det < 1e-9) continue
				const inv = 1 / det
				const tx = ox - ax, ty = oy - ay, tz = oz - az
				const u = (tx * px + ty * py + tz * pz) * inv
				if (u < 0 || u > 1) continue
				const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
				const v = (dx * qx + dy * qy + dz * qz) * inv
				if (v < 0 || u + v > 1) continue
				const t = (e2x * qx + e2y * qy + e2z * qz) * inv
				if (t > 1e-4 && t < tMax) return true
			}
		} else {
			stack.push(node.left, node.right)
		}
	}
	return false
}

// Closest-hit distance along a ray (capped at tMax; returns tMax if nothing hit).
// Used only for the per-vertex outward-normal probe.
function closestRay(bvh, ox, oy, oz, dx, dy, dz, tMax) {
	const { tris, order, nodes } = bvh
	if (nodes.length === 0) return tMax
	const inx = 1 / dx, iny = 1 / dy, inz = 1 / dz
	let best = tMax
	const stack = [0]
	while (stack.length) {
		const node = nodes[stack.pop()]
		let t0 = (node.minx - ox) * inx, t1 = (node.maxx - ox) * inx
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		let tmin = t0, tmaxb = t1
		t0 = (node.miny - oy) * iny; t1 = (node.maxy - oy) * iny
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		if (t0 > tmin) tmin = t0
		if (t1 < tmaxb) tmaxb = t1
		t0 = (node.minz - oz) * inz; t1 = (node.maxz - oz) * inz
		if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
		if (t0 > tmin) tmin = t0
		if (t1 < tmaxb) tmaxb = t1
		if (tmaxb < Math.max(tmin, 0) || tmin > best) continue
		if (node.count > 0) {
			for (let i = node.start; i < node.start + node.count; i++) {
				const o = order[i] * 9
				const ax = tris[o], ay = tris[o + 1], az = tris[o + 2]
				const e1x = tris[o + 3] - ax, e1y = tris[o + 4] - ay, e1z = tris[o + 5] - az
				const e2x = tris[o + 6] - ax, e2y = tris[o + 7] - ay, e2z = tris[o + 8] - az
				const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
				const det = e1x * px + e1y * py + e1z * pz
				if (det > -1e-9 && det < 1e-9) continue
				const inv = 1 / det
				const tx = ox - ax, ty = oy - ay, tz = oz - az
				const u = (tx * px + ty * py + tz * pz) * inv
				if (u < 0 || u > 1) continue
				const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
				const v = (dx * qx + dy * qy + dz * qz) * inv
				if (v < 0 || u + v > 1) continue
				const t = (e2x * qx + e2y * qy + e2z * qz) * inv
				if (t > 1e-4 && t < best) best = t
			}
		} else {
			stack.push(node.left, node.right)
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// Deterministic cosine-weighted hemisphere pattern (Hammersley base — NO
// Math.random anywhere, so re-bakes are byte-identical). Per-vertex the set is
// spun by vertexIndex * goldenAngle so neighbours don't share banding.
// ---------------------------------------------------------------------------
const AO_DIRS = (() => {
	const dirs = new Float64Array(AO_RAYS * 3)
	for (let k = 0; k < AO_RAYS; k++) {
		// radical inverse base 2 of k (van der Corput)
		let bits = k, ri = 0, f = 0.5
		for (let b = 0; b < 8; b++) { ri += (bits & 1) * f; bits >>= 1; f *= 0.5 }
		const u = (k + 0.5) / AO_RAYS
		const r = Math.sqrt(u), phi = 2 * Math.PI * ri
		dirs[k * 3] = r * Math.cos(phi)
		dirs[k * 3 + 1] = r * Math.sin(phi)
		dirs[k * 3 + 2] = Math.sqrt(Math.max(0, 1 - u)) // cosine-weighted: z ~ sqrt(1-u)
	}
	return dirs
})()
const GOLDEN_ANGLE = 2.3999632297286533

// AO for one vertex: fraction of the hemisphere (around the OUTWARD normal) open
// within AO_MAX_DIST, remapped to [AO_FLOOR..1].
function vertexAO(bvh, vi, px, py, pz, nx, ny, nz) {
	// orthonormal basis around n (Frisvad, branch on sign for stability)
	let tx, ty, tz, bx, by, bz
	if (nz < -0.9999999) { tx = 0; ty = -1; tz = 0; bx = -1; by = 0; bz = 0 }
	else {
		const a = 1 / (1 + nz), b = -nx * ny * a
		tx = 1 - nx * nx * a; ty = b; tz = -nx
		bx = b; by = 1 - ny * ny * a; bz = -ny
	}
	const rot = vi * GOLDEN_ANGLE
	const cr = Math.cos(rot), sr = Math.sin(rot)
	const ox = px + nx * RAY_EPS, oy = py + ny * RAY_EPS, oz = pz + nz * RAY_EPS
	let open = 0
	for (let k = 0; k < AO_RAYS; k++) {
		const lx0 = AO_DIRS[k * 3], ly0 = AO_DIRS[k * 3 + 1], lz = AO_DIRS[k * 3 + 2]
		const lx = lx0 * cr - ly0 * sr, ly = lx0 * sr + ly0 * cr
		const dx = tx * lx + bx * ly + nx * lz
		const dy = ty * lx + by * ly + ny * lz
		const dz = tz * lx + bz * ly + nz * lz
		if (!occludedRay(bvh, ox, oy, oz, dx, dy, dz, AO_MAX_DIST)) open++
	}
	return AO_FLOOR + (1 - AO_FLOOR) * (open / AO_RAYS)
}

// ---------------------------------------------------------------------------
// Per-map bake
// ---------------------------------------------------------------------------
async function bakeMap(map) {
	const t0 = Date.now()
	const objPath = path.join(ROOT, 'public', map.dir, map.file)
	const lightsPath = path.join(ROOT, 'public', map.dir, map.lights)
	const outPath = objPath.replace(/\.obj$/i, '') + '.vertexlight.json'

	// Load EXACTLY like server/GameInstance._loadMapMesh: legacy orientation + the
	// 'data:,' regex-backtracking guard. NO rotation/scale — native OBJ space.
	OBJFileLoader.USE_LEGACY_BEHAVIOR = true
	const engine = new NullEngine()
	const scene = new Scene(engine)
	const obj = fs.readFileSync(objPath, 'utf8').replace(/^mtllib.*$/gm, '')
	const res = await SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
	const lights = JSON.parse(fs.readFileSync(lightsPath, 'utf8')).lights

	// Same eligibility filter as the client's _bakeMapLights (order preserved —
	// the client matches sidecar entries to meshes pairwise in this order).
	const meshes = res.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
	const bufs = meshes.map(m => ({
		name: m.name,
		pos: m.getVerticesData(VertexBuffer.PositionKind),
		nor: m.getVerticesData(VertexBuffer.NormalKind),
		idx: m.getIndices(),
	}))
	for (const b of bufs) {
		if (!b.pos || !b.nor || !b.idx) throw new Error(`${map.id}: mesh '${b.name}' missing positions/normals/indices`)
	}

	// Global triangle soup (occlusion crosses mesh boundaries) -> BVH.
	let triCount = 0
	for (const b of bufs) triCount += b.idx.length / 3
	const tris = new Float32Array(triCount * 9)
	let tw = 0
	for (const b of bufs) {
		for (let i = 0; i < b.idx.length; i += 3) {
			for (let v = 0; v < 3; v++) {
				const p = b.idx[i + v] * 3
				tris[tw++] = b.pos[p]; tris[tw++] = b.pos[p + 1]; tris[tw++] = b.pos[p + 2]
			}
		}
	}
	const bvh = buildBVH(tris)

	console.log(`[${map.id}] ${meshes.length} meshes, ${triCount} tris, ${lights.length} lights`)

	let shadowRays = 0, shadowHits = 0, totalVerts = 0, flipped = 0
	const outMeshes = bufs.map(b => {
		const count = b.pos.length / 3
		totalVerts += count
		// PER-VERTEX outward normal (mixed winding — see header): probe closest-hit
		// distance along +n and -n; the side with MORE open space is the playable
		// side. Inside a solid wall the probe exits through its far face within the
		// wall thickness (< any room dimension), so ties only happen on thin floating
		// panels where orientation barely matters (keep +n).
		const sign = new Int8Array(count)
		for (let i = 0; i < count; i++) {
			const nx = b.nor[i * 3], ny = b.nor[i * 3 + 1], nz = b.nor[i * 3 + 2]
			if (nx * nx + ny * ny + nz * nz < 1e-6) { sign[i] = 1; continue }
			const px = b.pos[i * 3], py = b.pos[i * 3 + 1], pz = b.pos[i * 3 + 2]
			const tP = closestRay(bvh, px, py, pz, nx, ny, nz, 30)
			const tM = closestRay(bvh, px, py, pz, -nx, -ny, -nz, 30)
			sign[i] = tP >= tM ? 1 : -1
			if (sign[i] < 0) flipped++
		}
		// Shadow-occlusion hook for the shared accumulation math: lift the origin off
		// the surface along the outward normal and trace to the light. Any geometry
		// in between (including the vertex's own wall for a light BEHIND it) kills
		// that light's contribution — this is the "light through walls" fix.
		const occlude = (vi, px, py, pz, nx, ny, nz, l) => {
			const s = sign[vi] * RAY_EPS
			const ox = px + nx * s, oy = py + ny * s, oz = pz + nz * s
			let dx = l.x - ox, dy = l.y - oy, dz = l.z - oz
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
			if (dist < LIGHT_EPS) return false
			dx /= dist; dy /= dist; dz /= dist
			shadowRays++
			const hit = occludedRay(bvh, ox, oy, oz, dx, dy, dz, dist - LIGHT_EPS)
			if (hit) shadowHits++
			return hit
		}
		const cols = bakeVertexColors(b.pos, b.nor, lights, BAKE_AMBIENT, undefined, occlude)
		// AO multiply (hemisphere around the outward normal), then quantize.
		const rgb = new Uint8Array(count * 3)
		for (let i = 0; i < count; i++) {
			const s = sign[i]
			const nx = b.nor[i * 3] * s, ny = b.nor[i * 3 + 1] * s, nz = b.nor[i * 3 + 2] * s
			const ao = vertexAO(bvh, i, b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2], nx, ny, nz)
			for (let c = 0; c < 3; c++) {
				const q = Math.round(cols[i * 4 + c] * ao * 255)
				rgb[i * 3 + c] = q < 0 ? 0 : q > 255 ? 255 : q
			}
		}
		return { name: b.name, vertexCount: count, rgb: Buffer.from(rgb).toString('base64') }
	})
	console.log(`[${map.id}] outward-normal probe flipped ${flipped}/${totalVerts} vertex normals for rays`)

	const out = { version: 1, map: map.id, obj: map.file, meshes: outMeshes }
	fs.writeFileSync(outPath, JSON.stringify(out))
	scene.dispose(); engine.dispose()
	const secs = ((Date.now() - t0) / 1000).toFixed(1)
	const kb = (fs.statSync(outPath).size / 1024).toFixed(0)
	console.log(`[${map.id}] baked ${totalVerts} verts | shadow rays ${shadowRays} (${(100 * shadowHits / Math.max(shadowRays, 1)).toFixed(1)}% occluded) | ${secs}s | ${path.basename(outPath)} ${kb}KB`)
	return { id: map.id, secs: +secs, kb: +kb, verts: totalVerts }
}

// ---------------------------------------------------------------------------
const arg = process.argv[2]
if (!arg) {
	console.error('usage: node scripts/bake-map-lighting.mjs <mapId|--all>')
	console.error('  map ids:', Object.keys(mapRecords).filter(id => mapRecords[id].useMeshMap).join(', '))
	process.exit(1)
}
const targets = arg === '--all'
	? Object.values(mapRecords).filter(m => m.useMeshMap && m.lights)
	: [getMapRecord(arg)]
const stats = []
for (const map of targets) stats.push(await bakeMap(map))
console.log('\nSUMMARY')
for (const s of stats) console.log(`  ${s.id}: ${s.verts} verts, ${s.secs}s, ${s.kb}KB`)
