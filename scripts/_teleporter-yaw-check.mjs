// Empirical validation of the UT-yaw-degrees -> world-yaw conversion used by
// common/teleporterData.js (utYawToWorldYaw). Nothing in the runtime consumed
// actor yaw before teleporters (spawnPoint returns p.yaw but nobody reads it),
// so the convention was UNVALIDATED — this script settles it against geometry.
//
// Method (pattern: scripts/extract-map.mjs — NullEngine + OBJ + pickWithRay):
// for every FUNCTIONAL portal exit that carries a UT yaw, drop-probe the exit
// to the floor, then cast a horizontal ray from head height (+1.2m) along the
// exit direction under each of the 8 sensible sign/offset conversions
//   w = s*θ + k*90°,  s ∈ {+1,-1}, k ∈ {0,1,2,3}   (θ = UT yaw in radians)
// with world dir = (sin w, 0, cos w). A correct convention faces INTO open
// space, so score each candidate by MEAN CLEARANCE (capped at 10m) across all
// yaw-carrying exits of all 4 teleporter maps. Run:
//   node scripts/_teleporter-yaw-check.mjs
import fs from 'fs'
import path from 'path'
import * as BABYLON from '../common/babylon.node.js'
import { OBJFileLoader } from '../common/babylon.node.js'
import { mapRecords } from '../common/mapRegistry.js'

const ROOT = path.join(process.env.HOME, 'unreal')
const CAP = 10 // clearance cap (m): beyond this "more open" carries no signal
const MAPS = ['visage', 'grove', 'dm_gantry162', 'dom_elder']

const CANDIDATES = []
for (const s of [1, -1]) for (const k of [0, 1, 2, 3]) {
	CANDIDATES.push({ s, k, label: `${s === 1 ? 'θ' : '-θ'}${k ? `+${k * 90}°` : ''}` })
}
const toWorld = (utDeg, c) => (c.s * utDeg + c.k * 90) * Math.PI / 180

async function loadMap(rec) {
	OBJFileLoader.USE_LEGACY_BEHAVIOR = true
	const engine = new BABYLON.NullEngine()
	const scene = new BABYLON.Scene(engine)
	const obj = fs.readFileSync(path.join(ROOT, 'public' + rec.dir + rec.file), 'utf8').replace(/^mtllib.*$/gm, '')
	const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
	const root = new BABYLON.TransformNode('r', scene)
	res.meshes.forEach(m => { if (!m.parent) m.parent = root })
	root.rotation.x = rec.rotationX || -Math.PI / 2
	root.scaling.setAll(rec.scale || 1)
	root.computeWorldMatrix(true)
	res.meshes.forEach(m => {
		if (m.getTotalVertices && m.getTotalVertices() > 0) {
			m.computeWorldMatrix(true)
			if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
			m.isPickable = true
		}
	})
	const pick = m => m.isPickable && m.getTotalVertices && m.getTotalVertices() > 0
	return {
		scene, engine,
		down: (x, y, z, l = 60) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, -1, 0), l), pick),
		ray: (x, y, z, dx, dz, l = CAP) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(dx, 0, dz), l), pick),
	}
}

// gather every yaw-carrying functional exit: sender T (has url) -> receiver D
// (D.tag == T.url, case-insensitive) with a D.yaw. Raw record data on purpose —
// this script VALIDATES teleporterData's conversion, so it must not use it.
const exits = [] // { mapId, tag, x, z, floorY (world), utYaw }
const scenes = {}
for (const id of MAPS) {
	const rec = mapRecords[id]
	const list = rec.TELEPORTERS || []
	const s = rec.scale || 1
	const byTag = new Map()
	for (const t of list) { const k = String(t.tag || '').toLowerCase(); if (k && !byTag.has(k)) byTag.set(k, t) }
	const wanted = []
	for (const t of list) {
		if (!t.url) continue
		const d = byTag.get(String(t.url).toLowerCase())
		if (!d || d === t || d.yaw === undefined || d.yaw === null) continue
		wanted.push({ tag: `${t.tag}->${d.tag}`, x: d.x * s, z: d.z * s, ny: d.y, utYaw: d.yaw })
	}
	if (!wanted.length) { console.log(`${id}: no yaw-carrying exits`); continue }
	const world = await loadMap(rec)
	scenes[id] = world
	for (const w of wanted) {
		const h = world.down(w.x, (w.ny + 3) * s, w.z)
		const floorY = h && h.hit ? h.pickedPoint.y : w.ny * s
		exits.push({ mapId: id, tag: w.tag, x: w.x, z: w.z, floorY, utYaw: w.utYaw, probed: !!(h && h.hit) })
	}
	console.log(`${id}: ${wanted.length} yaw-carrying exits`)
}

if (!exits.length) { console.error('no yaw-carrying exits anywhere — nothing to validate'); process.exit(1) }

// score every candidate
const rows = []
for (const c of CANDIDATES) {
	let sum = 0
	const per = []
	for (const e of exits) {
		const w = toWorld(e.utYaw, c)
		const dx = Math.sin(w), dz = Math.cos(w)
		const hit = scenes[e.mapId].ray(e.x, e.floorY + 1.2, e.z, dx, dz, CAP)
		const clear = hit && hit.hit ? Math.min(hit.distance, CAP) : CAP
		sum += clear
		per.push(clear)
	}
	rows.push({ label: c.label, mean: sum / exits.length, per, c })
}
rows.sort((a, b) => b.mean - a.mean)

console.log(`\n${exits.length} yaw-carrying exits (clearance capped at ${CAP}m):`)
console.log('candidate      mean-clearance  per-exit')
for (const r of rows) {
	console.log(`${r.label.padEnd(14)} ${r.mean.toFixed(2).padStart(6)}m         [${r.per.map(v => v.toFixed(1)).join(', ')}]`)
}
const [best, second] = rows
console.log(`\nexits: ${exits.map(e => `${e.mapId}:${e.tag}${e.probed ? '' : '(probe MISS)'}`).join(', ')}`)
const decisive = best.mean - second.mean > 0.75
console.log(`\nWINNER: w = ${best.label}  (mean ${best.mean.toFixed(2)}m vs runner-up ${second.label} ${second.mean.toFixed(2)}m)`
	+ (decisive ? '' : '  — NOT DECISIVE (<0.75m margin): fall back to null facing'))
for (const id of Object.keys(scenes)) { scenes[id].scene.dispose(); scenes[id].engine.dispose() }
process.exit(0)
