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
	}
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
