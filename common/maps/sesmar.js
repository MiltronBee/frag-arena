// DOM-Sesmar clone — Domination. Three control points in a wide triangle around a
// central industrial hub, so no team can watch all three at once and the round is a
// constant rotation fight. Mid-size (±30 x ±22). Each point is a low capture dais
// with a column landmark beside it (reads at a glance); the central hub blocks the
// point-to-point sniper lines. Team spawns sit west (red) / east (blue).
//
// style: 0 = cover (crate), 1 = perimeter (tall wall), 2 = reactor/dais,
//        3 = tower/pylon (column), 4 = jump-pad

const OBSTACLE_SPECS = [
	// --- Perimeter
	{ x: 0, z: -22, width: 60, height: 6, depth: 1, style: 1 },
	{ x: 0, z: 22, width: 60, height: 6, depth: 1, style: 1 },
	{ x: -30, z: 0, width: 1, height: 6, depth: 44, style: 1 },
	{ x: 30, z: 0, width: 1, height: 6, depth: 44, style: 1 },

	// --- Central hub: contested middle, breaks the A/B/C direct lines
	{ x: 0, z: 0, width: 8, height: 4, depth: 8, style: 2 },

	// --- Control point A (west-south): low capture dais + column landmark
	{ x: -22, z: -13, width: 5, height: 1, depth: 5, style: 2 },
	{ x: -22, z: -8, width: 2, height: 4, depth: 2, style: 3 },
	// --- Control point B (east-south)
	{ x: 22, z: -13, width: 5, height: 1, depth: 5, style: 2 },
	{ x: 22, z: -8, width: 2, height: 4, depth: 2, style: 3 },
	// --- Control point C (north-center)
	{ x: 0, z: 16, width: 5, height: 1, depth: 5, style: 2 },
	{ x: 0, z: 11, width: 2, height: 4, depth: 2, style: 3 },

	// --- Route cover between the points
	{ x: -13, z: 6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 13, z: 6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: -13, z: -6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 13, z: -6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 0, z: -10, width: 4, height: 2, depth: 2, style: 0 }
]

export default {
	id: 'sesmar',
	name: 'Sesmar',
	mode: 'DOM',
	ARENA_SIZE: 30,
	// Team spawns: red (team 0) hug the west wall, blue (team 1) the east — clear of
	// point A/B daises and the walls.
	SPAWN_POINTS: [
		{ x: -28, z: -18, team: 0 }, { x: -28, z: 18, team: 0 },
		{ x: -27, z: -2, team: 0 }, { x: -27, z: 2, team: 0 },
		{ x: 28, z: -18, team: 1 }, { x: 28, z: 18, team: 1 },
		{ x: 27, z: -2, team: 1 }, { x: 27, z: 2, team: 1 }
	],
	JUMP_PADS: [],
	OBSTACLE_SPECS,
	mode_data: {
		controlPoints: [
			{ id: 'A', x: -22, z: -13 },
			{ id: 'B', x: 22, z: -13 },
			{ id: 'C', x: 0, z: 16 }
		],
		scorePerTickPerPoint: 1
	}
}
