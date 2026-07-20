// ONE reconciled map registry — the single runtime source of truth for maps.
//
// Historically there were TWO unreconciled map concepts:
//   1. common/mapMesh.js  — the LIVE mesh-map constant (MAPS.visage / MAPS.grove): an
//      artist-authored OBJ loaded as collision + visual geometry, with spawns/scale/
//      killY/walkable/mega but NO mode data.
//   2. common/maps/       — a DEAD box-arena registry (facingWorlds/curse/sesmar/rook)
//      that carried the aspirational MODE schema (mode, mode_data.flags/controlPoints,
//      team-tagged SPAWN_POINTS) but only box-arena geometry.
//
// This module merges those into ONE canonical per-map RECORD, shaped like the
// `merged/v1` schema the UT extraction already emits (_work/ut-actors/registry/*.json).
// One record serves BOTH the mesh-map loader (server GameInstance + client renderer)
// AND future mode code (teams / flags / control points), so the mode layer never has to
// reconcile two shapes again.
//
// The LIVE maps (CTF-Visage default, DM-W-Grove) are brought in below with their
// CURRENT, WORKING values copied verbatim from the shipped common/mapMesh.js — spawns,
// killY, walkable, mega bridge-apex, scale, rotation. Do NOT "improve" these from the
// merged/v1 JSON: those files carry a DIFFERENT (re-extracted) spawn set and a slightly
// different walkable box; the numbers here are the ones the live game is calibrated on
// and MUST stay byte-identical (verified by golden-collision + verify-meshmap).
//
// The other 10 extracted maps drop in later WITHOUT touching any consumer: adapt their
// merged/v1 JSON with fromMergedV1() and registerMap() (see bottom). Box arenas stay in
// common/maps for the golden-collision harness; fromBoxArena() adapts one into a record
// for a future unified listing, but common/maps is deliberately NOT imported here (that
// would pull dead arena data into the client bundle).

export const REGISTRY_SCHEMA = 'runtime/v1'

// Canonical per-map RECORD. Fields:
//   id         unique key (also the selection token)
//   name       display name
//   mode       'CTF' | 'DM' | 'DOM' | ...  (mode code keys off this later)
//   useMeshMap true  = artist OBJ is the world (real floors, fall-death, killY);
//              false = analytic box arena (setupObstacles, plane floor at GROUND_Y=0)
//   -- mesh-map loader fields (present when useMeshMap) --
//   dir/file/lights   asset paths under public/
//   scale/rotationX/yOffset   world transform of the native (ROTX=-90) OBJ
//   killY      fall below this NATIVE y = death (server scales by `scale`)
//   spawns     FFA spawn list in NATIVE units [{x,y,z}]
//   walkable   native-unit AABB of the floor (boot-window view-box fallback)
//   mega       native-unit walkable point under the mega-health pickup
//   -- mode / future fields (inert until the mode layer reads them) --
//   mode_data  { flags?, controlPoints?, ... } — schema from common/maps + merged/v1
//   SPAWN_POINTS  team-tagged spawns [{x,y,z,team,yaw}] (merged/v1) — optional
//   nav        { file } baked ReachSpec graph basename (navGraph derives it from
//              dir/file, so this is documentation only)
//
// `mesh()` normalizes a hand-authored mesh-map record: fills the invariant defaults so
// each entry only states what is map-specific.
const mesh = (r) => ({
	schema: REGISTRY_SCHEMA,
	useMeshMap: true,
	yOffset: 0,
	rotationX: -Math.PI / 2, // OBJ is Z-up; rotate -90° about X -> Y-up (floors flat)
	scale: 0.65,             // ONE shared scale so the player is the same size everywhere
	mode_data: {},
	...r,
})

// ---------------------------------------------------------------------------
// LIVE MESH MAPS — current working values, copied verbatim from common/mapMesh.js.
// ---------------------------------------------------------------------------
const visage = mesh({
	id: 'visage',
	name: 'CTF-Visage',
	mode: 'CTF',
	// CTF-Visage = the classic CTF-Face (Facing Worlds), renamed to dodge Epic
	// trademarks. Two towers + a central bridge, floating in the void: walk off = death.
	dir: '/assets/maps/CTF-Visage/',
	file: 'CTF-Visage.obj',
	lights: 'CTF-Visage.lights.json',
	killY: -65, // main deck sits at native y~-37; below -65 = fell into the void
	// FFA spawns from the ROTX=-90 dense drop-probe (scripts/probe-visage.ts).
	spawns: [
		{ x: -40.2, z: 4.6, y: -37.3 }, { x: -40.2, z: 31.3, y: -37.3 },
		{ x: -10.9, z: -22.1, y: -37.3 }, { x: 3.8, z: -8.7, y: -37.3 },
		{ x: 3.8, z: 17.9, y: -37.1 }, { x: 91.9, z: -8.7, y: -36.7 },
		{ x: 106.5, z: -22.1, y: -36.7 }, { x: 121.2, z: 17.9, y: -36.7 }
	],
	// 2126 near-horizontal tris => the east deck reaches world x=+102 (what the old
	// ±64 origin view box was cutting in half).
	walkable: { minX: -54.5, minY: -87.9, minZ: -42.1, maxX: 157.3, maxY: 24.9, maxZ: 37.5 },
	// APEX of the central bridge — the Facing-Worlds power position.
	mega: { x: 52.308, y: -27.446, z: -3.077 },
	// CTF flag stands (native units, already live-validated — see the merged/v1
	// extraction). INERT until the mode layer reads it; carried here so the future CTF
	// mode needs no separate lookup.
	mode_data: {
		flags: [
			{ team: 0, x: 123.599, y: -37.28, z: 8.356, yaw: 182.81 },
			{ team: 1, x: -19.306, y: -37.508, z: -11.28, yaw: 184.88 }
		]
	},
	// --- UT-EXTRACTED SPAWN POINTS (20, native units) — from _work/ut-actors/registry/ctf_visage.json.
	// Team-tagged + yaw + headroom(m). spawnPoint() drop-probes these to the floor. All 20 keep
	// headroom 15 so none are dropped. Carried alongside the legacy 8 `spawns` (kept for the view box).
	SPAWN_POINTS: [
		{ x: 130.214, y: -38.45, z: -26.274, yaw: 179.52, team: 0, headroom: 15 },
		{ x: -30.855, y: -39, z: 21.346, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -32.131, y: -39, z: -22.069, yaw: 352.09, team: 1, headroom: 15 },
		{ x: 130.957, y: -38.45, z: 17.674, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 117.755, y: -38.45, z: 20.179, yaw: 193.27, team: 0, headroom: 15 },
		{ x: -23.692, y: -39, z: -25.517, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -33.807, y: -39, z: 22.698, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -25.921, y: -39, z: 25.061, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -21.673, y: -39, z: 22.775, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -24.416, y: -39, z: 21.213, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -31.007, y: -39, z: -20.05, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -30.34, y: -39, z: -24.927, yaw: 352.09, team: 1, headroom: 15 },
		{ x: -24.816, y: -39, z: -22.469, yaw: 352.09, team: 1, headroom: 15 },
		{ x: 137.396, y: -38.45, z: -25.455, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 133.529, y: -38.45, z: -25.15, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 122.709, y: -38.45, z: -24.75, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 126.9, y: -38.45, z: -30.16, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 129.357, y: -38.45, z: 21.313, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 125.033, y: -38.45, z: 17.922, yaw: 179.52, team: 0, headroom: 15 },
		{ x: 121.718, y: -38.45, z: 22.532, yaw: 179.52, team: 0, headroom: 15 },
	],
	// --- UT-EXTRACTED PICKUPS (native units). item→weapon/effect mapping lives in common/pickupConfig.js
	// (tunable). server/setupPickups.js drop-probes each to the floor and spawns a Pickup entity.
	PICKUPS: {
		weapon: [
			{ x: 131.329, y: -38.193, z: 2.622, item: 'rocket_launcher' },
			{ x: 123.386, y: -38.269, z: -14.794, item: 'shock_rifle' },
			{ x: 113.235, y: -8.799, z: -2.321, item: 'sniper_rifle', yaw: 0 },
			{ x: 119.477, y: 20.385, z: -3.247, item: 'sniper_rifle', yaw: 0 },
			{ x: -16.265, y: 19.814, z: -0.005, item: 'sniper_rifle', yaw: 0 },
			{ x: -10.438, y: -9.409, z: -1.079, item: 'sniper_rifle', yaw: 0 },
			{ x: -27.613, y: -38.67, z: -5.513, item: 'rocket_launcher' },
			{ x: -19.468, y: -38.86, z: 11.573, item: 'shock_rifle' },
			{ x: -4.448, y: -18.858, z: 0.035, item: 'redeemer' },
			{ x: 108.45, y: -18.572, z: -3.202, item: 'redeemer' },
			{ x: 132.556, y: -38.291, z: 12.73, item: 'sniper_rifle', yaw: 0 },
			{ x: 132.53, y: -38.31, z: -19.575, item: 'ripper' },
			{ x: -28.646, y: -38.861, z: -16.573, item: 'ripper' },
			{ x: -28.174, y: -38.841, z: 16.084, item: 'sniper_rifle', yaw: 0 },
		],
		ammo: [
			{ x: 130.676, y: -38.155, z: 3.584, item: 'rockets', yaw: 286.35 },
			{ x: 132.737, y: -38.155, z: 1.687, item: 'rockets', yaw: 41.53 },
			{ x: 124.715, y: -38.003, z: -14.757, item: 'shock_core', yaw: 295.22 },
			{ x: 121.981, y: -38.003, z: -14.727, item: 'shock_core' },
			{ x: 117.095, y: -26.135, z: -1.806, item: 'rockets', yaw: 58.27 },
			{ x: 117.052, y: -26.135, z: -4.981, item: 'rockets', yaw: 279.49 },
			{ x: 110.521, y: -9.199, z: -3.356, item: 'bullets', yaw: 44.82 },
			{ x: 123.088, y: 20.157, z: -6.176, item: 'bullets', yaw: 46.36 },
			{ x: 126.219, y: 20.157, z: 0.421, item: 'bullets', yaw: 336.97 },
			{ x: 127.373, y: 20.157, z: 0.319, item: 'bullets', yaw: 38.19 },
			{ x: -9.044, y: -9.656, z: -0.051, item: 'bullets' },
			{ x: -21.475, y: 19.699, z: -4.297, item: 'bullets' },
			{ x: -22.415, y: 19.7, z: -4.11, item: 'bullets', yaw: 30.5 },
			{ x: -20.235, y: 19.699, z: 3.13, item: 'bullets', yaw: 328.89 },
			{ x: -13.63, y: -26.592, z: -1.223, item: 'rockets', yaw: 66.4 },
			{ x: -13.72, y: -26.592, z: 1.325, item: 'rockets', yaw: 325.42 },
			{ x: -28.503, y: -38.672, z: -4.634, item: 'rockets' },
			{ x: -26.334, y: -38.727, z: -6.688, item: 'rockets' },
			{ x: -20.71, y: -38.593, z: 11.579, item: 'shock_core' },
			{ x: -18.243, y: -38.593, z: 11.595, item: 'shock_core' },
			{ x: -8.798, y: -9.561, z: -2.876, item: 'bullets' },
			{ x: -8.917, y: -9.561, z: 3.056, item: 'bullets' },
			{ x: -5.934, y: -9.561, z: 2.799, item: 'bullets', yaw: 321.81 },
			{ x: -6.179, y: -9.561, z: -2.985, item: 'bullets', yaw: 44.3 },
			{ x: -7.742, y: -19.315, z: -2.137, item: 'bullets' },
			{ x: -7.715, y: -19.315, z: 2.001, item: 'bullets' },
			{ x: 112.619, y: -9.104, z: -6.045, item: 'bullets' },
			{ x: 109.589, y: -9.104, z: -6.107, item: 'bullets', yaw: 281.51 },
			{ x: 112.644, y: -9.104, z: -0.358, item: 'bullets', yaw: 294.43 },
		],
		health: [
			{ x: 119.467, y: -38.27, z: -11.621, item: 'health_pack' },
			{ x: 119.523, y: -38.27, z: -9.878, item: 'health_pack' },
			{ x: 119.285, y: -38.289, z: 3.062, item: 'health_pack' },
			{ x: 119.321, y: -38.289, z: 4.805, item: 'health_pack' },
			{ x: 50.921, y: -26.978, z: -3.135, item: 'health_pack', yaw: 352.18 },
			{ x: -15.434, y: -38.86, z: 8.452, item: 'health_pack' },
			{ x: -15.439, y: -38.86, z: 6.949, item: 'health_pack' },
			{ x: -15.224, y: -38.86, z: -6.146, item: 'health_pack' },
			{ x: -15.229, y: -38.86, z: -7.649, item: 'health_pack' },
		],
		// armor + powerup are v1-DEFERRED grants (no armor stat / no UDamage mechanic and
		// no bespoke asset). They ARE placed + rendered (cyan placeholder box) so the map
		// reads correctly and the positions are validated for the fast-follow.
		armor: [
			{ x: 126.303, y: 20.557, z: -5.869, item: 'body_armor', yaw: 89.56 },
			{ x: -23.297, y: 20.081, z: 3.012, item: 'body_armor', yaw: 269.91 },
		],
		powerup: [
			{ x: 117.238, y: -25.373, z: -3.422, item: 'damage_amplifier' },
			{ x: -12.81, y: -26.249, z: -0.016, item: 'damage_amplifier' },
		],
	},
})

const grove = mesh({
	id: 'grove',
	name: 'DM-W-Grove',
	mode: 'DM',
	// DM-W-Grove-2025: spawn/scale/killY calibrated against this geometry (10697 faces).
	dir: '/assets/maps/DM-W-Grove/',
	file: 'DM-W-Grove-2025.obj',
	lights: 'DM-W-Grove-2025.lights.json',
	killY: -15, // fall below this native-y = death (below map bottom ~-5)
	spawns: [
		{ x: -17.3, z: -30.2, y: 13.9 }, { x: -17.3, z: -17.9, y: 15.7 },
		{ x: -5.3, z: 19.2, y: 15.7 }, { x: 6.7, z: 19.2, y: 15.7 },
		{ x: 18.7, z: 6.8, y: 15.7 }, { x: -29.3, z: -5.5, y: 16.3 },
		{ x: -5.3, z: -5.5, y: 18.8 }, { x: 6.7, z: -5.5, y: 18.8 }
	],
	// Grove's OBJ winding is INVERTED (floors read normal.y = -1.000), which is why the
	// extraction tests |normal.y|, not normal.y.
	walkable: { minX: -35.4, minY: -4.9, minZ: -48.8, maxX: 48.8, maxY: 35.1, maxZ: 37.7 },
	mega: { x: -5.300, y: 17.069, z: 5.269 }
})

// The runtime registry. Add mesh maps here (or via registerMap at boot); the DEFAULT is
// CTF-Visage so a no-argument GameInstance / client behaves exactly as the live game.
export const mapRecords = { visage, grove }
export const DEFAULT_MAP_ID = 'visage'
export const mapList = () => Object.values(mapRecords)

// Resolve a map ARGUMENT (id string | record object) to a canonical record.
export function getMapRecord(idOrRecord) {
	if (idOrRecord && typeof idOrRecord === 'object') return idOrRecord // already a record
	const id = idOrRecord == null ? DEFAULT_MAP_ID : idOrRecord
	const rec = mapRecords[id]
	if (!rec) throw new Error(`unknown map '${id}' (have: ${Object.keys(mapRecords).join(', ')})`)
	return rec
}

// Register a map record at runtime (idempotent by id). This is the ONLY thing the other
// 10 extracted maps need to become selectable — no consumer edit.
export function registerMap(record) {
	if (!record || !record.id) throw new Error('registerMap: record needs an id')
	mapRecords[record.id] = record
	return record
}

// ---------------------------------------------------------------------------
// ADAPTERS — normalize the two upstream shapes into a canonical record.
// ---------------------------------------------------------------------------

// merged/v1 (the UT extraction, _work/ut-actors/registry/*.json) -> runtime record.
// This is how the other 10 mesh maps drop in: `registerMap(fromMergedV1(json))`. Every
// merged/v1 field the runtime needs is present in that schema already; `overrides` lets
// a caller pin the live-validated spawns/walkable/mega if they were hand-tuned (as
// Visage's were) instead of taken from the re-extracted numbers.
export function fromMergedV1(json, overrides = {}) {
	return mesh({
		id: json.id,
		name: json.name,
		mode: json.mode,
		dir: json.dir,
		file: json.file,
		lights: json.lights,
		scale: json.scale,
		rotationX: json.rotationX,
		yOffset: json.yOffset,
		killY: json.killY,
		spawns: json.spawns,
		walkable: json.walkable,
		mega: json.mega,
		mode_data: json.mode_data || {},
		// carried through for the future mode layer (inert now):
		SPAWN_POINTS: json.SPAWN_POINTS,
		PICKUPS: json.PICKUPS,
		TELEPORTERS: json.TELEPORTERS,
		...overrides,
	})
}

// common/maps box-arena module -> useMeshMap:false runtime record. Box arenas have NO
// OBJ, so the mesh-loader fields are absent; the analytic setupObstacles path reads
// OBSTACLE_SPECS. Provided so a caller CAN build one unified listing; common/maps is
// intentionally not imported here (it stays the source the golden harness consumes).
export function fromBoxArena(boxMap) {
	return {
		schema: REGISTRY_SCHEMA,
		useMeshMap: false,
		id: boxMap.id,
		name: boxMap.name,
		mode: boxMap.mode,
		ARENA_SIZE: boxMap.ARENA_SIZE,
		SPAWN_POINTS: boxMap.SPAWN_POINTS,
		JUMP_PADS: boxMap.JUMP_PADS,
		OBSTACLE_SPECS: boxMap.OBSTACLE_SPECS,
		mode_data: boxMap.mode_data || {},
	}
}
