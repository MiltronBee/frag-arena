// UT99-style teleporters — server-authoritative trigger + placement.
//
// The map registry carries the raw UT teleporter actors (TELEPORTERS, native
// units); common/teleporterData.js pairs them into functional portals (tag/url,
// case-insensitive) and does the native->world x/z + yaw math shared with the
// client's portal visuals. This module adds the parts only the server can do:
// drop-probing entry/exit onto the REAL collision floor (same pattern as
// GameInstance.spawnPoint) and the per-tick proximity trigger.
//
// Teleporting is applied by GameInstance.applyTeleport (raw + smooth entity in
// lockstep — the same footgun rule as every other replicated field), NOT here:
// this module owns geometry + detection only, so it stays trivially testable.

import { pairPortals } from '../common/teleporterData'

// Trigger geometry (world metres). UT teleporters trigger on capsule contact;
// a 1.2m horizontal radius around the actor with a [-0.5, +2.2] vertical band
// over the probed floor reads the same in practice (players are ~1.8m tall).
const TRIGGER_RADIUS = 1.2
const TRIGGER_Y_BELOW = 0.5
const TRIGGER_Y_ABOVE = 2.2

// Re-trigger guards. TWO of them, layered:
//   1. entity._teleInside — UT's real rule: a portal only fires on the RISING
//      edge of trigger contact (outside -> inside). Arriving inside the
//      destination's twin trigger (bidirectional pairs whose destination has
//      no yaw get no exit offset, e.g. Grove's L3_secret4) sets the flag, so a
//      player standing still on the exit does NOT bounce back — proven by
//      scripts/_probe-teleport.mjs, which ping-ponged every 0.75s without this.
//      The flag clears the first tick the entity stands outside every trigger.
//   2. entity._teleCooldown (seconds) — a short absolute floor between
//      teleports, so even a dodge that exits and re-enters a trigger within a
//      tick or two can't chain instantly.
const TELE_COOLDOWN = 0.75

// Build the functional portals for a map record, snapped to the collision
// floor. `dropProbeY(wx, wy, wz)` is GameInstance._dropProbeY — MUST be called
// after the collision mesh is loaded or every probe misses and portals fall
// back to the raw native y (never worse than the actor's authored height).
// Returns [] for maps without TELEPORTERS (box arenas, DM-Somnus).
export function buildTeleporters(mapRecord, dropProbeY) {
	const { portals, inert } = pairPortals(mapRecord)
	const s = (mapRecord && mapRecord.scale) || 1
	const built = portals.map(p => {
		// mirror spawnPoint(): probe from 3 native units above the actor so the
		// ray starts above the floor it belongs to, fall back to nativeY*s on a miss
		const ey = dropProbeY(p.entry.x, (p.entry.nativeY + 3) * s, p.entry.z)
		const xy = dropProbeY(p.exit.x, (p.exit.nativeY + 3) * s, p.exit.z)
		return {
			tag: p.tag,
			url: p.url,
			entryX: p.entry.x,
			entryY: ey != null ? ey : p.entry.nativeY * s,
			entryZ: p.entry.z,
			exitX: p.exit.x,
			exitY: xy != null ? xy : p.exit.nativeY * s,
			exitZ: p.exit.z,
			exitYaw: p.exitYaw, // world radians or null = keep the player's facing
		}
	})
	if (inert.length) {
		console.log(`[teleporters] ${mapRecord.id}: ${built.length} functional, `
			+ `${inert.length} inert (${inert.map(i => `${i.tag}: ${i.reason}`).join('; ')})`)
	} else if (built.length) {
		console.log(`[teleporters] ${mapRecord.id}: ${built.length} functional portals`)
	}
	return built
}

// Is the entity inside this portal's trigger volume?
function insideTrigger(entity, p) {
	const dx = entity.x - p.entryX
	const dz = entity.z - p.entryZ
	if (dx * dx + dz * dz > TRIGGER_RADIUS * TRIGGER_RADIUS) return false
	return entity.y >= p.entryY - TRIGGER_Y_BELOW && entity.y <= p.entryY + TRIGGER_Y_ABOVE
}

// Per-tick, per-alive-entity trigger test. Ticks the entity's cooldown down by
// dtSeconds and returns the portal the entity STEPPED INTO this tick (caller
// applies the teleport), or null. Fires only on the outside->inside edge (see
// _teleInside above) and re-arms the cooldown on fire.
export function checkTeleport(entity, portals, dtSeconds) {
	if (entity._teleCooldown > 0) {
		// while cooling down, don't touch _teleInside: it stays true from the
		// arrival until the first post-cooldown tick spent outside every trigger.
		entity._teleCooldown -= dtSeconds
		return null
	}
	if (!portals || portals.length === 0) return null
	for (let i = 0; i < portals.length; i++) {
		const p = portals[i]
		if (!insideTrigger(entity, p)) continue
		if (entity._teleInside) return null // still standing where we arrived
		entity._teleInside = true
		entity._teleCooldown = TELE_COOLDOWN
		return p
	}
	entity._teleInside = false // outside every trigger: re-arm the edge
	return null
}

export { TELE_COOLDOWN }
