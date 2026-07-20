import * as BABYLON from '../common/babylon.node.js'
import Pickup from '../common/entity/Pickup.js'
import { nearestWorldHit } from './lagCompensatedHitscanCheck.js'
import { PICKUP_TYPE, RESPAWN_SECONDS, REST_HEIGHT, resolvePickup } from '../common/pickupConfig.js'

// Drop-probe geometry (world units). Cast DOWN from PROBE_UP above the item's native
// world position; accept a floor up to PROBE_DOWN below it. Anything with no floor in
// that window is UNREACHABLE and is dropped rather than spawned (the mega-health lesson:
// never leave a pickup floating where the proximity test can never fire).
const PROBE_UP = 1.5
const PROBE_DOWN = 5.0

const DOWN = new BABYLON.Vector3(0, -1, 0)

// Load the active map's registry PICKUPS, map each UT item to a roster weapon/effect
// (common/pickupConfig.js — tunable), convert native→world with the SAME transform the
// mega uses (world = native * scale), drop-probe each against the assembled collision
// mesh (`gi.occluderMeshes`), and spawn one Pickup entity per SURVIVING item at
// floorY + restHeight. Returns { created, dropped } for the boot log / report.
//
// Called from GameInstance._loadMapMesh AFTER occluderMeshes is published (mesh maps
// load async), so the probe always runs against real geometry. A map with no PICKUPS
// block is a clean no-op.
export default function setupPickups(gi) {
	const map = gi.map
	const out = { created: [], dropped: [] }
	if (!map || !map.PICKUPS) return out

	const scale = map.scale || 1
	const meshes = gi.occluderMeshes || []
	if (meshes.length === 0) {
		console.warn('[pickups] no collision meshes available — every pickup would drop-fail; skipping')
		return out
	}

	// stable iteration order (weapon → ammo → health → armor → powerup) so the sniper
	// Rifle/SMG split is deterministic run-to-run.
	const categories = ['weapon', 'ammo', 'health', 'armor', 'powerup']
	const occ = {} // per-item occurrence counter (drives the split)

	for (const category of categories) {
		const list = map.PICKUPS[category]
		if (!Array.isArray(list)) continue
		for (const entry of list) {
			const key = category + ':' + entry.item
			const n = occ[key] || 0
			occ[key] = n + 1

			const resolved = resolvePickup(category, entry, n)
			if (!resolved) continue // OMITTED item (e.g. redeemer)

			const wx = entry.x * scale, wz = entry.z * scale, wy = entry.y * scale

			// drop-probe DOWN to the real floor under the native position
			const origin = new BABYLON.Vector3(wx, wy + PROBE_UP, wz)
			const ray = new BABYLON.Ray(origin, DOWN, PROBE_UP + PROBE_DOWN)
			const dist = nearestWorldHit(meshes, ray, PROBE_UP + PROBE_DOWN)
			if (!Number.isFinite(dist)) {
				out.dropped.push({ category, item: entry.item, x: wx, y: wy, z: wz })
				console.warn(`[pickups] DROP ${category}/${entry.item} @(${wx.toFixed(1)},${wy.toFixed(1)},${wz.toFixed(1)}) — no floor within ${PROBE_DOWN}m`)
				continue
			}
			const floorY = origin.y - dist
			const restY = floorY + (REST_HEIGHT[resolved.type] || 0.3)

			const pk = new Pickup(wx, restY, wz, resolved.type, resolved.weaponIndex)
			pk.respawnMs = (RESPAWN_SECONDS[resolved.type] || 30) * 1000
			gi.instance.addEntity(pk)
			out.created.push(pk)
		}
	}

	const byType = {}
	for (const p of out.created) byType[p.type] = (byType[p.type] || 0) + 1
	console.log(`[pickups] spawned ${out.created.length} (weapon:${byType[PICKUP_TYPE.WEAPON]||0} ammo:${byType[PICKUP_TYPE.AMMO]||0} health:${byType[PICKUP_TYPE.HEALTH]||0} armor:${byType[PICKUP_TYPE.ARMOR]||0} powerup:${byType[PICKUP_TYPE.POWERUP]||0}), dropped ${out.dropped.length} unreachable`)
	return out
}
