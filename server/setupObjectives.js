import Flag from '../common/entity/Flag.js'
import ControlPoint from '../common/entity/ControlPoint.js'
import { effectiveMode } from '../common/mapRegistry.js'

// Rest height above the probed floor for an objective marker (mirrors SPAWN_REST /
// the pickup REST_HEIGHT convention).
const OBJECTIVE_REST = 0.5

// Drop-probe the active map's mode objectives onto the REAL collision floor and spawn
// one entity per objective — the SAME pattern setupPickups / buildTeleporters use.
// Called from GameInstance._loadMapMesh AFTER occluderMeshes is published (mesh maps
// load async), so every probe runs against real geometry. Reads the objective data
// already embedded in common/mapRegistry.js (visage.mode_data.flags,
// dom_elder.mode_data.controlPoints); native units -> world = native * scale, exactly
// like SPAWN_POINTS / PICKUPS / TELEPORTERS. No drop-probe y is stored in the registry
// (by design), so we probe each here — never leaving an objective floating where the
// proximity test can't fire (the mega-health lesson).
//
// Returns { flags, points }. A map whose effective mode is not CTF/DOM, or with no
// mode_data, is a clean no-op.
export default function setupObjectives(gi) {
	const map = gi.map
	const out = { flags: [], points: [] }
	const md = map && map.mode_data
	if (!md) return out

	const scale = map.scale || 1
	const mode = effectiveMode(map)

	if (mode === 'CTF' && Array.isArray(md.flags)) {
		for (const f of md.flags) {
			const wx = f.x * scale, wz = f.z * scale, wy = f.y * scale
			const floorY = gi._dropProbeY(wx, wy, wz)
			const y = (floorY != null ? floorY : wy) + OBJECTIVE_REST
			if (floorY == null) console.warn(`[objectives] flag team ${f.team} @(${wx.toFixed(1)},${wy.toFixed(1)},${wz.toFixed(1)}) — no floor; resting at native y`)
			const flag = new Flag(wx, y, wz, f.team)
			gi.instance.addEntity(flag)
			out.flags.push(flag)
		}
	}

	if (mode === 'DOM' && Array.isArray(md.controlPoints)) {
		md.controlPoints.forEach((cp, i) => {
			const wx = cp.x * scale, wz = cp.z * scale, wy = cp.y * scale
			const floorY = gi._dropProbeY(wx, wy, wz)
			const y = (floorY != null ? floorY : wy) + OBJECTIVE_REST
			if (floorY == null) console.warn(`[objectives] point ${cp.id || i} @(${wx.toFixed(1)},${wy.toFixed(1)},${wz.toFixed(1)}) — no floor; resting at native y`)
			const point = new ControlPoint(wx, y, wz, i)
			gi.instance.addEntity(point)
			out.points.push(point)
		})
	}

	if (out.flags.length || out.points.length) {
		console.log(`[objectives] ${mode}: ${out.flags.length} flags, ${out.points.length} control points`)
	}
	return out
}
