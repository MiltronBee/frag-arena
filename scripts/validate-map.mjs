// ---------------------------------------------------------------------------
// validate-map.mjs — run probeThisForEachMap.md against an IMPORTED map.
//
// Loads the isolated OBJ from public/assets/maps/<Map>/ the EXACT `_loadMapMesh`
// way (USE_LEGACY_BEHAVIOR, data:, url, rotationX=-PI/2, scale, ~12-tri
// subdivide), then checks the BLOCKER items:
//   - geometry loads (mesh count, tri count)
//   - winding sign resolved (fraction of floor tris with n.y>0 vs <0; |n.y|>=0.7)
//   - walkable AABB derives (deriveViewBox logic) + view box
//   - killY below ALL walkable floor, with margin (probe §3)
//   - spawns drop-probe to floor, headroom (up-probe), rest height (probe §2)
//   - fog: longest sightline noted from the merged/v1 record
//
// Compares against the merged/v1 registry JSON (expected values). Disposes the
// scene/engine at the end.
//
// Usage:  node scripts/validate-map.mjs <MapName>
//         (run from ~/unreal; needs the map already imported into public/)
// ---------------------------------------------------------------------------
import fs from 'fs'
import path from 'path'
import * as BABYLON from '../common/babylon.node.js'
import { OBJFileLoader } from '../common/babylon.node.js'

const SCALE = 0.65
const HOME = process.env.HOME
const ROOT = path.join(HOME, 'unreal')
const REG = path.join(ROOT, '_work/ut-actors/registry')
const MIN_WALK = 0.7
const SPAWN_MIN_HEADROOM = 1.0   // m, world (probe §3)

const name = process.argv[2]
if (!name) { console.error('usage: node scripts/validate-map.mjs <MapName>'); process.exit(2) }

const regId = name.toLowerCase().replaceAll('][', '2').replaceAll('-', '_').replace('_2025', '')
const jp = path.join(REG, regId + '.json')
const rec = fs.existsSync(jp) ? JSON.parse(fs.readFileSync(jp, 'utf8')) : null
const objPath = path.join(ROOT, 'public/assets/maps', name, name + '.obj')
if (!fs.existsSync(objPath)) { console.error('not imported: ' + objPath); process.exit(1) }

const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
let pass = true
const fail = (m) => { pass = false; console.log('  FAIL  ' + m) }
const ok = (m) => console.log('  ok    ' + m)

OBJFileLoader.USE_LEGACY_BEHAVIOR = true
const obj = fs.readFileSync(objPath, 'utf8').replace(/^mtllib.*$/gm, '')
const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
const root = new BABYLON.TransformNode('mapRoot', scene)
res.meshes.forEach(m => { if (!m.parent) m.parent = root })
root.rotation.x = -Math.PI / 2
root.scaling.setAll(SCALE)
root.computeWorldMatrix(true)

const colliders = []
res.meshes.forEach(m => {
	if (m.getTotalVertices && m.getTotalVertices() > 0) {
		m.computeWorldMatrix(true)
		const parts = Math.max(1, Math.ceil((m.getTotalIndices() / 3) / 12))
		if (parts > 1) m.subdivide(parts)
		if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
		m.checkCollisions = true
		m.isPickable = true
		colliders.push(m)
	}
})

console.log(`\n=== validate ${name} ===`)

// 1. geometry loaded
let totTris = 0
colliders.forEach(m => { totTris += m.getTotalIndices() / 3 })
if (colliders.length && totTris > 0) ok(`geometry: ${colliders.length} meshes, ${totTris} tris`)
else fail('geometry: nothing loaded')

// walkable AABB + winding (deriveViewBox logic, |n.y|>=0.7)
const min = { x: Infinity, y: Infinity, z: Infinity }
const max = { x: -Infinity, y: -Infinity, z: -Infinity }
const a = new BABYLON.Vector3(), b = new BABYLON.Vector3(), c = new BABYLON.Vector3(), v = new BABYLON.Vector3()
let up = 0, down = 0, walkTris = 0, lowWalkY = Infinity
for (const m of colliders) {
	const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
	const idx = m.getIndices()
	if (!pos || !idx) continue
	const wm = m.getWorldMatrix()
	const get = (i, out) => { v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); BABYLON.Vector3.TransformCoordinatesToRef(v, wm, out) }
	for (let i = 0; i < idx.length; i += 3) {
		get(idx[i], a); get(idx[i + 1], b); get(idx[i + 2], c)
		const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
		const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
		const len = Math.hypot(nx, ny, nz)
		if (len < 1e-9 || Math.abs(ny / len) < MIN_WALK) continue
		walkTris++
		if (ny > 0) up++; else down++
		for (const p of [a, b, c]) {
			if (p.x < min.x) min.x = p.x; if (p.x > max.x) max.x = p.x
			if (p.y < min.y) min.y = p.y; if (p.y > max.y) max.y = p.y
			if (p.z < min.z) min.z = p.z; if (p.z > max.z) max.z = p.z
			if (p.y < lowWalkY) lowWalkY = p.y
		}
	}
}
if (walkTris > 0) {
	ok(`view box derives: walkable x[${min.x.toFixed(1)},${max.x.toFixed(1)}] y[${min.y.toFixed(1)},${max.y.toFixed(1)}] z[${min.z.toFixed(1)},${max.z.toFixed(1)}] (${walkTris} floor tris)`)
	const sign = up >= down ? '+1' : '-1'
	ok(`winding: floor n.y ${up}(+) / ${down}(-) -> sign ${sign} (|n.y|>=0.7 tested; sign-agnostic in runtime)`)
	if (rec) {
		const w = rec.walkable
		// native-frame comparison
		console.log(`        registry walkable native x[${w.minX},${w.maxX}] y[${w.minY},${w.maxY}] z[${w.minZ},${w.maxZ}]`)
		console.log(`        derived  walkable native x[${(min.x/SCALE).toFixed(1)},${(max.x/SCALE).toFixed(1)}] y[${(min.y/SCALE).toFixed(1)},${(max.y/SCALE).toFixed(1)}] z[${(min.z/SCALE).toFixed(1)},${(max.z/SCALE).toFixed(1)}]`)
	}
} else fail('no walkable floor tris found')

// killY margin (probe §3): lowest walkable world y must be ABOVE kill plane
if (rec && walkTris > 0) {
	const killW = rec.killY * SCALE
	const margin = lowWalkY - killW
	if (margin > 0) ok(`killY: plane ${killW.toFixed(2)}m (native ${rec.killY}); lowest walkable ${lowWalkY.toFixed(2)}m; margin ${margin.toFixed(2)}m`)
	else fail(`killY: kill plane ${killW.toFixed(2)}m is ABOVE lowest walkable ${lowWalkY.toFixed(2)}m — would kill on solid ground`)
	if (margin < 3) console.log('        WARN margin < 3m — a hard-landing tick could dip under')
}

// spawns drop-probe (probe §2/§3): floor hit, headroom, rest
if (rec) {
	const pick = m => m.isPickable && m.getTotalVertices && m.getTotalVertices() > 0
	const dn = (x, y, z, l = 40) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, -1, 0), l), pick)
	const upr = (x, y, z, l = 15) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, 1, 0), l), pick)
	const pts = rec.SPAWN_POINTS || rec.spawns.map(s => ({ ...s, headroom: undefined }))
	let hit = 0, miss = 0, lowHead = 0, minHead = Infinity, inGeom = 0
	for (const s of pts) {
		const wx = s.x * SCALE, wz = s.z * SCALE
		const h = dn(wx, (s.y + 3.0) * SCALE, wz, 60)
		if (!h || !h.hit) { miss++; continue }
		hit++
		const fy = h.pickedPoint.y
		const u = upr(wx, fy + 0.25, wz, 15)
		const head = u && u.hit ? (u.pickedPoint.y - fy - 0.25) : 15
		if (head < minHead) minHead = head
		if (head < SPAWN_MIN_HEADROOM) lowHead++
		// rest: distance from stored native y (scaled) to probed floor
		if (Math.abs(fy - s.y * SCALE) > 2.0) inGeom++  // spawn stored y far from real floor
	}
	const usable = pts.filter(p => p.headroom === undefined || p.headroom >= SPAWN_MIN_HEADROOM).length
	if (hit && miss === 0) ok(`spawns: ${hit}/${pts.length} drop-probe to floor, 0 in void; min headroom ${minHead.toFixed(2)}m; ${usable} usable (headroom>=${SPAWN_MIN_HEADROOM}m)`)
	else if (hit) fail(`spawns: ${miss}/${pts.length} probed into VOID (no floor)`)
	else fail('spawns: none hit floor')
	if (lowHead) console.log(`        note ${lowHead} spawn(s) under ${SPAWN_MIN_HEADROOM}m headroom (runtime spawnPoint() drops these)`)
}

// fog / sightline note (probe §10)
if (rec) {
	const s = rec.derived?.longest_sightline_world_m
	console.log(`  note  longest sightline ${s}m; ${s > 80 ? 'NEEDS a lower per-map fogDensity (Visage-class)' : 'default fog OK (short sightline)'}`)
	console.log(`  note  mega at native (${rec.mega?.x}, ${rec.mega?.y}, ${rec.mega?.z}); killY margin(reg) ${rec.derived?.killY_margin_world_m}m`)
}

console.log(pass ? `\nRESULT ${name}: PASS\n` : `\nRESULT ${name}: FAIL\n`)

// dispose (probe traps: harnesses must dispose)
scene.dispose()
engine.dispose()
process.exit(pass ? 0 : 1)
