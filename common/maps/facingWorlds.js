// Facing Worlds (CTF-Face clone) as a registry map. It re-wraps the LIVE arena
// source in common/arenaConfig.js — the running game still reads arenaConfig
// directly, so nothing here changes production; this just exposes the map through
// the common/maps registry so the harness + (later) map selection can treat all
// maps uniformly.
import { ARENA_SIZE, SPAWN_POINTS, OBSTACLE_SPECS, JUMP_PADS } from '../arenaConfig'

export default {
	id: 'facingWorlds',
	name: 'Facing Worlds',
	mode: 'CTF',
	ARENA_SIZE,
	SPAWN_POINTS,
	OBSTACLE_SPECS,
	JUMP_PADS,
	// CTF mode data: a flag sits on each tower deck (stand height 8.0). Wired when
	// the CTF mode lands; harmless data until then.
	mode_data: {
		flags: [
			{ team: 0, x: -48, y: 8.0, z: 0 }, // west (red) deck
			{ team: 1, x: 48, y: 8.0, z: 0 }   // east (blue) deck
		]
	}
}
