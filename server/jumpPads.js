// UT99 JUMP PADS (Kickers) — server-authoritative trigger + launch, on the
// server/teleporters.js pattern (build-at-map-load with floor drop-probe + a per-tick
// rising-edge proximity trigger). A pad launch IS a Teleported message with UNCHANGED
// position and a NEW velocity: GameInstance.applyJumpPad sets velY (and a horizontal
// component along the pad's yaw) on raw+smooth in lockstep, then hands the owner client
// the new velocity via Teleported (same x/y/z, TELEPORT_KEEP_YAW). Bots have no socket —
// the server-side velocity IS their launch.
//
// The map registry carries the raw Kicker actors (JUMP_PADS, native units — same
// convention as TELEPORTERS/SPAWN_POINTS); UT's KickVelocity was NOT captured in
// extraction, so launch strength is tuned here (env-overridable).

import { utYawToWorldYaw } from '../common/teleporterData'

// Trigger geometry (world metres). Kickers fire on capsule contact; a 1.1 m horizontal
// radius with a [-0.5, +2.0] vertical band over the probed floor reads the same.
const TRIGGER_RADIUS = 1.1
const TRIGGER_Y_BELOW = 0.5
const TRIGGER_Y_ABOVE = 2.0

// Re-trigger guard (mirror of teleporters.js): fire only on the RISING edge of contact,
// plus a short absolute cooldown so a landing that clips the pad can't chain.
const PAD_COOLDOWN = 0.5

// --- LAUNCH TUNING (env-overridable) -------------------------------------------------
// Vertical launch speed. apex = v^2 / 2g (g = GRAVITY 18): 20 -> ~11.1 m apex, matching
// the Morpheus tower kickers (spec: ~10-12 m). A yaw-carrying pad also gets a horizontal
// component = HFRAC * VY along its facing (spec: ~40%).
const LAUNCH_VY = Number(process.env.JUMPPAD_VY) || 20
const LAUNCH_HFRAC = process.env.JUMPPAD_HFRAC !== undefined ? Number(process.env.JUMPPAD_HFRAC) : 0.4

// Build world-space pads for a map record, snapped to the collision floor.
// `dropProbeY(wx, wy, wz)` = GameInstance._dropProbeY (call AFTER the mesh loads).
// Returns [] for maps without JUMP_PADS.
export function buildJumpPads(mapRecord, dropProbeY) {
	const list = Array.isArray(mapRecord && mapRecord.JUMP_PADS) ? mapRecord.JUMP_PADS : []
	const s = (mapRecord && mapRecord.scale) || 1
	const built = list.map(k => {
		const x = k.x * s
		const z = k.z * s
		const fy = dropProbeY(x, (k.y + 3) * s, z) // probe from 3 native units above the actor
		const y = fy != null ? fy : k.y * s
		let launchX = 0
		let launchZ = 0
		if (k.yaw !== undefined && k.yaw !== null) {
			const wy = utYawToWorldYaw(k.yaw)
			const hSpeed = LAUNCH_VY * LAUNCH_HFRAC
			launchX = Math.sin(wy) * hSpeed
			launchZ = Math.cos(wy) * hSpeed
		}
		return { x, y, z, launchX, launchY: LAUNCH_VY, launchZ }
	})
	if (built.length) console.log(`[jumppads] ${mapRecord.id}: ${built.length} pads (vy=${LAUNCH_VY}, hfrac=${LAUNCH_HFRAC})`)
	return built
}

// Inside a pad's trigger volume?
function insidePad(entity, p) {
	const dx = entity.x - p.x
	const dz = entity.z - p.z
	if (dx * dx + dz * dz > TRIGGER_RADIUS * TRIGGER_RADIUS) return false
	return entity.y >= p.y - TRIGGER_Y_BELOW && entity.y <= p.y + TRIGGER_Y_ABOVE
}

// Per-tick, per-alive-entity trigger. Ticks the entity's pad cooldown and returns the pad
// it STEPPED ONTO this tick (caller applies the launch), or null. Fires only on the
// outside->inside edge (entity._padInside) and re-arms the cooldown on fire. Uses a
// dedicated flag/cooldown so it never fights the teleporter guard on the same entity.
export function checkJumpPad(entity, pads, dtSeconds) {
	if (entity._padCooldown > 0) {
		entity._padCooldown -= dtSeconds
		return null
	}
	if (!pads || pads.length === 0) return null
	for (let i = 0; i < pads.length; i++) {
		const p = pads[i]
		if (!insidePad(entity, p)) continue
		if (entity._padInside) return null
		entity._padInside = true
		entity._padCooldown = PAD_COOLDOWN
		return p
	}
	entity._padInside = false
	return null
}

export { PAD_COOLDOWN }
