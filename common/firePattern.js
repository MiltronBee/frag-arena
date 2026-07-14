// Deterministic per-shot spread patterns, shared VERBATIM by the server's damage
// rays and the client's predicted tracers/impacts. Both sides derive the same
// seed from (shooter nid, weapon index, magazine ammo), so the pellet marks the
// shooter paints on a wall are the same rays the server judged damage with —
// prediction stays instant, no extra round trips.
//
// UT99 north star: every weapon must be identifiable from the mess it leaves.
//   Pistol  (Enforcer) — slow, near-laser single holes.
//   Rifle   (discipline) — tight group, small bloom under sustained fire.
//   SMG     (Minigun)  — rate-over-accuracy hose; the cone visibly grows with heat.
//   Shotgun (Flak)     — a FIXED rosette stamp: center pellet + jittered ring.
// Pure math, zero babylon imports (server + unit-testable under plain node).

// tiny fast deterministic PRNG (mulberry32)
export const rng = seed => {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6D2B79F5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// stable per-shot seed both sides can compute at fire time (ammo is sampled
// BEFORE the shot decrements it)
export const shotSeed = (nid, weaponIndex, magazineAmmo) =>
	(((nid & 0xffff) << 16) ^ ((weaponIndex & 0xff) << 8) ^ (magazineAmmo & 0xff)) >>> 0

// Angular offsets (radians) for every pellet of one shot, as {dx, dy} in the
// aim-perpendicular plane. heat is 0..1 (sustained-fire bloom, see weapon.js).
export const shotPattern = (config, seed, heat = 0) => {
	const rand = rng(seed)
	const jitter = spread => ({
		dx: (rand() - 0.5) * 2 * spread,
		dy: (rand() - 0.5) * 2 * spread
	})

	if (config.pellets && config.pellets > 1) {
		// rosette: one center pellet + a ring at fixed angles with seeded jitter.
		// Reads as a stamped circle on the wall (flak), never confetti.
		const ring = config.pellets - 1
		const radius = config.ringRadius || 0.055
		const rJit = config.ringJitter || 0.018
		const out = [jitter((config.spreadBase || 0.004))]
		for (let i = 0; i < ring; i++) {
			const baseAngle = (i / ring) * Math.PI * 2
			const angle = baseAngle + (rand() - 0.5) * 0.5
			const r = radius + (rand() - 0.5) * 2 * rJit
			out.push({ dx: Math.cos(angle) * r, dy: Math.sin(angle) * r })
		}
		return out
	}

	const spread = (config.spreadBase || 0) + (config.spreadHeat || 0) * Math.min(1, Math.max(0, heat))
	return [jitter(spread)]
}

// Rotate a unit aim direction {x,y,z} by an angular offset {dx,dy} using a
// camera-ish basis (world up). Returns a plain {x,y,z} unit vector.
export const applyPattern = (dir, off) => {
	// right = normalize(up x dir), up' = dir x right
	let rx = -dir.z, ry = 0, rz = dir.x
	const rl = Math.hypot(rx, ry, rz)
	if (rl < 1e-6) { rx = 1; ry = 0; rz = 0 } else { rx /= rl; rz /= rl }
	const ux = dir.y * rz - dir.z * ry
	const uy = dir.z * rx - dir.x * rz
	const uz = dir.x * ry - dir.y * rx
	const x = dir.x + rx * off.dx + ux * off.dy
	const y = dir.y + ry * off.dx + uy * off.dy
	const z = dir.z + rz * off.dx + uz * off.dy
	const l = Math.hypot(x, y, z)
	return { x: x / l, y: y / l, z: z / l }
}
