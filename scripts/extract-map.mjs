// ---------------------------------------------------------------------------
// extract-map.mjs — build a merged/v1 registry record for a map that was NOT in
// the original 12-pick registry (e.g. a newly-chosen popular map like DM-Morpheus
// / our DM-Somnus). Mirrors _work/ut-actors/make_registry.py's derivation so the
// output drops straight into fromMergedV1 / the import pipeline.
//
// Reuses the pre-baked nav-gated geometry (_geometry.json / _geometry2.json cover
// 76/68 maps incl. the remaining picks) for killY + walkable so we do NOT
// re-implement nav-gating; drop-probes the spawns + mega here (the part probe13
// did only for the 12).
//
// Writes: _work/ut-actors/registry/<id>.json  (does NOT touch the shared _probe*.json)
//
// Usage:  node scripts/extract-map.mjs <MapName> [mode]
//         mode defaults to the actors.json mode; pass e.g. FFA to tag the slot.
// ---------------------------------------------------------------------------
import fs from 'fs'
import path from 'path'
import * as BABYLON from '../common/babylon.node.js'
import { OBJFileLoader } from '../common/babylon.node.js'

const SCALE = 0.65
const HEADROOM_MIN = 1.3
const HOME = process.env.HOME
const ROOT = path.join(HOME, 'unreal')
const D = path.join(ROOT, '_work/ut-actors')
const G = path.join(ROOT, 'maps/improved')
const REG = path.join(D, 'registry')

const name = process.argv[2]
if (!name) { console.error('usage: node scripts/extract-map.mjs <MapName> [mode]'); process.exit(2) }
const act = JSON.parse(fs.readFileSync(path.join(D, name + '.actors.json'), 'utf8'))
const mode = process.argv[3] || act.mode
const g1 = JSON.parse(fs.readFileSync(path.join(D, '_geometry.json'), 'utf8'))[name]
const g2 = JSON.parse(fs.readFileSync(path.join(D, '_geometry2.json'), 'utf8'))[name]
const cap = JSON.parse(fs.readFileSync(path.join(D, '_capacity.json'), 'utf8'))[name]
const am = JSON.parse(fs.readFileSync(path.join(D, '_analysis.json'), 'utf8')).find(x => x.name === name)
if (!g1 || !g2) { console.error('no pre-baked geometry for ' + name + ' (need _geometry/_geometry2)'); process.exit(1) }

const regId = name.toLowerCase().replaceAll('][', '2').replaceAll('-', '_').replace('_2025', '')

// --- load mesh the _loadMapMesh way ---
const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
OBJFileLoader.USE_LEGACY_BEHAVIOR = true
const obj = fs.readFileSync(path.join(G, name + '.obj'), 'utf8').replace(/^mtllib.*$/gm, '')
const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
const root = new BABYLON.TransformNode('r', scene)
res.meshes.forEach(m => { if (!m.parent) m.parent = root })
root.rotation.x = -Math.PI / 2; root.scaling.setAll(SCALE); root.computeWorldMatrix(true)
res.meshes.forEach(m => { if (m.getTotalVertices && m.getTotalVertices() > 0) { m.computeWorldMatrix(true); if (m.refreshBoundingInfo) m.refreshBoundingInfo(true); m.isPickable = true } })
const pick = m => m.isPickable && m.getTotalVertices && m.getTotalVertices() > 0
const dn = (x, y, z, l = 60) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, -1, 0), l), pick)
const upr = (x, y, z, l = 20) => scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, 1, 0), l), pick)

// --- drop-probe spawns -> floor_native_y + headroom ---
const probed = act.SPAWN_POINTS.map((s, i) => {
	const wx = s.x * SCALE, wz = s.z * SCALE
	const h = dn(wx, (s.y + 3.0) * SCALE, wz, 60)
	if (!h || !h.hit) return { i, ok: false }
	const fy = h.pickedPoint.y
	const u = upr(wx, fy + 0.25, wz, 15)
	return { i, ok: true, floor_native_y: +(fy / SCALE).toFixed(3), headroom: u && u.hit ? +(u.pickedPoint.y - fy - 0.25).toFixed(2) : 15, src: s }
})
const keep = probed.filter(p => p.ok && p.headroom >= HEADROOM_MIN)
const dropped = probed.filter(p => p.ok && p.headroom < HEADROOM_MIN).map(p => ({ index: p.i, headroom: p.headroom }))

// --- 2-means team split (port of make_registry.two_means); cosmetic for FFA ---
function twoMeans(pts) {
	if (pts.length < 2) return pts.map(() => 0)
	let best = [-1, 0, 1]
	for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
		const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2
		if (d > best[0]) best = [d, i, j]
	}
	const c = [pts[best[1]].slice(), pts[best[2]].slice()]
	const lab = pts.map(() => 0)
	for (let it = 0; it < 60; it++) {
		for (let k = 0; k < pts.length; k++) {
			const d0 = (pts[k][0] - c[0][0]) ** 2 + (pts[k][1] - c[0][1]) ** 2
			const d1 = (pts[k][0] - c[1][0]) ** 2 + (pts[k][1] - c[1][1]) ** 2
			lab[k] = d0 <= d1 ? 0 : 1
		}
		for (const t of [0, 1]) {
			const mem = pts.filter((_, k) => lab[k] === t)
			if (mem.length) c[t] = [mem.reduce((a, m) => a + m[0], 0) / mem.length, mem.reduce((a, m) => a + m[1], 0) / mem.length]
		}
	}
	return lab
}
const kpts = keep.map(p => [p.src.x, p.src.z])
const labels = twoMeans(kpts)
const spawns = keep.map((p, k) => ({
	x: +p.src.x.toFixed(3), y: p.floor_native_y, z: +p.src.z.toFixed(3),
	yaw: p.src.yaw ?? null, team: labels[k], team_source: 'derived_2means', headroom: p.headroom
}))

// --- mega: drop-probe the UDamage powerup, else a spawn-centroid contested point ---
let mega = null, megaSrc = null
const pu = (act.PICKUPS.powerup || [])[0]
if (pu) {
	const h = dn(pu.x * SCALE, (pu.y + 3.0) * SCALE, pu.z * SCALE, 80)
	if (h && h.hit) { mega = { x: +pu.x.toFixed(3), y: +(h.pickedPoint.y / SCALE).toFixed(3), z: +pu.z.toFixed(3) }; megaSrc = 'extracted ' + (pu.item || pu.class) + ' powerup actor, drop-probed to floor' }
}
if (!mega && spawns.length) {
	const cx = spawns.reduce((a, s) => a + s.x, 0) / spawns.length, cz = spawns.reduce((a, s) => a + s.z, 0) / spawns.length
	const h = dn(cx * SCALE, (g1.walk_native.maxY + 5) * SCALE, cz * SCALE, 120)
	if (h && h.hit) { mega = { x: +cx.toFixed(3), y: +(h.pickedPoint.y / SCALE).toFixed(3), z: +cz.toFixed(3) }; megaSrc = 'spawn-centroid drop-probe (no powerup actor)' }
}

// --- longest sightline: pairwise ray between kept spawns, unobstructed length ---
let sight = 0, spair = null
const S = keep.map(p => ({ x: p.src.x * SCALE, y: (p.floor_native_y + 1.5) * SCALE, z: p.src.z * SCALE, i: p.i }))
for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
	const dx = S[j].x - S[i].x, dy = S[j].y - S[i].y, dz = S[j].z - S[i].z
	const d = Math.hypot(dx, dy, dz)
	const dir = new BABYLON.Vector3(dx / d, dy / d, dz / d)
	const hit = scene.pickWithRay(new BABYLON.Ray(new BABYLON.Vector3(S[i].x, S[i].y, S[i].z), dir, d - 0.5), pick)
	if ((!hit || !hit.hit) && d > sight) { sight = d; spair = [S[i].i, S[j].i] }
}

// --- killY + walkable from the nav-gated geometry (make_registry rule) ---
const low = g2.lowest_walk_y
const killY = Math.floor((low - 15) / 5) * 5
const wb = g1.walk_native
const fl = (v) => Math.floor(v * 10) / 10, ce = (v) => Math.ceil(v * 10) / 10
const walkable = { minX: fl(wb.minX), maxX: ce(wb.maxX), minY: fl(Math.min(wb.minY, killY)), maxY: ce(wb.maxY), minZ: fl(wb.minZ), maxZ: ce(wb.maxZ) }

const md = {}
if (mode === 'TDM' || mode === 'FFA' || mode === 'DM') md.teams = mode === 'FFA' ? 0 : 2

const record = {
	id: regId, name, source_map: act.source_map, mode, schema: 'merged/v1', space: act.space,
	dir: `/assets/maps/${name}/`, file: `${name}.obj`, lights: `${name}.lights.json`,
	obj: `public/assets/maps/${name}/${name}.obj`,
	scale: SCALE, rotationX: -Math.PI / 2, yOffset: 0, killY,
	walkable, mega,
	spawns: spawns.map(s => ({ x: s.x, y: s.y, z: s.z })),
	SPAWN_POINTS: spawns, mode_data: md,
	JUMP_PADS: act.JUMP_PADS || [], TELEPORTERS: act.TELEPORTERS || [], PICKUPS: act.PICKUPS,
	derived: {
		mega_source: megaSrc,
		killY_margin_native: +(low - killY).toFixed(2), killY_margin_world_m: +((low - killY) * SCALE).toFixed(2),
		lowest_reachable_floor_native_y: low, floor_normal_sign: g1.winding_sign,
		walkable_area_world_m2_reachable: g2.walk_area_world_m2, walkable_area_world_m2_raw: g1.walk_area_world_m2,
		vertical_extent_world_m: g2.vert_extent_world, longest_sightline_world_m: +sight.toFixed(1),
		longest_sightline_pair: spair, steepest_walkable_normal_y: g1.steepest_walkable,
		triangles_total: g1.tris_total, nav_nodes: am?.nav_nodes, nav_edges: am?.nav_edges,
		graph_diameter_world_m: am?.path_diam, cross_time_s: am?.cross_time,
		spawns_extracted: act.SPAWN_POINTS.length, spawns_kept: spawns.length, spawns_dropped_low_headroom: dropped,
		players: cap ? { min: cap.min, ideal: cap.ideal, max: cap.max, m2_per_player_at_ideal: cap.m2_per_player, weapons_per_player: cap.w_per, health_per_player: cap.h_per } : null,
		pickup_counts: { weapon: (act.PICKUPS.weapon || []).length, ammo: (act.PICKUPS.ammo || []).length, health: (act.PICKUPS.health || []).length, armor: (act.PICKUPS.armor || []).length, powerup: (act.PICKUPS.powerup || []).length },
		extracted_by: 'scripts/extract-map.mjs',
	}
}

fs.mkdirSync(REG, { recursive: true })
fs.writeFileSync(path.join(REG, regId + '.json'), JSON.stringify(record, null, 1))
console.log(`extracted ${name} -> registry/${regId}.json`)
console.log(`  mode=${mode} killY=${killY} (margin ${record.derived.killY_margin_world_m}m) spawns ${spawns.length}/${act.SPAWN_POINTS.length} kept${dropped.length ? ' (dropped ' + dropped.length + ' low-headroom)' : ''}`)
console.log(`  walkable native x[${walkable.minX},${walkable.maxX}] y[${walkable.minY},${walkable.maxY}] z[${walkable.minZ},${walkable.maxZ}]`)
console.log(`  mega ${mega ? `(${mega.x},${mega.y},${mega.z}) [${megaSrc}]` : 'NONE'}  sightline ${sight.toFixed(1)}m  winding ${g1.winding_sign}  steepest ${g1.steepest_walkable}`)
scene.dispose(); engine.dispose()
