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
//
// Per-map `walkable` and `mega` (also native units) exist because two subsystems used
// to hardcode the OLD BOX ARENA's world — a ±64 network view box at the origin, and a
// mega-health pickup at (0, 1, 6). Both are meaningless on an artist mesh that sits at
// an arbitrary height and extent, so both are now map data:
//   walkable — AABB of the near-horizontal (|normal.y| >= 0.7) floor triangles. Only a
//              BOOT FALLBACK: GameInstance._loadMapMesh re-derives it from the real
//              mesh once the OBJ is in, so a new map needs no hand-measured numbers.
//              Numbers below were measured with _work/netfix/probe8.ts and ROUNDED
//              OUTWARD — the fallback must never be tighter than the derived box, or
//              the boot window would cull something the real box keeps.
//   mega     — the WALKABLE SURFACE point under the mega-health pickup (the server adds
//              the MEGA.Y bob height in world units, exactly as it does over the box
//              arena's y=0 floor). Verified on real floor + reachable, see probe9.ts.
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
		],
		// 10528 near-horizontal tris. Grove's OBJ winding is INVERTED (its floors read
		// normal.y = -1.000), which is why the extraction tests |normal.y|, not normal.y.
		walkable: { minX: -35.4, minY: -4.9, minZ: -48.8, maxX: 48.8, maxY: 35.1, maxZ: 37.7 },
		// mid-arena floor 7.0m clear of every spawn (world (-3.45, 11.10, 3.43); a player
		// dropped there settles at world y 11.545, i.e. 0.55 under the pickup).
		mega: { x: -5.300, y: 17.069, z: 5.269 }
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
		],
		// 2126 near-horizontal tris => world x[-35.39..102.18] y[-57.08..16.15]
		// z[-27.33..24.34]. The east deck reaching world x=+102 is what the old ±64
		// origin-centred view box was cutting in half (~39% of the walkable floor).
		walkable: { minX: -54.5, minY: -87.9, minZ: -42.1, maxX: 157.3, maxY: 24.9, maxZ: 37.5 },
		// APEX of the central bridge — the Facing-Worlds power position: the highest,
		// most exposed point on the only route between the two towers, and the widest
		// part of the span (solid walkable world-z -11..+7 at world x=34). World
		// (34.0, -17.84, -2.0); a player there settles at world y -17.285.
		mega: { x: 52.308, y: -27.446, z: -3.077 }
	}
}

// Active map. Swap this one line to change maps (grove | visage).
export const MAP_MESH = MAPS.visage

export const KILL_Y = MAP_MESH.killY // fall below this world-y = death
