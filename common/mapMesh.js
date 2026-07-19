// Active map = an artist-authored OBJ mesh. The server loads it into its NullEngine
// scene as collision geometry (moveWithCollisions vs the real mesh — proven by
// scripts/verify-meshmap.ts); the client loads the same mesh as the visual. When
// USE_MESH_MAP is true the box arena (arenaConfig / setupObstacles / arenaDressing)
// is bypassed on both sides.
//
// Fall-death: mesh maps have REAL floors with edges, so applyCommand drops its global
// y>=0 clamp (see common/applyCommand.js) and the server kills anyone who falls below
// KILL_Y (GameInstance.update) — walk off a ledge into the void = death.
export const USE_MESH_MAP = true

export const KILL_Y = -15 // fall below this world-y = death (below the map bottom ~-5)

export const MAP_MESH = {
	// DM-W-Grove-2025: same geometry the spawn/scale/KILL_Y numbers below were
	// calibrated against (10697 faces, identical vertex set), re-exported through
	// the improved pipeline: real per-surface material names plus an MTL that maps
	// every material to a web-optimized texture (512px WebP, ~1.8MB for all 109).
	dir: '/assets/maps/DM-W-Grove/',
	file: 'DM-W-Grove-2025.obj',
	// original 1999 light-actor export (export_lights.py); client bakes these into
	// vertex colors on load (client/graphics/mapLights.js). Same local space as the OBJ.
	lights: 'DM-W-Grove-2025.lights.json',
	scale: 0.65,               // shrink the map: smaller rooms + shorter (climbable) stairs.
	                           // spawns/KILL_Y below stay in native units — the server
	                           // multiplies them by this scale at runtime.
	rotationX: -Math.PI / 2,   // the OBJ is Z-up; rotate -90° about X -> Y-up (floors flat)
	yOffset: 0,
	// FFA spawns harvested from the ROTX=-90 grid drop-probe (scripts/verify-meshmap.ts):
	// XZ over verified floors, y a hair above each floor so the spawn settles cleanly.
	spawns: [
		{ x: -17.3, z: -30.2, y: 13.9 }, { x: -17.3, z: -17.9, y: 15.7 },
		{ x: -5.3, z: 19.2, y: 15.7 }, { x: 6.7, z: 19.2, y: 15.7 },
		{ x: 18.7, z: 6.8, y: 15.7 }, { x: -29.3, z: -5.5, y: 16.3 },
		{ x: -5.3, z: -5.5, y: 18.8 }, { x: 6.7, z: -5.5, y: 18.8 }
	]
}
