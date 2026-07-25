// Why did the wall not block? For a fixed list of shooter/target pairs the hitreg
// probe flagged as BLOCKED-BUT-HIT, dissect nearestWorldHit mesh by mesh against
// the brute-force triangle truth.
import * as BABYLON from '../common/babylon.node.js'
import GameInstance from '../server/GameInstance'
import { nearestWorldHit } from '../server/lagCompensatedHitscanCheck'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// the two blocked 1v1 shots (o + unit dir scaled out to the victim at ~17.5m)
const CASES = [
	{ a: [12.52, 7.26, -14.66], b: [12.52 - 0.937 * 17.5, 7.26 - 0.274 * 17.5, -14.66 + 0.219 * 17.5] },
	{ a: [12.52, 7.08, -14.66], b: [12.52 - 0.936 * 17.5, 7.08 - 0.274 * 17.5, -14.66 + 0.219 * 17.5] },
]

const main = async () => {
const gi = new GameInstance('dm_hex2', 'FFA')
for (let i = 0; i < 200 && !gi.mapReady; i++) await sleep(100)
const meshes = gi.occluderMeshes
console.log(`occluders=${meshes.length}`)

// per-mesh triangle soup so a hit can be attributed to a specific mesh
const soup = meshes.map(m => {
	const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
	const idx = m.getIndices()
	const wm = m.computeWorldMatrix(true)
	const wp = new Float64Array(pos.length)
	const v = new BABYLON.Vector3()
	for (let i = 0; i < pos.length; i += 3) {
		BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v)
		wp[i] = v.x; wp[i + 1] = v.y; wp[i + 2] = v.z
	}
	const tris = []
	for (let i = 0; i < idx.length; i += 3) {
		tris.push([wp[idx[i] * 3], wp[idx[i] * 3 + 1], wp[idx[i] * 3 + 2],
			wp[idx[i + 1] * 3], wp[idx[i + 1] * 3 + 1], wp[idx[i + 1] * 3 + 2],
			wp[idx[i + 2] * 3], wp[idx[i + 2] * 3 + 1], wp[idx[i + 2] * 3 + 2]])
	}
	return { mesh: m, tris, name: m.name, subMeshes: m.subMeshes ? m.subMeshes.length : 0, indices: idx.length }
})

const EPS = 1e-9
const brute = (tris, o, d, maxDist) => {
	let best = Infinity
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2]
		const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2]
		const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
		const det = e1x * px + e1y * py + e1z * pz
		if (det > -EPS && det < EPS) continue
		const inv = 1 / det
		const tx = o[0] - t[0], ty = o[1] - t[1], tz = o[2] - t[2]
		const u = (tx * px + ty * py + tz * pz) * inv
		if (u < 0 || u > 1) continue
		const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
		const vv = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
		if (vv < 0 || u + vv > 1) continue
		const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
		if (dist > EPS && dist < best) best = dist
	}
	return best > maxDist ? Infinity : best
}

for (const c of CASES) {
	const dx = c.b[0] - c.a[0], dy = c.b[1] - c.a[1], dz = c.b[2] - c.a[2]
	const len = Math.hypot(dx, dy, dz)
	const d = [dx / len, dy / len, dz / len]
	const ray = new BABYLON.Ray(new BABYLON.Vector3(c.a[0], c.a[1], c.a[2]), new BABYLON.Vector3(d[0], d[1], d[2]))
	const server = nearestWorldHit(meshes, ray, len)
	console.log(`\n--- A=[${c.a}] -> B=[${c.b}] len=${len.toFixed(2)} ---`)
	console.log(`  nearestWorldHit => ${server === Infinity ? 'CLEAR' : server.toFixed(3)}`)
	for (const s of soup) {
		const t = brute(s.tris, c.a, d, len)
		if (!Number.isFinite(t)) continue
		const bs = s.mesh.getBoundingInfo().boundingSphere
		const cw = bs.centerWorld
		const near = ((cw.x - c.a[0]) * d[0] + (cw.y - c.a[1]) * d[1] + (cw.z - c.a[2]) * d[2]) - bs.radiusWorld
		const pi = ray.intersectsMesh(s.mesh)
		console.log(`  mesh "${s.name}" tris=${s.tris.length} subMeshes=${s.subMeshes}`)
		console.log(`     brute hit @ ${t.toFixed(3)} | sphere-cull near=${near.toFixed(3)} (culled if > ${len.toFixed(2)}) | intersectsMesh -> ${pi.hit ? pi.distance.toFixed(3) : 'MISS'}`)
		console.log(`     bsphere centerWorld=(${cw.x.toFixed(2)},${cw.y.toFixed(2)},${cw.z.toFixed(2)}) radiusWorld=${bs.radiusWorld.toFixed(2)}`)
		const bb = s.mesh.getBoundingInfo().boundingBox
		console.log(`     bbox minW=(${bb.minimumWorld.x.toFixed(2)},${bb.minimumWorld.y.toFixed(2)},${bb.minimumWorld.z.toFixed(2)}) maxW=(${bb.maximumWorld.x.toFixed(2)},${bb.maximumWorld.y.toFixed(2)},${bb.maximumWorld.z.toFixed(2)})`)
	}
}
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
