// Shared arena geometry. The server owns collision entities built from this list;
// the client receives those same dimensions and layers cosmetic materials on top.

export const ARENA_SIZE = 44

export const SPAWN_POINTS = [
	{ x: -15, z: -15 },
	{ x: -15, z: 15 },
	{ x: 15, z: 15 },
	{ x: 15, z: -15 },
	{ x: 0, z: -16 },
	{ x: 16, z: 0 },
	{ x: 0, z: 16 },
	{ x: -16, z: 0 }
]

// style: 0 = cover, 1 = perimeter, 2 = reactor, 3 = pylon
export const OBSTACLE_SPECS = [
	// Perimeter walls
	{ x: 0, z: -22, width: 44, height: 4, depth: 1, style: 1 },
	{ x: 0, z: 22, width: 44, height: 4, depth: 1, style: 1 },
	{ x: -22, z: 0, width: 1, height: 4, depth: 44, style: 1 },
	{ x: 22, z: 0, width: 1, height: 4, depth: 44, style: 1 },

	// Central landmark and directional cover
	{ x: 0, z: 0, width: 4, height: 3.5, depth: 4, style: 2 },
	{ x: -9, z: -5, width: 3, height: 2.5, depth: 7, style: 0 },
	{ x: 9, z: 5, width: 3, height: 2.5, depth: 7, style: 0 },
	{ x: -5, z: 9, width: 7, height: 2.5, depth: 3, style: 0 },
	{ x: 5, z: -9, width: 7, height: 2.5, depth: 3, style: 0 },

	// Tall corner pylons make each quadrant readable at speed
	{ x: -11, z: -11, width: 2.5, height: 5, depth: 2.5, style: 3 },
	{ x: 11, z: -11, width: 2.5, height: 5, depth: 2.5, style: 3 },
	{ x: -11, z: 11, width: 2.5, height: 5, depth: 2.5, style: 3 },
	{ x: 11, z: 11, width: 2.5, height: 5, depth: 2.5, style: 3 }
]

export const obstacleY = height => (height - 1) * 0.5
