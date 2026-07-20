// The ACTIVE map, as MODULE-LEVEL LIVE BINDINGS.
//
// Historically USE_MESH_MAP / MAP_MESH / KILL_Y were compile-time `const`s and the map
// data lived inline here. The data now lives in ONE reconciled registry
// (common/mapRegistry.js), and these three exports are the RUNTIME-SELECTED active map:
// `let` bindings that setActiveMap() reassigns. ES module named exports are LIVE
// bindings, so every importer (server/GameInstance, server/navGraph, server/
// BotController, client/graphics/*, common/applyCommand) sees the current value the
// next time it READS the binding — none of them read it at module-eval time, they read
// inside functions, so the runtime switch reaches all of them without a signature change.
//
// DETERMINISM (why a module-scoped active map is safe for applyCommand):
//   applyCommand(entity, command) must stay a PURE function of its two args and replay
//   byte-identically during client reconciliation. It reads USE_MESH_MAP for the
//   GROUND_Y clamp. A single game INSTANCE runs exactly ONE map, and a tick is
//   SYNCHRONOUS (no await between setActiveMap and the applyCommand calls it drives), so
//   the active map is a constant for the whole of any tick and for any reconciliation
//   replay of that instance's commands. The server calls setActiveMap(this.map) at the
//   top of every GameInstance.update(); the client calls it once for the instance it is
//   connected to. Reconciliation replays with that same value -> identical output.
//   (Multiple instances with DIFFERENT maps in one process stay correct because each
//   sets its map at the top of its own synchronous tick — proven by the determinism
//   replay harness in _work/mapfoundation.)
//
// The DEFAULT active map is CTF-Visage, so with no selection everything behaves EXACTLY
// as the live game: USE_MESH_MAP === true, MAP_MESH === the Visage record (byte-identical
// spawns / killY -65 / walkable / mega bridge-apex), KILL_Y === -65.
//
// ---- background on the per-map fields (unchanged semantics) ----
// Fall-death: mesh maps have REAL floors with edges, so applyCommand drops its global
// y>=0 clamp and the server kills anyone who falls below killY (GameInstance.update).
// All maps share ONE scale (0.65). spawns/killY are in native (ROTX=-90) units — the
// server multiplies them by scale at runtime. Per-map `walkable` (AABB of the near-
// horizontal floor, a boot-window view-box fallback) and `mega` (walkable point under
// the mega-health pickup) are likewise native units. See common/mapRegistry.js for the
// full field documentation and the reconciliation of the two old registries.

import { getMapRecord, DEFAULT_MAP_ID } from './mapRegistry'

// The active map record and the three derived live bindings. Default = CTF-Visage.
let MAP_MESH = getMapRecord(DEFAULT_MAP_ID)
let USE_MESH_MAP = MAP_MESH.useMeshMap
let KILL_Y = MAP_MESH.killY // fall below this native-y = death

export { MAP_MESH, USE_MESH_MAP, KILL_Y }

// Select the active map (id string or record). Both server and client call this before
// ticking; the reassignment is visible to every importer via ES live bindings. Returns
// the resolved record so callers can also hold it as instance state.
export function setActiveMap(idOrRecord) {
	MAP_MESH = getMapRecord(idOrRecord)
	USE_MESH_MAP = MAP_MESH.useMeshMap
	KILL_Y = MAP_MESH.killY
	return MAP_MESH
}

export function getActiveMap() {
	return MAP_MESH
}
