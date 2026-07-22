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
//   TELEPORTERS   native-unit UT teleporter actors [{x,y,z,class,yaw?,tag,url?}],
//              tag/url paired (T.url names the destination's tag); consumed
//              server-side (server/teleporters.js) + client visuals via
//              common/teleporterData.js — optional
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
	// --- UT-EXTRACTED TELEPORTERS (12, native units) — copied verbatim from
	// _work/ut-actors/CTF-Visage.actors.json (key TELEPORTERS). 6 bidirectional pairs.
	TELEPORTERS: [
		{ x: 127.629, z: -15.363, y: -37.374, class: 'Teleporter', yaw: 178.95, tag: 'icihomie2', url: 'icihomie1', nav_id: 78 },
		{ x: 114.75, z: -3.259, y: -8.532, class: 'Teleporter', yaw: 180.66, tag: 'icihomie1', url: 'icihomie2', nav_id: 79 },
		{ x: 111.522, z: -3.211, y: -18.038, class: 'Teleporter', yaw: 181.45, tag: 'peepee2', url: 'peepee1', nav_id: 80 },
		{ x: 119.203, z: -15.37, y: -37.793, class: 'Teleporter', tag: 'peepee1', url: 'peepee2', nav_id: 81 },
		{ x: -7.805, z: 0.069, y: -18.724, class: 'Teleporter', tag: 'fiona1', url: 'fiona2', nav_id: 82 },
		{ x: -15.218, z: 12.195, y: -38.003, class: 'Teleporter', yaw: 180.44, tag: 'fiona2', url: 'fiona1', nav_id: 83 },
		{ x: -23.693, z: 12.091, y: -38.041, class: 'Teleporter', tag: 'apple1', url: 'apple2', nav_id: 84 },
		{ x: -11.221, z: 0.09, y: -8.856, class: 'Teleporter', tag: 'apple2', url: 'apple1', nav_id: 85 },
		{ x: -18.949, z: 0.04, y: -38.117, class: 'Teleporter', yaw: 180.4, tag: 'hepburn1', url: 'hepburn2', nav_id: 88 },
		{ x: -22.59, z: 0.06, y: 18.576, class: 'Teleporter', yaw: 1.19, tag: 'hepburn2', url: 'hepburn1', nav_id: 89 },
		{ x: 122.517, z: -3.236, y: -37.374, class: 'Teleporter', yaw: 0.88, tag: 'buffybabe1', url: 'buffybabe2', nav_id: 90 },
		{ x: 125.435, z: -3.079, y: 18.899, class: 'Teleporter', yaw: 180.88, tag: 'buffybabe2', url: 'buffybabe1', nav_id: 91 },
	],
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
	mega: { x: -5.300, y: 17.069, z: 5.269 },
	// --- UT-EXTRACTED TELEPORTERS (2, native units) — copied verbatim from
	// _work/ut-actors/DM-W-Grove-2025.actors.json. One bidirectional secret pair.
	TELEPORTERS: [
		{ x: -1.757, z: 23.818, y: -2.182, class: 'VisibleTeleporter', yaw: 64.07, tag: 'L0_secret1', url: 'L3_secret4' },
		{ x: 16.898, z: -16.971, y: 15.186, class: 'VisibleTeleporter', tag: 'L3_secret4', url: 'L0_secret1' },
	],
})

// ---------------------------------------------------------------------------
// IMPORTED MESH MAPS (first-tranche 4-mode rotation) — added by the map-import
// pipeline (scripts/import-map.py + validate-map.mjs). Each was validated through
// probeThisForEachMap.md (geometry loads, spawns drop-probe with headroom, killY
// below all nav-reachable floor with margin, walkable + view box derive, winding
// resolved). Values come from the merged/v1 extraction (make_registry.py, or
// scripts/extract-map.mjs for DM-Somnus). Registering these does NOT change the
// DEFAULT (CTF-Visage stays default).
// ---------------------------------------------------------------------------

// DM-Gantry16][ (UT original DM-Deck16][) — imported TDM. killY nav-gated (margin 12.66 m world);
// winding sign 1; longest sightline 36.8 m (default fog OK — no per-map fogDensity).
// Isolation: kept 1672 faces, dropped 0 detached (margin 39 m).
const dm_gantry162 = mesh({
		id: 'dm_gantry162',
		name: 'DM-Gantry16][',
		mode: 'TDM',
		dir: '/assets/maps/DM-Gantry16][/',
		file: 'DM-Gantry16][.obj',
		lights: 'DM-Gantry16][.lights.json',
		killY: -45,
		spawns: [
			{ x: -3.078, y: -13.41, z: 17.212 },
			{ x: -3.679, y: -13.41, z: -18.301 },
			{ x: -6.667, y: -12.19, z: -34.095 },
			{ x: 17.322, y: -13.41, z: 36.505 },
			{ x: -0.693, y: -13.41, z: 29.75 },
			{ x: 43.852, y: -10.36, z: -18.31 },
			{ x: 17.052, y: -3.66, z: -29.148 },
			{ x: 30.53, y: -4.27, z: 16.604 },
			{ x: 44.866, y: -10.36, z: 0.003 },
			{ x: 33.813, y: -13.41, z: 29.473 },
			{ x: 2.351, y: -8.53, z: 15.606 },
			{ x: 20.705, y: -15.77, z: 12.777 },
			{ x: -6.665, y: -14.63, z: -21.679 },
			{ x: -10.053, y: -13.41, z: -3.843 },
			{ x: 16.976, y: -14.63, z: -29.68 }
		],
		walkable: { minX: -28.6, maxX: 46.4, minY: -45.0, maxY: -1.8, minZ: -40.2, maxZ: 39.1 },
		mega: { x: 13.432, y: -12.192, z: -23.873 },
		mode_data: { teams: 2 },
		SPAWN_POINTS: [
			{ x: -3.078, y: -13.41, z: 17.212, yaw: 276.81, team: 1, team_source: 'derived_2means', headroom: 4.84 },
			{ x: -3.679, y: -13.41, z: -18.301, yaw: 57.3, team: 0, team_source: 'derived_2means', headroom: 3.67 },
			{ x: -6.667, y: -12.19, z: -34.095, yaw: 134.91, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 17.322, y: -13.41, z: 36.505, yaw: 270.18, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -0.693, y: -13.41, z: 29.75, yaw: 319.48, team: 1, team_source: 'derived_2means', headroom: 1.89 },
			{ x: 43.852, y: -10.36, z: -18.31, yaw: 181.05, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 17.052, y: -3.66, z: -29.148, yaw: 89.74, team: 0, team_source: 'derived_2means', headroom: 6.09 },
			{ x: 30.53, y: -4.27, z: 16.604, yaw: 175.96, team: 1, team_source: 'derived_2means', headroom: 2.49 },
			{ x: 44.866, y: -10.36, z: 0.003, yaw: 178.46, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 33.813, y: -13.41, z: 29.473, yaw: 184.57, team: 1, team_source: 'derived_2means', headroom: 2.25 },
			{ x: 2.351, y: -8.53, z: 15.606, yaw: 278.26, team: 1, team_source: 'derived_2means', headroom: 6.23 },
			{ x: 20.705, y: -15.77, z: 12.777, yaw: 277.73, team: 1, team_source: 'derived_2means', headroom: 14.81 },
			{ x: -6.665, y: -14.63, z: -21.679, yaw: 273.6, team: 0, team_source: 'derived_2means', headroom: 9.26 },
			{ x: -10.053, y: -13.41, z: -3.843, yaw: 178.51, team: 0, team_source: 'derived_2means', headroom: 2.12 },
			{ x: 16.976, y: -14.63, z: -29.68, yaw: 147.79, team: 0, team_source: 'derived_2means', headroom: 6.09 }
		],
		PICKUPS: {
			weapon: [
				{ x: 17.122, z: 28.111, y: -23.43, class: 'ShockRifle', item: 'shock_rifle', tag: 'ShockRifle' },
				{ x: 29.66, z: 18.684, y: -3.903, class: 'ut_biorifle', item: 'bio_rifle', tag: 'ut_biorifle' },
				{ x: 17.126, z: -24.048, y: -3.313, class: 'SniperRifle', item: 'sniper_rifle', yaw: 0.0, tag: 'SniperRifle' },
				{ x: 2.135, z: 2.136, y: -11.714, class: 'PulseGun', item: 'pulse_gun', tag: 'PulseGun' },
				{ x: 43.748, z: 30.282, y: -9.98, class: 'SniperRifle', item: 'sniper_rifle', yaw: 0.0, tag: 'SniperRifle' },
				{ x: 41.98, z: -21.207, y: -8.704, class: 'UT_FlakCannon', item: 'flak_cannon', tag: 'UT_FlakCannon' },
				{ x: -19.652, z: -4.012, y: -12.171, class: 'UT_Eightball', item: 'rocket_launcher', tag: 'UT_Eightball' },
				{ x: -4.04, z: 29.825, y: -13.276, class: 'ripper', tag: 'ripper' },
				{ x: 16.799, z: -27.052, y: -24.039, class: 'UT_Eightball', item: 'rocket_launcher', tag: 'UT_Eightball' },
				{ x: 17.388, z: 27.055, y: -5.58, class: 'WarheadLauncher', item: 'redeemer', tag: 'WarheadLauncher' },
				{ x: -20.158, z: -21.821, y: -16.534, class: 'UT_FlakCannon', item: 'flak_cannon', tag: 'UT_FlakCannon' },
				{ x: 22.546, z: 18.564, y: -15.448, class: 'minigun2', item: 'minigun', tag: 'minigun2' },
				{ x: 20.78, z: -22.67, y: -14.476, class: 'ShockRifle', item: 'shock_rifle', tag: 'ShockRifle' }
			],
			ammo: [
				{ x: 19.079, z: 28.231, y: -23.353, class: 'ShockCore', item: 'shock_core', yaw: 300.5, tag: 'ShockCore' },
				{ x: 15.376, z: 28.194, y: -23.354, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 17.488, z: 32.125, y: -20.305, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 17.247, z: 37.184, y: -19.048, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 18.267, z: 38.393, y: -19.048, class: 'RocketPack', item: 'rockets', yaw: 262.09, tag: 'RocketPack' },
				{ x: 28.267, z: 18.614, y: -4.094, class: 'bioammo', item: 'bio_ammo', tag: 'bioammo' },
				{ x: 30.988, z: 18.7, y: -4.094, class: 'bioammo', item: 'bio_ammo', tag: 'bioammo' },
				{ x: 31.26, z: -18.892, y: -4.094, class: 'bioammo', item: 'bio_ammo', tag: 'bioammo' },
				{ x: 28.279, z: -18.796, y: -4.094, class: 'bioammo', item: 'bio_ammo', tag: 'bioammo' },
				{ x: 18.883, z: -22.986, y: -3.465, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: 15.812, z: -22.962, y: -3.465, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: 15.93, z: -25.162, y: -3.465, class: 'BulletBox', item: 'bullets', yaw: 142.73, tag: 'BulletBox' },
				{ x: 18.715, z: -25.351, y: -3.465, class: 'BulletBox', item: 'bullets', yaw: 279.93, tag: 'BulletBox' },
				{ x: 1.072, z: -17.047, y: -13.181, class: 'PAmmo', item: 'pulse_ammo', tag: 'PAmmo' },
				{ x: 1.065, z: -17.687, y: -13.181, class: 'PAmmo', item: 'pulse_ammo', tag: 'PAmmo' },
				{ x: 1.619, z: -2.324, y: -13.181, class: 'PAmmo', item: 'pulse_ammo', tag: 'PAmmo' },
				{ x: 1.176, z: -2.359, y: -13.181, class: 'PAmmo', item: 'pulse_ammo', tag: 'PAmmo' },
				{ x: 42.235, z: 30.898, y: -10.171, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: 44.965, z: 30.959, y: -10.171, class: 'BulletBox', item: 'bullets', yaw: 305.2, tag: 'BulletBox' },
				{ x: 44.529, z: -21.186, y: -10.152, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: 39.097, z: -21.184, y: -10.152, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -21.664, z: -3.956, y: -12.266, class: 'RocketPack', item: 'rockets', yaw: 298.17, tag: 'RocketPack' },
				{ x: -3.77, z: 23.153, y: -13.219, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: -3.769, z: 23.84, y: -13.219, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: 18.956, z: -27.217, y: -24.001, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 15.199, z: -27.224, y: -24.001, class: 'RocketPack', item: 'rockets', yaw: 285.29, tag: 'RocketPack' },
				{ x: -21.581, z: -21.549, y: -16.857, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -18.74, z: -21.568, y: -16.857, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -5.994, z: -35.968, y: -14.4, class: 'RocketPack', item: 'rockets', yaw: 184.48, tag: 'RocketPack' },
				{ x: -5.99, z: -36.855, y: -14.209, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: -6.181, z: -37.777, y: -14.495, class: 'BulletBox', item: 'bullets', yaw: 245.26, tag: 'BulletBox' },
				{ x: 12.767, z: 18.862, y: -15.562, class: 'Miniammo', item: 'minigun_ammo', yaw: 352.44, tag: 'Miniammo' },
				{ x: 12.744, z: 18.242, y: -15.562, class: 'Miniammo', item: 'minigun_ammo', yaw: 194.15, tag: 'Miniammo' },
				{ x: 19.027, z: -25.527, y: -14.209, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 18.759, z: -25.591, y: -14.209, class: 'ShockCore', item: 'shock_core', yaw: 233.31, tag: 'ShockCore' }
			],
			health: [
				{ x: 15.782, z: 38.505, y: -24.077, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 15.787, z: 37.688, y: -24.077, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 18.037, z: -4.889, y: -19.81, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 18.314, z: -4.892, y: -19.81, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 15.755, z: -4.891, y: -19.81, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 16.056, z: -4.893, y: -19.81, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 4.161, z: -21.493, y: -14.476, class: 'MedBox', item: 'health_pack', yaw: 270.83, tag: 'MedBox' },
				{ x: -1.097, z: -21.448, y: -14.476, class: 'MedBox', item: 'health_pack', yaw: 270.83, tag: 'MedBox' },
				{ x: 43.279, z: -12.17, y: -9.79, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 43.61, z: -11.868, y: -9.79, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 43.614, z: -12.484, y: -9.79, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 42.965, z: -11.852, y: -9.79, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 42.975, z: -12.486, y: -9.79, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -0.619, z: 14.635, y: -13.104, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -0.637, z: 13.965, y: -13.104, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -0.618, z: 13.168, y: -13.104, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' }
			],
			armor: [
				{ x: 23.107, z: 31.086, y: -22.534, class: 'armor2', item: 'body_armor', tag: 'armor2' },
				{ x: 17.059, z: -4.894, y: -19.448, class: 'ut_shieldbelt', item: 'shield_belt', yaw: 322.91, tag: 'ut_shieldbelt' },
				{ x: 30.385, z: -12.703, y: -3.694, class: 'ThighPads', item: 'thigh_pads', tag: 'ThighPads' },
				{ x: 17.032, z: 9.778, y: -24.096, class: 'ut_jumpboots', item: 'jump_boots', tag: 'ut_jumpboots' }
			],
			powerup: [
				{ x: 13.432, z: -23.873, y: -11.619, class: 'UDamage', item: 'damage_amplifier', tag: 'UDamage' }
			]
		},
		// --- UT-EXTRACTED TELEPORTERS (2, native units) — copied verbatim from
		// _work/ut-actors/DM-Gantry16][.actors.json. nav 152 -> nav 151 is one-way
		// (151 has no url, so it is a destination-only/inert entry).
		TELEPORTERS: [
			{ x: 17.1, z: 37.334, y: -4.951, class: 'Teleporter', yaw: 269.91, tag: 'gotheredammit', nav_id: 151 },
			{ x: 17.034, z: -31.715, y: -23.468, class: 'Teleporter', yaw: 86.04, tag: 'Teleporter', url: 'gotheredammit', nav_id: 152 },
		]
	})

// DOM-Elder (UT original DOM-Olden) — imported DOM. killY nav-gated (margin 10.90 m world);
// winding sign 1; longest sightline 34.3 m (default fog OK — no per-map fogDensity).
// Isolation: kept 3755 faces, dropped 222 detached (margin 32 m).
const dom_elder = mesh({
		id: 'dom_elder',
		name: 'DOM-Elder',
		mode: 'DOM',
		dir: '/assets/maps/DOM-Elder/',
		file: 'DOM-Elder.obj',
		lights: 'DOM-Elder.lights.json',
		killY: -25,
		spawns: [
			{ x: 14.316, y: -2.44, z: 16.113 },
			{ x: 1.967, y: -2.44, z: 34.863 },
			{ x: -26.856, y: 5.79, z: 53.9 },
			{ x: -2.449, y: -2.44, z: 2.352 },
			{ x: 4.536, y: -2.44, z: 8.67 },
			{ x: 28.101, y: -2.44, z: 27.859 },
			{ x: 28.633, y: -2.44, z: 37.968 },
			{ x: 13.662, y: -2.44, z: 50.013 },
			{ x: -14.728, y: -2.44, z: 49.509 },
			{ x: -35.341, y: -2.44, z: 44.887 },
			{ x: -35.373, y: -2.44, z: 36.799 },
			{ x: -34.011, y: -2.44, z: 25.193 },
			{ x: -35.085, y: -2.44, z: 10.991 },
			{ x: -11.134, y: -2.44, z: 10.258 },
			{ x: -15.365, y: 5.79, z: 41.379 },
			{ x: 0.901, y: 5.79, z: 41.362 }
		],
		walkable: { minX: -36.6, maxX: 30.5, minY: -25.0, maxY: 18.9, minZ: -4.9, maxZ: 58.6 },
		mega: { x: 24.663, y: 11.43, z: 50.159 },
		mode_data: {
			controlPoints: [
				{ id: 'A', x: -2.497, y: 4.002, z: 2.556 },
				{ id: 'B', x: -3.081, y: -1.484, z: 50.687 },
				{ id: 'C', x: -25.891, y: 6.86, z: 19.48 }
			],
			scorePerTickPerPoint: 1,
			geometry: {
				triangle_area_m2: 235.8,
				sides_m: [31.3, 25.1, 18.8],
				vertical_spread_m: 5.42,
				coplanar: false
			}
		},
		SPAWN_POINTS: [
			{ x: 14.316, y: -2.44, z: 16.113, yaw: 24.52, team: 0, team_source: 'derived_2means', headroom: 5.89 },
			{ x: 1.967, y: -2.44, z: 34.863, yaw: 78.57, team: 0, team_source: 'derived_2means', headroom: 7.03 },
			{ x: -26.856, y: 5.79, z: 53.9, yaw: 270.66, team: 1, team_source: 'derived_2means', headroom: 2.13 },
			{ x: -2.449, y: -2.44, z: 2.352, yaw: 89.87, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 4.536, y: -2.44, z: 8.67, yaw: 122.43, team: 0, team_source: 'derived_2means', headroom: 6.53 },
			{ x: 28.101, y: -2.44, z: 27.859, yaw: 182.37, team: 0, team_source: 'derived_2means', headroom: 4.43 },
			{ x: 28.633, y: -2.44, z: 37.968, yaw: 178.9, team: 0, team_source: 'derived_2means', headroom: 5.32 },
			{ x: 13.662, y: -2.44, z: 50.013, yaw: 354.02, team: 0, team_source: 'derived_2means', headroom: 4.47 },
			{ x: -14.728, y: -2.44, z: 49.509, yaw: 255.32, team: 1, team_source: 'derived_2means', headroom: 5.13 },
			{ x: -35.341, y: -2.44, z: 44.887, yaw: null, team: 1, team_source: 'derived_2means', headroom: 4.53 },
			{ x: -35.373, y: -2.44, z: 36.799, yaw: null, team: 1, team_source: 'derived_2means', headroom: 4.48 },
			{ x: -34.011, y: -2.44, z: 25.193, yaw: null, team: 1, team_source: 'derived_2means', headroom: 6.25 },
			{ x: -35.085, y: -2.44, z: 10.991, yaw: null, team: 1, team_source: 'derived_2means', headroom: 4.53 },
			{ x: -11.134, y: -2.44, z: 10.258, yaw: null, team: 1, team_source: 'derived_2means', headroom: 4.3 },
			{ x: -15.365, y: 5.79, z: 41.379, yaw: null, team: 1, team_source: 'derived_2means', headroom: 3.91 },
			{ x: 0.901, y: 5.79, z: 41.362, yaw: 175.78, team: 0, team_source: 'derived_2means', headroom: 3.91 }
		],
		PICKUPS: {
			weapon: [
				{ x: -2.136, z: -2.611, y: 3.202, class: 'minigun2', item: 'minigun', tag: 'minigun2' },
				{ x: -2.399, z: 7.583, y: -2.075, class: 'ut_biorifle', item: 'bio_rifle', tag: 'ut_biorifle' },
				{ x: 14.783, z: 11.576, y: -1.979, class: 'ShockRifle', item: 'shock_rifle', tag: 'ShockRifle' },
				{ x: 28.62, z: 49.216, y: -1.694, class: 'UT_FlakCannon', item: 'flak_cannon', tag: 'UT_FlakCannon' },
				{ x: -26.868, z: 28.267, y: 6.231, class: 'UT_FlakCannon', item: 'flak_cannon', yaw: 0.62, tag: 'UT_FlakCannon' },
				{ x: -18.832, z: 49.079, y: -2.303, class: 'ripper', yaw: 91.98, tag: 'ripper' },
				{ x: 0.298, z: 37.666, y: 5.984, class: 'UT_Eightball', item: 'rocket_launcher', tag: 'UT_Eightball' },
				{ x: -12.914, z: 22.352, y: 7.565, class: 'SniperRifle', item: 'sniper_rifle', yaw: 269.78, tag: 'SniperRifle' }
			],
			ammo: [
				{ x: 0.192, z: -3.39, y: 3.26, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: -4.643, z: -3.362, y: 3.259, class: 'Miniammo', item: 'minigun_ammo', yaw: 263.14, tag: 'Miniammo' },
				{ x: 6.027, z: 15.343, y: -2.003, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 6.238, z: 17.33, y: -2.227, class: 'flakammo', item: 'flak_shells', yaw: 275.36, tag: 'flakammo' },
				{ x: 0.425, z: 0.876, y: -2.265, class: 'bioammo', item: 'bio_ammo', tag: 'bioammo' },
				{ x: -4.866, z: 1.614, y: -2.265, class: 'bioammo', item: 'bio_ammo', yaw: 330.42, tag: 'bioammo' },
				{ x: 5.85, z: 33.217, y: 6.326, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 3.872, z: 32.896, y: 6.327, class: 'RocketPack', item: 'rockets', yaw: 88.24, tag: 'RocketPack' },
				{ x: -28.952, z: 17.368, y: 6.003, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -28.996, z: 21.382, y: 6.003, class: 'flakammo', item: 'flak_shells', yaw: 207.2, tag: 'flakammo' },
				{ x: 27.625, z: 11.741, y: -2.208, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 6.341, z: 27.688, y: -2.246, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: -11.094, z: 27.975, y: -2.227, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -30.712, z: 50.224, y: -2.246, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: -17.405, z: 44.966, y: -1.027, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: 24.051, z: 47.122, y: -2.227, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: 24.056, z: 49.446, y: -2.227, class: 'flakammo', item: 'flak_shells', yaw: 91.32, tag: 'flakammo' },
				{ x: 11.272, z: 15.134, y: -2.003, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 11.789, z: 17.847, y: -2.003, class: 'ShockCore', item: 'shock_core', yaw: 89.74, tag: 'ShockCore' },
				{ x: -2.085, z: 33.506, y: -2.003, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 16.612, z: 32.272, y: -2.003, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: -16.129, z: 23.821, y: 7.508, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: -14.17, z: 24.038, y: 7.603, class: 'RifleShell', item: 'sniper_rounds', tag: 'RifleShell' },
				{ x: -13.717, z: 24.029, y: 7.603, class: 'RifleShell', item: 'sniper_rounds', tag: 'RifleShell' },
				{ x: -13.216, z: 24.038, y: 7.603, class: 'RifleShell', item: 'sniper_rounds', tag: 'RifleShell' }
			],
			health: [
				{ x: -9.664, z: 32.973, y: 6.25, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -11.623, z: 32.893, y: 6.25, class: 'MedBox', item: 'health_pack', yaw: 269.91, tag: 'MedBox' },
				{ x: 10.089, z: 22.579, y: 7.689, class: 'HealthPack', item: 'health_pack', tag: 'HealthPack' },
				{ x: -31.538, z: 19.483, y: 0.764, class: 'MedBox', item: 'health_pack', yaw: 91.01, tag: 'MedBox' },
				{ x: 16.601, z: 22.939, y: -2.284, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -17.605, z: 27.362, y: -2.036, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -18.692, z: 27.715, y: -2.036, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -17.935, z: 28.127, y: -2.036, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -18.753, z: 28.677, y: -2.036, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -17.709, z: 28.912, y: -2.036, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -8.21, z: 13.95, y: -7.923, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -7.468, z: 12.573, y: -7.923, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -6.383, z: 12.442, y: -7.923, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -8.031, z: 11.098, y: -7.923, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -5.449, z: 11.375, y: -7.923, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' }
			],
			armor: [
				{ x: -17.927, z: 10.852, y: -1.902, class: 'armor2', item: 'body_armor', yaw: 89.96, tag: 'armor2' },
				{ x: 24.663, z: 50.159, y: 9.184, class: 'ut_shieldbelt', item: 'shield_belt', yaw: 270.66, tag: 'ut_shieldbelt' }
			]
		},
		// --- UT-EXTRACTED TELEPORTERS (12, native units) — copied verbatim from
		// _work/ut-actors/DOM-Elder.actors.json. Six one-way sender->receiver pairs;
		// the enabled:false actors are destination-only receivers (no url).
		TELEPORTERS: [
			{ x: -22.531, z: 54.014, y: 14.175, class: 'Teleporter', tag: 'Teleporter', url: 'ohno1', nav_id: 69 },
			{ x: -22.519, z: 54.016, y: 11.428, class: 'Teleporter', tag: 'ohno1', enabled: false, nav_id: 70 },
			{ x: -10.85, z: 41.484, y: 15.966, class: 'Teleporter', tag: 'Teleporter', url: 'ohno2', nav_id: 71 },
			{ x: -10.856, z: 41.496, y: 13.378, class: 'Teleporter', tag: 'ohno2', enabled: false, nav_id: 72 },
			{ x: -26.861, z: 41.51, y: 13.378, class: 'Teleporter', tag: 'ohno3', enabled: false, nav_id: 73 },
			{ x: -26.857, z: 41.523, y: 16.305, class: 'Teleporter', tag: 'Teleporter', url: 'ohno3', nav_id: 74 },
			{ x: -26.832, z: 19.57, y: 20.029, class: 'Teleporter', tag: 'Teleporter', url: 'ohno4', nav_id: 76 },
			{ x: -26.832, z: 19.581, y: 15.94, class: 'Teleporter', tag: 'ohno4', enabled: false, nav_id: 77 },
			{ x: 4.868, z: 41.429, y: 13.378, class: 'Teleporter', tag: 'tele4', enabled: false, nav_id: 90 },
			{ x: 4.859, z: 41.421, y: 16.026, class: 'Teleporter', tag: 'Teleporter', url: 'tele4', nav_id: 91 },
			{ x: 20.761, z: 41.467, y: 13.378, class: 'Teleporter', tag: 'tele5', enabled: false, nav_id: 92 },
			{ x: 20.742, z: 41.466, y: 15.969, class: 'Teleporter', tag: 'Teleporter', url: 'tele5', nav_id: 93 },
		]
	})

// DM-Somnus (UT original DM-Morpheus) — imported FFA. killY nav-gated (margin 11.49 m world);
// winding sign 1; longest sightline 23.7 m (default fog OK — no per-map fogDensity).
// Isolation: kept 2452 faces, dropped 324 detached (margin 30 m).
const dm_somnus = mesh({
		id: 'dm_somnus',
		name: 'DM-Somnus',
		mode: 'FFA',
		dir: '/assets/maps/DM-Somnus/',
		file: 'DM-Somnus.obj',
		lights: 'DM-Somnus.lights.json',
		killY: 0,
		spawns: [
			{ x: 7.597, y: 36.576, z: 25.307 },
			{ x: 10.934, y: 34.138, z: -10.053 },
			{ x: -19.494, y: 39.014, z: -4.137 },
			{ x: -11.166, y: 41.453, z: -13.252 },
			{ x: 14.232, y: 36.576, z: -9.172 },
			{ x: 8.391, y: 39.014, z: 21.73 },
			{ x: 5.011, y: 39.014, z: 17.334 },
			{ x: -17.91, y: 41.453, z: -7.655 },
			{ x: -23.226, y: 39.014, z: -7.706 },
			{ x: 14.355, y: 34.138, z: -14.544 },
			{ x: 11.632, y: 36.576, z: 19.185 },
			{ x: 26.105, y: 36.576, z: -10.023 },
			{ x: 11.396, y: 36.576, z: 22.492 },
			{ x: 3.504, y: 39.014, z: 15.867 },
			{ x: -0.803, y: 19.507, z: 0.244 }
		],
		walkable: { minX: -25.3, maxX: 33.6, minY: 0, maxY: 68.3, minZ: -26.3, maxZ: 29.3 },
		mega: { x: 19.525, y: 48.768, z: -6.886 },
		mode_data: { teams: 0 },
		SPAWN_POINTS: [
			{ x: 7.597, y: 36.576, z: 25.307, yaw: 221.13, team: 1, team_source: 'derived_2means', headroom: 1.33 },
			{ x: 10.934, y: 34.138, z: -10.053, yaw: null, team: 1, team_source: 'derived_2means', headroom: 1.33 },
			{ x: -19.494, y: 39.014, z: -4.137, yaw: 299.18, team: 0, team_source: 'derived_2means', headroom: 1.33 },
			{ x: -11.166, y: 41.453, z: -13.252, yaw: null, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 14.232, y: 36.576, z: -9.172, yaw: 217.71, team: 1, team_source: 'derived_2means', headroom: 15 },
			{ x: 8.391, y: 39.014, z: 21.73, yaw: 37.4, team: 1, team_source: 'derived_2means', headroom: 15 },
			{ x: 5.011, y: 39.014, z: 17.334, yaw: 314.17, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -17.91, y: 41.453, z: -7.655, yaw: 65.26, team: 0, team_source: 'derived_2means', headroom: 3.49 },
			{ x: -23.226, y: 39.014, z: -7.706, yaw: 313.42, team: 0, team_source: 'derived_2means', headroom: 1.33 },
			{ x: 14.355, y: 34.138, z: -14.544, yaw: 38.01, team: 1, team_source: 'derived_2means', headroom: 1.33 },
			{ x: 11.632, y: 36.576, z: 19.185, yaw: 211.03, team: 1, team_source: 'derived_2means', headroom: 1.33 },
			{ x: 26.105, y: 36.576, z: -10.023, yaw: 87.14, team: 1, team_source: 'derived_2means', headroom: 2.24 },
			{ x: 11.396, y: 36.576, z: 22.492, yaw: 221.13, team: 1, team_source: 'derived_2means', headroom: 1.33 },
			{ x: 3.504, y: 39.014, z: 15.867, yaw: 299.05, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -0.803, y: 19.507, z: 0.244, yaw: null, team: 1, team_source: 'derived_2means', headroom: 15 }
		],
		PICKUPS: {
			weapon: [
				{ x: -5.898, z: -16.796, y: 47.767, class: 'UT_Eightball', item: 'rocket_launcher', tag: 'UT_Eightball' },
				{ x: 25.565, z: 2.402, y: 42.826, class: 'ShockRifle', item: 'shock_rifle', tag: 'ShockRifle' },
				{ x: -2.288, z: 9.621, y: 45.265, class: 'minigun2', item: 'minigun', tag: 'minigun2' },
				{ x: -8.433, z: -15.45, y: 35.492, class: 'ripper', tag: 'ripper' },
				{ x: 21.439, z: 1.021, y: 30.634, class: 'SniperRifle', item: 'sniper_rifle', yaw: 347.12, tag: 'SniperRifle' },
				{ x: 1.147, z: 11.24, y: 33.492, class: 'PulseGun', item: 'pulse_gun', tag: 'PulseGun' },
				{ x: 12.537, z: 9.818, y: 19.7, class: 'UT_Eightball', item: 'rocket_launcher', yaw: 113.82, tag: 'UT_Eightball' },
				{ x: -15.741, z: -12.521, y: 54.084, class: 'WarheadLauncher', item: 'redeemer', yaw: 4.04, tag: 'WarheadLauncher' }
			],
			ammo: [
				{ x: -5.721, z: -15.321, y: 47.818, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: -5.907, z: -19.068, y: 47.818, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 25.6, z: 0.581, y: 43.085, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 25.881, z: 4.538, y: 43.085, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: -2.268, z: 11.657, y: 45.392, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: -2.426, z: 7.858, y: 45.39, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: -7.291, z: -14.77, y: 35.549, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: -7.361, z: -13.819, y: 35.549, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: 22.729, z: -0.966, y: 30.672, class: 'BulletBox', item: 'bullets', yaw: 320.93, tag: 'BulletBox' },
				{ x: 22.44, z: -0.548, y: 30.672, class: 'BulletBox', item: 'bullets', yaw: 25.49, tag: 'BulletBox' },
				{ x: -0.955, z: 13.005, y: 33.149, class: 'PAmmo', item: 'pulse_ammo', yaw: 355.74, tag: 'PAmmo' },
				{ x: -0.716, z: 12.252, y: 33.149, class: 'PAmmo', item: 'pulse_ammo', yaw: 337.54, tag: 'PAmmo' },
				{ x: 13.631, z: 11.091, y: 19.738, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 12.971, z: 11.557, y: 19.738, class: 'RocketPack', item: 'rockets', yaw: 39.99, tag: 'RocketPack' }
			],
			health: [
				{ x: 16.532, z: -5.321, y: 36.73, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 17.484, z: -4.664, y: 36.731, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -3.853, z: 25.742, y: 39.168, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -2.928, z: 26.547, y: 39.168, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -22.403, z: -18.229, y: 41.608, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -21.652, z: -19.346, y: 41.607, class: 'MedBox', item: 'health_pack', tag: 'MedBox' }
			],
			armor: [
				{ x: 2.839, z: 19.516, y: 51.72, class: 'armor2', item: 'body_armor', yaw: 228.91, tag: 'armor2' }
			],
			powerup: [
				{ x: 19.525, z: -6.886, y: 49.15, class: 'UT_invisibility', item: 'invisibility', tag: 'UT_invisibility' }
			]
		}
	})

// DM-Baroque (UT original DM-Gothic) — imported TDM. killY nav-gated (margin 11.41 m world);
// winding sign 1; longest sightline 25.6 m (default fog OK — no per-map fogDensity).
// Isolation: kept 8025 faces, dropped 0 detached (margin 54 m).
const dm_baroque = mesh({
		id: 'dm_baroque',
		name: 'DM-Baroque',
		mode: 'TDM',
		dir: '/assets/maps/DM-Baroque/',
		file: 'DM-Baroque.obj',
		lights: 'DM-Baroque.lights.json',
		killY: -20,
		spawns: [
			{ x: 7.776, y: 0, z: 0.866 },
			{ x: -18.88, y: 2.44, z: 52.225 },
			{ x: -7.365, y: -2.44, z: -36.678 },
			{ x: -32.666, y: 0, z: 31.272 },
			{ x: -19.244, y: 2.44, z: 16.752 },
			{ x: 2.48, y: 12.19, z: 25.634 },
			{ x: 40.589, y: 7.32, z: 20.606 },
			{ x: 21.165, y: 9.75, z: 37.442 },
			{ x: 51.203, y: 0, z: 34.057 },
			{ x: -17.833, y: 0, z: 31.455 },
			{ x: -11.864, y: 12.19, z: 46.322 },
			{ x: 29.381, y: 2.44, z: 26.24 },
			{ x: 40.954, y: 0, z: 1.286 },
			{ x: 51.902, y: 0, z: 11.468 },
			{ x: -2.665, y: 0, z: -12.326 },
			{ x: 12.701, y: -2.44, z: -52.099 },
			{ x: 3.75, y: 12.19, z: -5.811 },
			{ x: -3.655, y: 0, z: 26.17 }
		],
		walkable: { minX: -78.1, maxX: 78.1, minY: -20.0, maxY: 42.7, minZ: -87.8, maxZ: 56.1 },
		mega: { x: 2.417, y: 2.438, z: -41.477 },
		mode_data: { teams: 2 },
		SPAWN_POINTS: [
			{ x: 7.776, y: 0, z: 0.866, yaw: 223.86, team: 1, team_source: 'derived_2means', headroom: 4.96 },
			{ x: -18.88, y: 2.44, z: 52.225, yaw: 269.56, team: 0, team_source: 'derived_2means', headroom: 4.5 },
			{ x: -7.365, y: -2.44, z: -36.678, yaw: 39.9, team: 1, team_source: 'derived_2means', headroom: 15 },
			{ x: -32.666, y: 0, z: 31.272, yaw: null, team: 0, team_source: 'derived_2means', headroom: 4.77 },
			{ x: -19.244, y: 2.44, z: 16.752, yaw: 92.9, team: 0, team_source: 'derived_2means', headroom: 4.5 },
			{ x: 2.48, y: 12.19, z: 25.634, yaw: 89.91, team: 0, team_source: 'derived_2means', headroom: 3.73 },
			{ x: 40.589, y: 7.32, z: 20.606, yaw: 132.89, team: 0, team_source: 'derived_2means', headroom: 4.5 },
			{ x: 21.165, y: 9.75, z: 37.442, yaw: null, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 51.203, y: 0, z: 34.057, yaw: 90.04, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -17.833, y: 0, z: 31.455, yaw: 120.41, team: 0, team_source: 'derived_2means', headroom: 4.81 },
			{ x: -11.864, y: 12.19, z: 46.322, yaw: 338.55, team: 0, team_source: 'derived_2means', headroom: 2.92 },
			{ x: 29.381, y: 2.44, z: 26.24, yaw: 43.77, team: 0, team_source: 'derived_2means', headroom: 7.67 },
			{ x: 40.954, y: 0, z: 1.286, yaw: 132.1, team: 1, team_source: 'derived_2means', headroom: 4.5 },
			{ x: 51.902, y: 0, z: 11.468, yaw: 180.88, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -2.665, y: 0, z: -12.326, yaw: 268.64, team: 1, team_source: 'derived_2means', headroom: 2.58 },
			{ x: 12.701, y: -2.44, z: -52.099, yaw: 127.0, team: 1, team_source: 'derived_2means', headroom: 15 },
			{ x: 3.75, y: 12.19, z: -5.811, yaw: 55.77, team: 1, team_source: 'derived_2means', headroom: 2.92 },
			{ x: -3.655, y: 0, z: 26.17, yaw: 1.85, team: 0, team_source: 'derived_2means', headroom: 6.09 }
		],
		PICKUPS: {
			weapon: [
				{ x: 45.098, z: 34.13, y: 7.508, class: 'UT_Eightball', item: 'rocket_launcher', tag: 'UT_Eightball' },
				{ x: -11.853, z: 34.123, y: 12.537, class: 'SniperRifle', item: 'sniper_rifle', yaw: 89.56, tag: 'SniperRifle' },
				{ x: -24.402, z: 17.06, y: 2.834, class: 'PulseGun', item: 'pulse_gun', yaw: 90.0, tag: 'PulseGun' },
				{ x: 2.404, z: -5.775, y: 0.44, class: 'UT_FlakCannon', item: 'flak_cannon', tag: 'UT_FlakCannon' },
				{ x: -13.414, z: 34.205, y: 5.031, class: 'ShockRifle', item: 'shock_rifle', yaw: 269.12, tag: 'ShockRifle' },
				{ x: 23.228, z: 34.176, y: 10.117, class: 'ut_biorifle', item: 'bio_rifle', tag: 'ut_biorifle' },
				{ x: -24.303, z: 51.207, y: 2.777, class: 'ripper', yaw: 270.53, tag: 'ripper' },
				{ x: 2.468, z: 41.517, y: 0.154, class: 'minigun2', item: 'minigun', tag: 'minigun2' },
				{ x: 73.159, z: 34.155, y: 0.44, class: 'WarheadLauncher', item: 'redeemer', tag: 'WarheadLauncher' },
				{ x: 35.445, z: 8.469, y: -0.151, class: 'minigun2', item: 'minigun', tag: 'minigun2' },
				{ x: 32.821, z: -5.567, y: 9.946, class: 'ShockRifle', item: 'shock_rifle', tag: 'ShockRifle' },
				{ x: -2.366, z: 12.249, y: 12.632, class: 'UT_FlakCannon', item: 'flak_cannon', tag: 'UT_FlakCannon' }
			],
			ammo: [
				{ x: 46.951, z: 33.193, y: 7.546, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: 46.887, z: 35.04, y: 7.546, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: -11.851, z: 36.49, y: 12.384, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: -11.87, z: 31.619, y: 12.384, class: 'BulletBox', item: 'bullets', tag: 'BulletBox' },
				{ x: -26.84, z: 17.097, y: 2.653, class: 'PAmmo', item: 'pulse_ammo', yaw: 90.0, tag: 'PAmmo' },
				{ x: -21.958, z: 17.097, y: 2.653, class: 'PAmmo', item: 'pulse_ammo', yaw: 90.0, tag: 'PAmmo' },
				{ x: 0.008, z: -5.793, y: 0.211, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: 4.861, z: -5.753, y: 0.211, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -13.516, z: 17.88, y: 2.917, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: -13.408, z: 50.501, y: 2.859, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 23.065, z: 25.595, y: 8.738, class: 'bioammo', item: 'bio_ammo', yaw: 270.0, tag: 'bioammo' },
				{ x: 23.146, z: 41.489, y: 8.738, class: 'bioammo', item: 'bio_ammo', yaw: 270.0, tag: 'bioammo' },
				{ x: -26.828, z: 45.703, y: 2.651, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: -21.958, z: 45.733, y: 2.651, class: 'BladeHopper', item: 'ripper_blades', tag: 'BladeHopper' },
				{ x: 4.288, z: 40.855, y: 0.211, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: 0.513, z: 40.811, y: 0.211, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: 35.383, z: 6.063, y: -0.093, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: 35.339, z: 10.983, y: -0.093, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: -8.72, z: -19.334, y: 0.231, class: 'RocketPack', item: 'rockets', tag: 'RocketPack' },
				{ x: -8.679, z: -20.008, y: 0.211, class: 'Miniammo', item: 'minigun_ammo', tag: 'Miniammo' },
				{ x: -7.987, z: -19.234, y: 0.23, class: 'PAmmo', item: 'pulse_ammo', tag: 'PAmmo' },
				{ x: 31.589, z: -7.207, y: 10.137, class: 'ShockCore', item: 'shock_core', tag: 'ShockCore' },
				{ x: 34.092, z: -7.189, y: 10.137, class: 'ShockCore', item: 'shock_core', yaw: 333.5, tag: 'ShockCore' },
				{ x: -2.356, z: 9.836, y: 12.403, class: 'flakammo', item: 'flak_shells', tag: 'flakammo' },
				{ x: -2.39, z: 14.651, y: 12.403, class: 'flakammo', item: 'flak_shells', yaw: 300.59, tag: 'flakammo' }
			],
			health: [
				{ x: -35.27, z: 21.077, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -35.344, z: 25.66, y: 4.061, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -35.356, z: 28.654, y: 5.092, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -35.37, z: 39.677, y: 4.935, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -35.375, z: 47.154, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -35.336, z: 42.709, y: 4.022, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -7.871, z: 32.348, y: 5.031, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -7.884, z: 35.973, y: 5.031, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -4.124, z: 0.668, y: 0.154, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -4.108, z: 1.584, y: 0.154, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 2.485, z: -52.58, y: -0.151, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 35.402, z: 47.113, y: 7.469, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 5.502, z: -41.692, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -0.623, z: -41.683, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.669, z: 20.091, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 17.064, z: 12.511, y: 12.565, class: 'HealthPack', item: 'health_pack', yaw: 180.18, tag: 'HealthPack' },
				{ x: 26.163, z: 0.485, y: 9.908, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 26.396, z: 0.461, y: 0.154, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -0.622, z: -41.22, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 5.499, z: -41.216, y: 2.745, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.229, z: 20.094, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 7.09, z: 20.109, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 7.53, z: 20.112, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 7.11, z: 4.253, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 7.55, z: 4.256, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.656, z: 4.27, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.216, z: 4.273, y: 0.916, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 26.403, z: -0.566, y: 0.154, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 35.403, z: 47.868, y: 7.47, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 35.193, z: 20.341, y: 7.47, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 35.191, z: 21.155, y: 7.47, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: -2.061, z: -9.469, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.383, z: -9.177, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.797, z: -9.411, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.818, z: -10.068, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.426, z: -9.818, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: -2.093, z: -10.103, y: 0.307, class: 'HealthVial', item: 'health_vial', tag: 'HealthVial' },
				{ x: 26.182, z: -0.468, y: 9.908, class: 'MedBox', item: 'health_pack', tag: 'MedBox' },
				{ x: 2.504, z: -53.399, y: -0.151, class: 'MedBox', item: 'health_pack', tag: 'MedBox' }
			],
			armor: [
				{ x: -24.38, z: 34.093, y: 0.573, class: 'ThighPads', item: 'thigh_pads', tag: 'ThighPads' },
				{ x: -6.121, z: 34.278, y: 12.727, class: 'armor2', item: 'body_armor', yaw: 88.73, tag: 'armor2' },
				{ x: 2.419, z: 21.969, y: 5.069, class: 'ut_shieldbelt', item: 'shield_belt', tag: 'ut_shieldbelt' }
			],
			powerup: [
				{ x: 2.417, z: -41.477, y: 3.202, class: 'UDamage', item: 'damage_amplifier', tag: 'UDamage' }
			]
		},
		// --- UT-EXTRACTED TELEPORTERS (6, native units) — copied verbatim from
		// _work/ut-actors/registry/dm_baroque.json. Three bidirectional pairs
		// (TeleBottm<->TopDeck, TeleTop<->TelePed, Balcony<->UnderStairs) — all 6
		// functional per common/teleporterData.js pairPortals.
		TELEPORTERS: [
			{ x: -31.686, z: 34.128, y: 0.764, class: 'VisibleTeleporter', yaw: 359.96, tag: 'TeleBottm', url: 'TopDeck' },
			{ x: -15.954, z: 34.116, y: 12.956, class: 'VisibleTeleporter', yaw: 359.34, tag: 'TeleTop', url: 'TelePed' },
			{ x: 49.0, z: 34.134, y: 8.232, class: 'VisibleTeleporter', yaw: 179.91, tag: 'TelePed', url: 'TeleTop' },
			{ x: 2.439, z: 12.249, y: 12.937, class: 'VisibleTeleporter', yaw: 179.82, tag: 'TopDeck', url: 'TeleBottm' },
			{ x: 35.449, z: 2.479, y: 10.517, class: 'VisibleTeleporter', yaw: 267.93, tag: 'Balcony', url: 'UnderStairs' },
			{ x: 2.338, z: -48.734, y: -1.674, class: 'VisibleTeleporter', tag: 'UnderStairs', url: 'Balcony' },
		]
	})

// The runtime registry. Add mesh maps here (or via registerMap at boot); the DEFAULT is
// CTF-Visage so a no-argument GameInstance / client behaves exactly as the live game.
export const mapRecords = { visage, grove, dm_gantry162, dom_elder, dm_somnus, dm_baroque }
export const DEFAULT_MAP_ID = 'visage'
export const mapList = () => Object.values(mapRecords)

// ---------------------------------------------------------------------------
// MAP + MODE ROTATION
// ---------------------------------------------------------------------------
// The server plays these in fixed order, one map per match, restart-based (maps
// load ONCE into the NullEngine scene with no dispose path, so "next map" = clean
// exit 0 + supervisor/pm2 restart — see server/serverMain.js + server/rotation.js).
//
// Each entry's mode is the map's EFFECTIVE mode: the registry `mode` field where it
// names an implemented game mode ('FFA', or 'TDM'/'DM' -> TDM), else TDM. CTF and
// DOM are NOT implemented yet — Visage and Elder run as TDM until they are.

// Human display string per effective mode (menu / /mapinfo `modeName`).
export const MODE_DISPLAY = { TDM: 'TEAM DEATHMATCH', FFA: 'FREE FOR ALL', CTF: 'CAPTURE THE FLAG', DOM: 'DOMINATION' }

// A record's EFFECTIVE (implemented) mode. FFA/CTF/DOM name real game modes now; DM /
// TDM / missing collapse to TDM. CTF/DOM were un-coerced from the old TDM fallback
// once those modes shipped (2026-07-22) — Visage now plays real CTF, Elder real DOM.
export function effectiveMode(record) {
	const m = record && typeof record.mode === 'string' ? record.mode.toUpperCase() : ''
	if (m === 'FFA') return 'FFA'
	if (m === 'CTF') return 'CTF'
	if (m === 'DOM') return 'DOM'
	return 'TDM'
}

// Human display name for a map (menu / /mapinfo `mapName`): the record's authored
// display name, uppercased ('DM-Somnus' -> 'DM-SOMNUS').
export function mapDisplayName(record) {
	return String((record && (record.displayName || record.name || record.id)) || '').toUpperCase()
}

// The rotation itself: all 6 mesh maps. Grove first — it is the current live map, so
// a fresh state file boots the familiar one. Visage runs real CTF and dom_elder real
// DOM now that those modes ship (effectiveMode un-coerces them); the other four stay
// TDM/FFA. dom_elder re-enters the rotation as its native DOM.
export const ROTATION = ['grove', 'dm_gantry162', 'dm_somnus', 'dm_baroque', 'visage', 'dom_elder']
	.map(id => {
		const rec = mapRecords[id]
		return {
			mapId: id,
			mode: effectiveMode(rec),                 // 'TDM' | 'FFA'
			mapName: mapDisplayName(rec),             // e.g. 'DM-SOMNUS'
			modeName: MODE_DISPLAY[effectiveMode(rec)] // e.g. 'FREE FOR ALL'
		}
	})

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
