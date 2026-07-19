// Map registry. Every playable map is a data module exporting { id, name, mode,
// ARENA_SIZE, SPAWN_POINTS, JUMP_PADS, OBSTACLE_SPECS, mode_data }. The live game
// still reads common/arenaConfig.js directly (Facing Worlds); this registry is what
// the map harness verifies and what map selection / the mode layer will consume.
import facingWorlds from './facingWorlds'
import curse from './curse'
import sesmar from './sesmar'
import rook from './rook'

export const maps = { facingWorlds, curse, sesmar, rook }
export const mapList = [facingWorlds, curse, sesmar, rook]

// default = Facing Worlds, matching what production serves today.
export const DEFAULT_MAP = 'facingWorlds'

export function getMap(id) {
	const m = maps[id]
	if (!m) throw new Error(`unknown map '${id}' (have: ${Object.keys(maps).join(', ')})`)
	return m
}
