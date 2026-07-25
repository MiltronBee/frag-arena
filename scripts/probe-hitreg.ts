// Controlled hit-registration probe (in-process, no networking, no bot AI).
//
// Boots the REAL GameInstance on a map, plants two combatants at floor-standing
// positions, aims one at the other, and fires through the REAL performShot path.
// Ground truth = brute-force Moller-Trumbore over every world triangle between the
// two muzzles. Reports the two failure directions separately:
//   BLOCKED-BUT-HIT   geometry is in the way yet damage landed  -> shoot through walls
//   CLEAR-BUT-MISSED  nothing in the way yet no damage landed   -> unkillable
//
//   npx tsx scripts/probe-hitreg.ts [mapId] [pairs] [shotsPerPair]
import * as BABYLON from '../common/babylon.node.js'
import GameInstance from '../server/GameInstance'
import { weapons } from '../common/weaponsConfig'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
const mapId = process.argv[2] || 'dm_hex2'
const PAIRS = Number(process.argv[3] || 300)
const SHOTS = Number(process.argv[4] || 6)
const WEAPON = Number(process.env.WEAPON || 0) // 0 = Rifle (single pellet)

const gi = new GameInstance(mapId, 'FFA')
for (let i = 0; i < 200 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never became ready')
console.log(`map ${mapId} ready, occluders=${gi.occluderMeshes.length}, weapon=${weapons[WEAPON].name} range=${weapons[WEAPON].range}`)

// ---- ground-truth triangle soup (world space, straight off the occluder meshes) ----
const tris = []
gi.occluderMeshes.forEach(m => {
	const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
	const idx = m.getIndices()
	if (!pos || !idx) return
	const wm = m.computeWorldMatrix(true)
	const wp = new Float64Array(pos.length)
	const v = new BABYLON.Vector3()
	for (let i = 0; i < pos.length; i += 3) {
		BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v)
		wp[i] = v.x; wp[i + 1] = v.y; wp[i + 2] = v.z
	}
	for (let i = 0; i < idx.length; i += 3) {
		tris.push([wp[idx[i] * 3], wp[idx[i] * 3 + 1], wp[idx[i] * 3 + 2],
			wp[idx[i + 1] * 3], wp[idx[i + 1] * 3 + 1], wp[idx[i + 1] * 3 + 2],
			wp[idx[i + 2] * 3], wp[idx[i + 2] * 3 + 1], wp[idx[i + 2] * 3 + 2]])
	}
})
console.log(`ground-truth triangles: ${tris.length}`)
const EPS = 1e-9
const bruteNearest = (ox, oy, oz, dx, dy, dz, maxDist) => {
	let best = Infinity
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2]
		const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2]
		const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
		const det = e1x * px + e1y * py + e1z * pz
		if (det > -EPS && det < EPS) continue
		const inv = 1 / det
		const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2]
		const u = (tx * px + ty * py + tz * pz) * inv
		if (u < 0 || u > 1) continue
		const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
		const vv = (dx * qx + dy * qy + dz * qz) * inv
		if (vv < 0 || u + vv > 1) continue
		const d = (e2x * qx + e2y * qy + e2z * qz) * inv
		if (d > EPS && d < best) best = d
	}
	return best > maxDist ? Infinity : best
}

// ---- two combatants (real bot handles: raw === smooth, in the historian) ----
gi.addBot(0); gi.addBot(1)
const A = gi.bots[0], B = gi.bots[1]
A.rawEntity.teamId = 0; B.rawEntity.teamId = 1
A.rawEntity.currentWeaponIndex = WEAPON
A.latency = 0; B.latency = 0

// floor-standing sample points: drop-probe random XZ inside the real geometry bounds
let mn = new BABYLON.Vector3(1e9, 1e9, 1e9), mx = new BABYLON.Vector3(-1e9, -1e9, -1e9)
gi.occluderMeshes.forEach(m => {
	const bb = m.getBoundingInfo().boundingBox
	mn = BABYLON.Vector3.Minimize(mn, bb.minimumWorld); mx = BABYLON.Vector3.Maximize(mx, bb.maximumWorld)
})
console.log(`world bounds x[${mn.x.toFixed(1)}..${mx.x.toFixed(1)}] y[${mn.y.toFixed(1)}..${mx.y.toFixed(1)}] z[${mn.z.toFixed(1)}..${mx.z.toFixed(1)}]`)
let seed = 987654321
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const stands = []
for (let i = 0; i < 20000 && stands.length < 400; i++) {
	const x = mn.x + rnd() * (mx.x - mn.x), z = mn.z + rnd() * (mx.z - mn.z)
	const y = gi._dropProbeY(x, mx.y - 0.5, z)
	if (y == null) continue
	stands.push({ x, y: y + 0.55, z })   // feet on the floor, muzzle at box centre
}
console.log(`floor-standing sample points: ${stands.length}`)

const place = (h, p) => { h.rawEntity.x = p.x; h.rawEntity.y = p.y; h.rawEntity.z = p.z; h.rawEntity.mesh.computeWorldMatrix(true) }
const aim = (h, from, to) => {
	const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
	h.rawEntity.rotationY = Math.atan2(dx, dz)
	h.rawEntity.rotationX = -Math.atan2(dy, Math.hypot(dx, dz))
	h.rawEntity.mesh.computeWorldMatrix(true)
}
const reset = h => {
	const e = h.rawEntity
	e.hitpoints = 100; e.armor = 0; e.isAlive = true; e.spawnImmunity = 0; e.udamageTimer = 0
	e.aimFactor = 0; e.equipTimer = 0
	e.weaponsState.forEach((s, i) => { s.magazineAmmo = weapons[i].magazineCapacity; s.onCooldown = false; s.cooldownTimer = 0; s.heat = 0 })
}

let blockedButHit = 0, clearButMissed = 0, okHit = 0, okBlocked = 0, tested = 0
const samplesBH = [], samplesCM = []
const reach = Math.max(weapons[WEAPON].range || 0, 0)

for (let n = 0; n < PAIRS; n++) {
	const p = stands[(n * 7 + 3) % stands.length]
	const q = stands[(n * 13 + 29) % stands.length]
	const dx0 = q.x - p.x, dy0 = q.y - p.y, dz0 = q.z - p.z
	const len = Math.hypot(dx0, dy0, dz0)
	if (len < 1.5 || len > reach * 0.8) continue

	reset(A); reset(B)
	place(A, p); place(B, q); aim(A, p, q)

	// fill the historian with BOTH standing still, so the (latency+100ms) rewind
	// lands on exactly these positions — no interpolation error in play.
	for (let t = 0; t < 12; t++) gi.instance.update()

	const truth = bruteNearest(p.x, p.y, p.z, dx0 / len, dy0 / len, dz0 / len, len)
	const occluded = Number.isFinite(truth) && truth < len - 0.3   // wall strictly between

	const hpBefore = B.rawEntity.hitpoints
	for (let s = 0; s < SHOTS; s++) {
		A.rawEntity.weaponsState[WEAPON].onCooldown = false
		A.rawEntity.weaponsState[WEAPON].cooldownTimer = 0
		gi.performShot(A)
		gi.instance.update()
	}
	const dmg = hpBefore - B.rawEntity.hitpoints
	tested++
	// re-fire ONE shot with the hitscan tracer on, so a leak through geometry
	// prints the candidate list + wallDist the resolver actually used
	if (Number.isFinite(truth) && truth < len - 0.3 && dmg > 0) {
		console.log(`\n>>> LEAK len=${len.toFixed(2)} wallAt=${truth.toFixed(2)} dmg=${dmg} A=[${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}] B=[${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)}]`)
		console.log(`    shooterNid=${A.rawEntity.nid} victimNid=${B.rawEntity.nid} occluders=${gi.occluderMeshes.length}`)
		process.env.HITSCAN_DEBUG = '1'
		A.rawEntity.weaponsState[WEAPON].onCooldown = false
		A.rawEntity.weaponsState[WEAPON].cooldownTimer = 0
		gi.performShot(A)
		process.env.HITSCAN_DEBUG = '0'
	}
	const rec = { p, q, len, truth, dmg }
	if (occluded && dmg > 0) { blockedButHit++; if (samplesBH.length < 6) samplesBH.push(rec) }
	else if (!occluded && dmg === 0) { clearButMissed++; if (samplesCM.length < 6) samplesCM.push(rec) }
	else if (!occluded) okHit++
	else okBlocked++
}

const f = r => `len=${r.len.toFixed(2)} wallAt=${Number.isFinite(r.truth) ? r.truth.toFixed(2) : 'CLEAR'} dmg=${r.dmg} A=[${r.p.x.toFixed(2)},${r.p.y.toFixed(2)},${r.p.z.toFixed(2)}] B=[${r.q.x.toFixed(2)},${r.q.y.toFixed(2)},${r.q.z.toFixed(2)}]`
console.log(`\n=== ${tested} duels (${SHOTS} shots each, ${weapons[WEAPON].name}) ===`)
console.log(`  clear LOS + damage landed      : ${okHit}`)
console.log(`  wall in the way + no damage     : ${okBlocked}`)
console.log(`  CLEAR-BUT-MISSED (unkillable)   : ${clearButMissed}   ${(100 * clearButMissed / Math.max(1, clearButMissed + okHit)).toFixed(1)}% of clear-LOS duels`)
samplesCM.forEach(r => console.log('     ' + f(r)))
console.log(`  BLOCKED-BUT-HIT (through walls) : ${blockedButHit}   ${(100 * blockedButHit / Math.max(1, blockedButHit + okBlocked)).toFixed(1)}% of blocked duels`)
samplesBH.forEach(r => console.log('     ' + f(r)))
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
