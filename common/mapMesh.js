// Active map = an artist-authored OBJ mesh. The server loads it into its NullEngine
// scene as collision geometry (moveWithCollisions vs the real mesh — proven by
// scripts/verify-meshmap.ts); the client loads the same mesh as the visual. When
// USE_MESH_MAP is true the box arena (arenaConfig / setupObstacles / arenaDressing)
// is bypassed on both sides.
//
// Fall-death: mesh maps have REAL floors with edges, so applyCommand drops its global
// y>=0 clamp (see common/applyCommand.js) and the server kills anyone who falls below
// killY (GameInstance.update) — walk off a ledge into the void = death. All maps share
// ONE scale (0.65) so the player is the same size relative to geometry everywhere;
// a bigger native map (Facing Worlds) simply plays bigger. spawns/killY are in the
// map's native (ROTX=-90) units — the server multiplies them by scale at runtime.
export const USE_MESH_MAP = true

const MAPS = {
	grove: {
		// DM-W-Grove-2025: the spawn/scale/killY numbers were calibrated against this
		// geometry (10697 faces), re-exported through the improved pipeline: real
		// per-surface material names + an MTL mapping every material to a web texture.
		dir: '/assets/maps/DM-W-Grove/',
		file: 'DM-W-Grove-2025.obj',
		lights: 'DM-W-Grove-2025.lights.json',
		scale: 0.65,
		rotationX: -Math.PI / 2,   // OBJ is Z-up; rotate -90° about X -> Y-up (floors flat)
		yOffset: 0,
		killY: -15,                // fall below this native-y = death (below map bottom ~-5)
		spawns: [
			{ x: -17.3, z: -30.2, y: 13.9 }, { x: -17.3, z: -17.9, y: 15.7 },
			{ x: -5.3, z: 19.2, y: 15.7 }, { x: 6.7, z: 19.2, y: 15.7 },
			{ x: 18.7, z: 6.8, y: 15.7 }, { x: -29.3, z: -5.5, y: 16.3 },
			{ x: -5.3, z: -5.5, y: 18.8 }, { x: 6.7, z: -5.5, y: 18.8 }
		]
	},
	visage: {
		// CTF-Visage = the classic CTF-Face (Facing Worlds), renamed to dodge Epic
		// trademarks (maps/improved/map-names.json). The raw UT export dumps the whole
		// skybox scene (nebula box + distant SkyCity/cathedral/moon/ship backdrop) far
		// from the compact bowtie play area; scripts/process_visage.py isolates the play
		// mesh SPATIALLY (face centroid inside the play box), converts its 36 textures to
		// 512px WebP, and rewrites the MTL. Two towers + a central bridge, floating in the
		// void: walk off = death. Same scale as grove, so it plays large (native ~2.5x).
		dir: '/assets/maps/CTF-Visage/',
		file: 'CTF-Visage.obj',
		lights: 'CTF-Visage.lights.json',
		scale: 0.65,
		rotationX: -Math.PI / 2,
		yOffset: 0,
		killY: -65,                // main deck sits at native y~-37; below -65 = fell into the void
		// FFA spawns from the ROTX=-90 dense drop-probe (scripts/probe-visage.ts):
		// 5 on the left base, 3 on the right, all on the main deck (native y~-37).
		spawns: [
			{ x: -40.2, z: 4.6, y: -37.3 }, { x: -40.2, z: 31.3, y: -37.3 },
			{ x: -10.9, z: -22.1, y: -37.3 }, { x: 3.8, z: -8.7, y: -37.3 },
			{ x: 3.8, z: 17.9, y: -37.1 }, { x: 91.9, z: -8.7, y: -36.7 },
			{ x: 106.5, z: -22.1, y: -36.7 }, { x: 121.2, z: 17.9, y: -36.7 }
		]
	}
}

// Active map. Swap this one line to change maps (grove | visage).
export const MAP_MESH = MAPS.visage

export const KILL_Y = MAP_MESH.killY // fall below this world-y = death
