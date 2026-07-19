// DM-Curse][ clone — a compact, lethal free-for-all tech arena. Tight footprint
// (±24 x ±20) so fights are constant; a central monument + flank pillars break the
// cross-map sniper lines the open Facing Worlds platform lives on. First pass is
// single-level (Curse's upper walkways come in the verticality polish, via jump-pads
// solved with scripts/_sweep-pad.ts against the new geometry). Same box+style
// vocabulary as every map so arenaDressing skins it from the 8 Quaternius pieces.
//
// style: 0 = cover (crate), 1 = perimeter (tall wall), 2 = reactor/monument,
//        3 = tower/pylon (column), 4 = jump-pad

const OBSTACLE_SPECS = [
	// --- Perimeter (height 6 tech walls)
	{ x: 0, z: -20, width: 48, height: 6, depth: 1, style: 1 },
	{ x: 0, z: 20, width: 48, height: 6, depth: 1, style: 1 },
	{ x: -24, z: 0, width: 1, height: 6, depth: 40, style: 1 },
	{ x: 24, z: 0, width: 1, height: 6, depth: 40, style: 1 },

	// --- Central monument: the heart of the room, breaks every straight sightline
	{ x: 0, z: 0, width: 6, height: 4, depth: 6, style: 2 },

	// --- Flank pillars (tall cover columns either side of the monument)
	{ x: -11, z: 0, width: 3, height: 5, depth: 3, style: 3 },
	{ x: 11, z: 0, width: 3, height: 5, depth: 3, style: 3 },

	// --- Quadrant cover: crates that make each corner pocket fightable
	{ x: -13, z: -10, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 13, z: -10, width: 3, height: 2, depth: 3, style: 0 },
	{ x: -13, z: 10, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 13, z: 10, width: 3, height: 2, depth: 3, style: 0 },
	// --- Low cover near the mid of each long wall
	{ x: -6, z: -13, width: 4, height: 1.5, depth: 2, style: 0 },
	{ x: 6, z: -13, width: 4, height: 1.5, depth: 2, style: 0 },
	{ x: -6, z: 13, width: 4, height: 1.5, depth: 2, style: 0 },
	{ x: 6, z: 13, width: 4, height: 1.5, depth: 2, style: 0 }
]

export default {
	id: 'curse',
	name: 'Curse][',
	mode: 'DM',
	ARENA_SIZE: 24,
	// Six FFA spawns around the ring, each clear of cover and walls (verified by
	// scripts/verify-map.ts spawn check).
	SPAWN_POINTS: [
		{ x: -18, z: -14 }, { x: 18, z: -14 },
		{ x: -18, z: 14 }, { x: 18, z: 14 },
		{ x: 0, z: -15 }, { x: 0, z: 15 }
	],
	JUMP_PADS: [],
	OBSTACLE_SPECS,
	// DM pickup markers (weapon/health) for when item spawns land — data only now.
	mode_data: {
		pickups: [
			{ kind: 'health', x: 0, y: 1, z: 0 },   // on/near the contested monument
			{ kind: 'weapon', x: -18, y: 1, z: 0 },
			{ kind: 'weapon', x: 18, y: 1, z: 0 }
		]
	}
}
