// AS-Rook clone — Assault. A linear fortress the attackers breach in stages while
// defenders hold each line: outer gate -> courtyard -> inner door -> keep. Long,
// narrow footprint (±40 x ±16) so the push has a clear direction of travel. The
// staged walls each leave a central gap (the objective chokepoint); the keep is a
// solid fortress backstop with the final capture in front of it. First pass keeps
// every objective at ground level (the keep-top capture + its lift come in the
// verticality polish). Skinned from the same 8 Quaternius pieces as every map.
//
// style: 0 = cover (crate), 1 = perimeter/fortress wall, 2 = objective dais,
//        3 = tower/keep, 4 = jump-pad

const OBSTACLE_SPECS = [
	// --- Perimeter (tall fortress walls)
	{ x: 0, z: -16, width: 80, height: 8, depth: 1, style: 1 },
	{ x: 0, z: 16, width: 80, height: 8, depth: 1, style: 1 },
	{ x: -40, z: 0, width: 1, height: 8, depth: 32, style: 1 },
	{ x: 40, z: 0, width: 1, height: 8, depth: 32, style: 1 },

	// --- STAGE 1: outer gate wall at x=-12, central gap z[-4,4] = the breach point
	{ x: -12, z: -10, width: 2, height: 6, depth: 12, style: 1 },
	{ x: -12, z: 10, width: 2, height: 6, depth: 12, style: 1 },

	// --- Courtyard cover (attackers crossing open ground under defender fire)
	{ x: -4, z: -6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: -4, z: 6, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 4, z: 0, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 8, z: -8, width: 3, height: 2, depth: 3, style: 0 },
	{ x: 8, z: 8, width: 3, height: 2, depth: 3, style: 0 },

	// --- STAGE 2: inner door wall at x=+16, central gap z[-2,2]
	{ x: 16, z: -9, width: 2, height: 6, depth: 14, style: 1 },
	{ x: 16, z: 9, width: 2, height: 6, depth: 14, style: 1 },

	// --- STAGE 3: the keep — solid fortress backstop, final capture sits in front
	{ x: 30, z: 0, width: 14, height: 6, depth: 20, style: 3 },
	// --- final-objective dais just in front of the keep
	{ x: 23, z: 0, width: 4, height: 1, depth: 4, style: 2 }
]

export default {
	id: 'rook',
	name: 'Rook',
	mode: 'AS',
	ARENA_SIZE: 40,
	// team 0 = attackers (spawn far west), team 1 = defenders (spawn at the keep).
	SPAWN_POINTS: [
		{ x: -38, z: -8, team: 0 }, { x: -38, z: 8, team: 0 },
		{ x: -36, z: -3, team: 0 }, { x: -36, z: 3, team: 0 },
		{ x: 20, z: -8, team: 1 }, { x: 20, z: 8, team: 1 },
		{ x: 22, z: -3, team: 1 }, { x: 22, z: 3, team: 1 }
	],
	JUMP_PADS: [],
	OBSTACLE_SPECS,
	mode_data: {
		// Sequential objectives — attackers must take them in order; defenders hold.
		objectives: [
			{ id: 'gate', label: 'Breach the outer gate', x: -12, z: 0 },
			{ id: 'door', label: 'Force the inner door', x: 16, z: 0 },
			{ id: 'keep', label: 'Capture the keep', x: 23, z: 0 }
		],
		attackerTeam: 0,
		defenderTeam: 1
	}
}
