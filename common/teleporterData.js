// Shared UT99 teleporter pairing + native->world math — the ONE place both the
// server trigger logic (server/teleporters.js) and the client portal visuals
// (BABYLONRenderer._addTeleporterMarkers) derive functional portals from a map
// record's TELEPORTERS array, so the two can never disagree about which portals
// exist or where they are.
//
// TELEPORTERS entries are NATIVE-unit UT actors (same convention as SPAWN_POINTS:
// x/z horizontal, y = height, multiply by rec.scale for world units):
//   { x, z, y, class: 'Teleporter'|'VisibleTeleporter', yaw?, tag, url?, nav_id? }
// A teleporter with a `url` is a SENDER: stepping into it sends you to the
// teleporter whose `tag` equals that url (case-insensitive). A teleporter with no
// url (or whose url names no tag) is INERT as an entry — it can still RECEIVE.

// UT yaw (degrees) -> world yaw (radians), where world yaw θ faces
// dir = (sin θ, 0, cos θ) in x/z — the convention of camera.rotation.y,
// entity.mesh.lookAt and BotController.aimYaw (camRayX = sin(aimYaw)).
//
// VALIDATED EMPIRICALLY by scripts/_teleporter-yaw-check.mjs (horizontal
// clearance rays from all 10 yaw-carrying portal exits across the 4 teleporter
// maps, 8 sign/offset candidates): winner θ_world = 90° - θ_ut with mean
// clearance 5.03m vs runner-up (θ+90°) 4.18m — decided by DM-Gantry16][
// (10.0m vs 1.1m; Visage's near-0°/180° yaws can't tell the sign apart).
// Meaning: UT 0° faces world +x, UT angles run counter-clockwise while world
// yaw runs clockwise from +z. Re-run the script before changing this.
export function utYawToWorldYaw(utDeg) {
	const rad = (90 - utDeg) * Math.PI / 180
	// normalize to (-π, π] just to keep logs readable
	const t = Math.atan2(Math.sin(rad), Math.cos(rad))
	return Object.is(t, -0) ? 0 : t
}

// How far past the destination actor the arrival point sits, along the exit
// facing (world metres). Clears the destination portal's own trigger footprint
// (the per-entity cooldown is the real re-trigger guard; this just avoids
// materializing inside the receiving portal's visual).
export const EXIT_FORWARD_OFFSET = 0.6

// Entries whose exit lands within this horizontal distance of the entry AND
// within DEGENERATE_PAIR_DY world-metres vertically are DEGENERATE (DOM-Elder's
// stacked sender/receiver actors sit ~0.01m apart in x/z and ≤2.7m in y, and
// both drop-probe onto the SAME floor — verified against the collision mesh):
// teleporting would move the player nowhere and re-fire FX every cooldown
// expiry while they stand in the trigger. They are built INERT instead.
// The vertical allowance keeps genuinely VERTICAL portals functional —
// CTF-Visage's buffybabe pair is deck<->tower-top at near-identical x/z but
// ~36m apart in y.
export const DEGENERATE_PAIR_DIST = 1.5
export const DEGENERATE_PAIR_DY = 3.0

// Pair a map record's TELEPORTERS into functional portals.
// Returns { portals, inert } where each portal is:
//   {
//     tag, url,                    // sender identity + destination tag
//     entry: { x, z, nativeY },    // world x/z, native y (caller resolves floor)
//     exit:  { x, z, nativeY },    // world x/z incl. EXIT_FORWARD_OFFSET when
//                                  // the destination has a yaw; native y
//     exitYaw,                     // world yaw (radians) or null = keep facing
//   }
// and inert is an array of { tag, reason } for logging. Pure data — no probing,
// no Babylon; world y resolution differs by consumer (server drop-probes to the
// real floor, the client just uses nativeY*scale + a visual hover).
export function pairPortals(record) {
	const list = Array.isArray(record && record.TELEPORTERS) ? record.TELEPORTERS : []
	const s = (record && record.scale) || 1
	const portals = []
	const inert = []
	const byTag = new Map() // lower-cased tag -> actor (first wins, matching UT)
	for (const t of list) {
		const key = String(t.tag || '').toLowerCase()
		if (key && !byTag.has(key)) byTag.set(key, t)
	}
	for (const t of list) {
		if (!t.url) { inert.push({ tag: t.tag, reason: 'no url (receiver-only)' }); continue }
		const d = byTag.get(String(t.url).toLowerCase())
		if (!d) { inert.push({ tag: t.tag, reason: `url '${t.url}' matches no tag` }); continue }
		if (d === t) { inert.push({ tag: t.tag, reason: 'url points at itself' }); continue }
		const exitYaw = (d.yaw === undefined || d.yaw === null) ? null : utYawToWorldYaw(d.yaw)
		let ex = d.x * s
		let ez = d.z * s
		if (exitYaw !== null) {
			ex += Math.sin(exitYaw) * EXIT_FORWARD_OFFSET
			ez += Math.cos(exitYaw) * EXIT_FORWARD_OFFSET
		}
		const enx = t.x * s
		const enz = t.z * s
		if (Math.hypot(ex - enx, ez - enz) < DEGENERATE_PAIR_DIST
			&& Math.abs((d.y - t.y) * s) < DEGENERATE_PAIR_DY) {
			inert.push({ tag: t.tag, reason: `exit '${t.url}' is co-located (degenerate)` })
			continue
		}
		portals.push({
			tag: t.tag,
			url: t.url,
			entry: { x: enx, z: enz, nativeY: t.y },
			exit: { x: ex, z: ez, nativeY: d.y },
			exitYaw,
		})
	}
	return { portals, inert }
}
