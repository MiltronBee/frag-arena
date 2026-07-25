// BODY-PART HITBOX COVERAGE MAP.
//
// Fires a dense grid of rays at a stationary victim and reports, per aim point,
// whether the server's hit volume registers and which zone it classifies. Prints an
// ASCII silhouette so dead zones on the VISIBLE body are obvious at a glance.
//
// The visible character is hero_male.glb, scale 0.577 -> ~1.05 units tall, drawn with
// feet at entity.y - 0.5 (client/assets/assetManifest.js). So relative to the entity
// centre the RENDERED body spans y -0.50 (soles) .. +0.55 (crown), and is roughly
// +/-0.22 wide at the shoulders. Every one of those cells must register a hit.
//
//   npx tsx scripts/probe-bodyparts.ts [dist] [victimPitchDeg] [victimYawDeg]
import * as BABYLON from '../common/babylon.node.js'
import GameInstance from '../server/GameInstance'
import lagCompensatedHitscanCheck from '../server/lagCompensatedHitscanCheck'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// rendered-body extents relative to entity centre (see header)
const BODY_BOTTOM = -0.50, BODY_TOP = 0.55, BODY_HALFWIDTH = 0.22
const HEAD_BOTTOM = 0.34  // roughly where the neck ends on a 1.05 model

const main = async () => {
const DIST = Number(process.argv[2] || 8)
const VP = (Number(process.argv[3] || 0) * Math.PI) / 180
const VY = (Number(process.argv[4] || 0) * Math.PI) / 180

const gi = new GameInstance('dm_hex2', 'FFA')
for (let i = 0; i < 200 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never became ready')

gi.addBot(0); gi.addBot(1)
const A = gi.bots[gi.bots.length - 2], B = gi.bots[gi.bots.length - 1]
A.latency = 0; B.latency = 0
;[A, B].forEach(h => { h.rawEntity.isAlive = true; h.rawEntity.spawnImmunity = 0; h.rawEntity.hitpoints = 100 })
// park every OTHER combatant far away so nothing else can enter a ray
gi.bots.forEach(h => { if (h !== A && h !== B) { h.rawEntity.x = 9000; h.rawEntity.y = 9000; h.rawEntity.z = 9000; h.rawEntity.mesh.computeWorldMatrix(true) } })

// open-air duel: put both well above the floor so no map geometry can occlude,
// isolating the PLAYER hit volume as the only thing under test.
const cx = -3, cy = 6, cz = -10
const shooter = { x: cx, y: cy, z: cz }
const victim = { x: cx, y: cy, z: cz + DIST }
A.rawEntity.x = shooter.x; A.rawEntity.y = shooter.y; A.rawEntity.z = shooter.z
B.rawEntity.x = victim.x; B.rawEntity.y = victim.y; B.rawEntity.z = victim.z
B.rawEntity.rotationX = VP; B.rawEntity.rotationY = VY
A.rawEntity.mesh.computeWorldMatrix(true); B.rawEntity.mesh.computeWorldMatrix(true)
for (let t = 0; t < 12; t++) gi.instance.update()

const world = { meshes: gi.occluderMeshes, maxDistance: 100 }
const victimNid = B.rawEntity.nid

// probe one aim point (offsets in metres, relative to the victim's CENTRE)
const probe = (dx, dy) => {
	const tx = victim.x + dx, ty = victim.y + dy, tz = victim.z
	const ox = shooter.x, oy = shooter.y, oz = shooter.z
	const vx = tx - ox, vy = ty - oy, vz = tz - oz
	const L = Math.hypot(vx, vy, vz)
	const ray = new BABYLON.Ray(new BABYLON.Vector3(ox, oy, oz), new BABYLON.Vector3(vx / L, vy / L, vz / L))
	const hits = lagCompensatedHitscanCheck(gi.instance, ray, 100, world)
	const h = hits.find(x => x.entity.nid === victimNid)
	return h ? h.zone : null
}

const STEP = 0.05
const YS = [], XS = []
for (let y = 0.70; y >= -0.70 - 1e-9; y -= STEP) YS.push(Number(y.toFixed(2)))
for (let x = -0.70; x <= 0.70 + 1e-9; x += STEP) XS.push(Number(x.toFixed(2)))

const glyph = { head: 'H', torso: 'T', legs: 'L' }
let bodyCells = 0, bodyMisses = 0
const missList = []
console.log(`\nvictim ${DIST}m away, victim pitch=${(VP * 180 / Math.PI).toFixed(0)}deg yaw=${(VY * 180 / Math.PI).toFixed(0)}deg`)
console.log(`legend: H/T/L = registered hit (head/torso/legs), '.' = NO HIT`)
console.log(`        [ ] marks the silhouette of the RENDERED body (must be all hits)\n`)
console.log('         ' + XS.map(x => (Math.abs(x) < 1e-9 ? '|' : ' ')).join(''))
for (const y of YS) {
	let row = ''
	for (const x of XS) {
		const z = probe(x, y)
		const onBody = y <= BODY_TOP && y >= BODY_BOTTOM && Math.abs(x) <= BODY_HALFWIDTH
		if (onBody) { bodyCells++; if (!z) { bodyMisses++; missList.push({ x, y }) } }
		row += z ? glyph[z] : '.'
	}
	const mark = (y <= BODY_TOP && y >= BODY_BOTTOM) ? (y >= HEAD_BOTTOM ? ' <- head' : '') : ''
	console.log(`  y${y >= 0 ? '+' : '-'}${Math.abs(y).toFixed(2)} ${row}${mark}`)
}
console.log('\n' + '-'.repeat(60))
console.log(`rendered-body cells tested : ${bodyCells}`)
console.log(`  cells that DID NOT register: ${bodyMisses}  (${(100 * bodyMisses / Math.max(1, bodyCells)).toFixed(1)}%)`)
if (missList.length) {
	const ys = [...new Set(missList.map(m => m.y))].sort((a, b) => a - b)
	console.log(`  dead rows (y): ${ys.join(', ')}`)
	console.log(`  sample dead aim points: ${missList.slice(0, 10).map(m => `(${m.x.toFixed(2)},${m.y.toFixed(2)})`).join(' ')}`)
}
// zone census over the rendered body only
const census = { head: 0, torso: 0, legs: 0, miss: 0 }
for (const y of YS) for (const x of XS) {
	if (!(y <= BODY_TOP && y >= BODY_BOTTOM && Math.abs(x) <= BODY_HALFWIDTH)) continue
	const z = probe(x, y)
	census[z || 'miss']++
}
console.log(`  zone census on the body: head=${census.head} torso=${census.torso} legs=${census.legs} miss=${census.miss}`)
// where does the head zone actually start/end vertically, on the centre line?
const col = []
for (const y of YS) col.push({ y, z: probe(0, y) })
const first = z => { const r = col.filter(c => c.z === z); return r.length ? `${Math.min(...r.map(c => c.y)).toFixed(2)}..${Math.max(...r.map(c => c.y)).toFixed(2)}` : 'NONE' }
console.log(`  centre-line vertical spans: head ${first('head')} | torso ${first('torso')} | legs ${first('legs')}`)
const anyHit = col.filter(c => c.z)
console.log(`  centre-line total hit span : ${anyHit.length ? Math.min(...anyHit.map(c => c.y)).toFixed(2) + '..' + Math.max(...anyHit.map(c => c.y)).toFixed(2) : 'NONE'}  (rendered body is ${BODY_BOTTOM}..${BODY_TOP})`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
