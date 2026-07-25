// Occlusion ground-truth probe.
//
// Rebuilds the SERVER's hitscan occluder set exactly as GameInstance._loadMapMesh
// does, then compares nearestWorldHit() against a brute-force Moller-Trumbore sweep
// over every world-space triangle of the same map. Any disagreement is a bug in the
// occluder path (bounding-volume culling, clone transforms, subdivision), not art.
//
//   npx tsx scripts/probe-occlusion.ts [mapId]
import * as BABYLON from '../common/babylon.node.js'
import { getMapRecord } from '../common/mapRegistry'
import { nearestWorldHit } from '../server/lagCompensatedHitscanCheck'
import fs from 'fs'

const main = async () => {
const mapId = process.argv[2] || 'dm_hex2'
const map = getMapRecord(mapId)
console.log(`map ${mapId} (${map.name}) rotX=${map.rotationX} scale=${map.scale} file=${map.file}`)

const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
scene.collisionsEnabled = true

// ---- verbatim copy of GameInstance._loadMapMesh's geometry half ----
BABYLON.OBJFileLoader.USE_LEGACY_BEHAVIOR = true
const obj = fs.readFileSync('public' + map.dir + map.file, 'utf8').replace(/^mtllib.*$/gm, '')
const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
const root = new BABYLON.TransformNode('mapRoot', scene)
res.meshes.forEach(m => { if (!m.parent) m.parent = root })
root.rotation.x = map.rotationX || 0
root.scaling.setAll(map.scale || 1)
root.computeWorldMatrix(true)

const colliders = []
res.meshes.forEach(m => {
	if (m.getTotalVertices && m.getTotalVertices() > 0) {
		m.computeWorldMatrix(true)
		const parts = Math.max(1, Math.ceil((m.getTotalIndices() / 3) / 12))
		if (parts > 1) m.subdivide(parts)
		if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
		m.checkCollisions = true
		colliders.push(m)
	}
})
const occluders = []
colliders.forEach((m, i) => {
	const c = m.clone('occluder_' + i, null)
	c.parent = m.parent
	c.computeWorldMatrix(true)
	const parts = Math.max(1, Math.ceil((c.getTotalIndices() / 3) / 12))
	if (parts > 1) c.subdivide(parts)
	if (c.refreshBoundingInfo) c.refreshBoundingInfo(true)
	c.checkCollisions = false
	c.isPickable = false
	c.setEnabled(false)
	occluders.push(c)
})
console.log(`colliders=${colliders.length} occluders=${occluders.length}`)

// ---- ground truth: every triangle, world space, no culling whatsoever ----
const tris = []
let minY = 1e9, maxY = -1e9
colliders.forEach(m => {
	const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
	const idx = m.getIndices()
	if (!pos || !idx) return
	const wm = m.computeWorldMatrix(true)
	const wpos = new Float64Array(pos.length)
	const v = new BABYLON.Vector3()
	for (let i = 0; i < pos.length; i += 3) {
		BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v)
		wpos[i] = v.x; wpos[i + 1] = v.y; wpos[i + 2] = v.z
		if (v.y < minY) minY = v.y
		if (v.y > maxY) maxY = v.y
	}
	for (let i = 0; i < idx.length; i += 3) {
		tris.push([
			wpos[idx[i] * 3], wpos[idx[i] * 3 + 1], wpos[idx[i] * 3 + 2],
			wpos[idx[i + 1] * 3], wpos[idx[i + 1] * 3 + 1], wpos[idx[i + 1] * 3 + 2],
			wpos[idx[i + 2] * 3], wpos[idx[i + 2] * 3 + 1], wpos[idx[i + 2] * 3 + 2],
		])
	}
})
console.log(`ground-truth triangles: ${tris.length}  worldY ${minY.toFixed(2)}..${maxY.toFixed(2)}`)

const EPS = 1e-9
const bruteNearest = (ox, oy, oz, dx, dy, dz, maxDist) => {
	let best = Infinity
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2]
		const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2]
		const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
		const det = e1x * px + e1y * py + e1z * pz
		if (det > -EPS && det < EPS) continue          // parallel
		const inv = 1 / det
		const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2]
		const u = (tx * px + ty * py + tz * pz) * inv
		if (u < 0 || u > 1) continue
		const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
		const vv = (dx * qx + dy * qy + dz * qz) * inv
		if (vv < 0 || u + vv > 1) continue
		const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
		if (dist > EPS && dist < best) best = dist     // two-sided: winding-agnostic
	}
	return best > maxDist ? Infinity : best
}

// ---- probe rays: spawn point -> spawn point, plus a dense random sweep ----
const spawns = map.SPAWN_POINTS || map.spawns || []
const EYE = 0.6
const cases = []
for (let a = 0; a < spawns.length; a++) {
	for (let b = 0; b < spawns.length; b++) {
		if (a === b) continue
		cases.push({ tag: `spawn${a}->spawn${b}`, o: [spawns[a].x, spawns[a].y + EYE, spawns[a].z], p: [spawns[b].x, spawns[b].y + EYE, spawns[b].z] })
	}
}
const w = map.walkable
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const N = Number(process.argv[3] || 4000)
for (let i = 0; i < N; i++) {
	const pick = () => [w.minX + rnd() * (w.maxX - w.minX), w.minY + rnd() * (w.maxY - w.minY), w.minZ + rnd() * (w.maxZ - w.minZ)]
	cases.push({ tag: `rand${i}`, o: pick(), p: pick() })
}

let checked = 0, phantom = 0, missed = 0
let worstPhantom = null, worstMissed = null
let sumAbs = 0
const missedSamples = []
const phantomSamples = []
for (const c of cases) {
	const dx0 = c.p[0] - c.o[0], dy0 = c.p[1] - c.o[1], dz0 = c.p[2] - c.o[2]
	const len = Math.hypot(dx0, dy0, dz0)
	if (len < 0.5) continue
	const dx = dx0 / len, dy = dy0 / len, dz = dz0 / len
	const maxDist = len
	const ray = new BABYLON.Ray(new BABYLON.Vector3(c.o[0], c.o[1], c.o[2]), new BABYLON.Vector3(dx, dy, dz))
	const got = nearestWorldHit(occluders, ray, maxDist)
	const truth = bruteNearest(c.o[0], c.o[1], c.o[2], dx, dy, dz, maxDist)
	checked++
	const g = Math.min(got, maxDist + 1), t = Math.min(truth, maxDist + 1)
	const diff = Math.abs(g - t)
	sumAbs += Number.isFinite(diff) ? diff : 0
	if (diff > 0.05) {
		const rec = { tag: c.tag, o: c.o, p: c.p, got, truth, diff, len }
		if (g < t) { phantom++; if (phantomSamples.length < 5) phantomSamples.push(rec); if (!worstPhantom || diff > worstPhantom.diff) worstPhantom = rec }
		else { missed++; if (missedSamples.length < 5) missedSamples.push(rec); if (!worstMissed || diff > worstMissed.diff) worstMissed = rec }
	}
}
const fmt = r => `${r.tag} len=${r.len.toFixed(2)} server=${Number.isFinite(r.got) ? r.got.toFixed(3) : 'CLEAR'} truth=${Number.isFinite(r.truth) ? r.truth.toFixed(3) : 'CLEAR'} o=[${r.o.map(n => n.toFixed(2))}] p=[${r.p.map(n => n.toFixed(2))}]`
console.log(`\nrays checked: ${checked}`)
console.log(`  PHANTOM occlusion (server blocks, geometry does not): ${phantom}  ${(100 * phantom / checked).toFixed(2)}%`)
phantomSamples.forEach(r => console.log('    ' + fmt(r)))
console.log(`  MISSED  occlusion (geometry blocks, server does not): ${missed}  ${(100 * missed / checked).toFixed(2)}%`)
missedSamples.forEach(r => console.log('    ' + fmt(r)))
console.log(`  mean |diff| = ${(sumAbs / checked).toFixed(4)} m`)
if (worstPhantom) console.log(`  worst phantom: ${fmt(worstPhantom)}`)
if (worstMissed) console.log(`  worst missed:  ${fmt(worstMissed)}`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
