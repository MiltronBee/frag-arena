// Shared arena geometry. The server owns collision entities built from this list;
// the client receives those same dimensions and layers cosmetic materials on top.
//
// MAP: "Facing Worlds" — our own homage to the twin-towers-in-space CTF archetype
// (original geometry, no ripped assets). A long platform floating in orbit over
// Earth, a tall sniping tower at each end, an exposed no-man's-land gauntlet between
// them. Deliberately TALL towers (height is the point — it makes sniping the
// defining skill), a flag base at each tower front, jump-pad "lifts" up to the top
// sniper deck. Kept within ±64 on every axis so nothing crosses the origin-centered
// ±64 network view box (GameInstance.js).

export const ARENA_SIZE = 60 // half-span of the long (X) axis; 120 total

// Symmetric spawns at each tower base (NOT inside the tower footprint or on a pad).
// Requires the spawnPoint() fix in server/GameInstance.js to actually be used.
export const SPAWN_POINTS = [
	// West base
	{ x: -36, z: -8 }, { x: -36, z: 8 }, { x: -32, z: -4 }, { x: -32, z: 4 },
	// East base
	{ x: 36, z: -8 }, { x: 36, z: 8 }, { x: 32, z: -4 }, { x: 32, z: 4 }
]

// Jump-pads = the tower lifts. SOLVED, not guessed (see scripts/_sweep-pad.ts +
// verify-map.ts): a pad flush to the tower throws you into the wall below the deck,
// so each pad sits out in the courtyard and the arc is tuned so you're ABOVE the
// deck top when you cross the tower's front face, then descend onto it. Re-solved
// for the height-10 towers below. launch* are ignored by setupObstacles so these
// specs double as collision/render boxes AND the launch table.
const JUMP_PAD_SPECS = [
	{ x: -35, z: 0, width: 4, height: 1, depth: 4, style: 4, launchX: -10, launchY: 20, launchZ: 0 },
	{ x: 35, z: 0, width: 4, height: 1, depth: 4, style: 4, launchX: 10, launchY: 20, launchZ: 0 }
]
export const JUMP_PADS = JUMP_PAD_SPECS

// style: 0 = cover, 1 = perimeter, 2 = reactor/base, 3 = tower/pylon, 4 = jump-pad
export const OBSTACLE_SPECS = [
	// --- Perimeter walls, height 12 so a player launched onto a 10-high tower deck
	// can't dodge-jump over the wall and get stranded off-platform (no fall-death /
	// no kill-Z in this engine; y is hard-clamped >= 0).
	{ x: 0, z: -22, width: 120, height: 12, depth: 1, style: 1 },
	{ x: 0, z: 22, width: 120, height: 12, depth: 1, style: 1 },
	{ x: -60, z: 0, width: 1, height: 12, depth: 44, style: 1 },
	{ x: 60, z: 0, width: 1, height: 12, depth: 44, style: 1 },

	// --- West tower (tall sniping deck; stand height y=10)
	{ x: -50, z: 0, width: 14, height: 10, depth: 14, style: 3 },
	// --- East tower
	{ x: 50, z: 0, width: 14, height: 10, depth: 14, style: 3 },

	// --- Jump-pad "lifts" at each tower front (courtyard placement, solved arc)
	...JUMP_PAD_SPECS,

	// --- Flag bases: a low U-alcove at each tower front, open toward center, so the
	// flag has a defensible pocket at the base (the objective sits in mode_data).
	{ x: -42, z: 7, width: 8, height: 3, depth: 1, style: 1 },
	{ x: -42, z: -7, width: 8, height: 3, depth: 1, style: 1 },
	{ x: 42, z: 7, width: 8, height: 3, depth: 1, style: 1 },
	{ x: 42, z: -7, width: 8, height: 3, depth: 1, style: 1 },

	// --- Central gauntlet: the long exposed crossing. A modest central spine + two
	// flank pillars give partial breaks (snipers still rule the lane from the decks),
	// and staggered low cover gives ground fighters advancing routes without making
	// the middle safe.
	{ x: 0, z: 0, width: 5, height: 4, depth: 10, style: 2 },
	{ x: -30, z: 0, width: 3, height: 5, depth: 6, style: 2 },
	{ x: 30, z: 0, width: 3, height: 5, depth: 6, style: 2 },
	{ x: -22, z: 9, width: 4, height: 2, depth: 3, style: 0 },
	{ x: 22, z: -9, width: 4, height: 2, depth: 3, style: 0 },
	{ x: -22, z: -9, width: 4, height: 2, depth: 3, style: 0 },
	{ x: 22, z: 9, width: 4, height: 2, depth: 3, style: 0 },
	{ x: -11, z: 5, width: 3, height: 1.5, depth: 3, style: 0 },
	{ x: 11, z: -5, width: 3, height: 1.5, depth: 3, style: 0 },
	{ x: -11, z: -5, width: 3, height: 1.5, depth: 3, style: 0 },
	{ x: 11, z: 5, width: 3, height: 1.5, depth: 3, style: 0 },
	// --- base flank cover near each tower
	{ x: -40, z: 11, width: 3, height: 2.5, depth: 3, style: 0 },
	{ x: -40, z: -11, width: 3, height: 2.5, depth: 3, style: 0 },
	{ x: 40, z: 11, width: 3, height: 2.5, depth: 3, style: 0 },
	{ x: 40, z: -11, width: 3, height: 2.5, depth: 3, style: 0 }
]

export const obstacleY = height => (height - 1) * 0.5
