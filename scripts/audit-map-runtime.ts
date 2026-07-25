// RUNTIME map audit: boots the real GameInstance for ONE map and validates every
// spawn point geometrically, plus reports what the actor pipelines actually built.
//
//   npx tsx scripts/audit-map-runtime.ts <mapId>
//
// One map per process: GameInstance binds :8079, so the caller loops.
import * as BABYLON from '../common/babylon.node.js'
import GameInstance from '../server/GameInstance'
import { nearestWorldHit } from '../server/lagCompensatedHitscanCheck'
import { mapRecords, effectiveMode } from '../common/mapRegistry'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// must mirror server/GameInstance.js
const SPAWN_MIN_HEADROOM = 2.0
const SPAWN_REST = 0.5
// the hittable/collidable player: capsule spans -0.66..+0.66 about the entity centre
const PLAYER_TOP = 0.66
const PLAYER_R = 0.36

const main = async () => {
const mapId = process.argv[2]
const rec = mapRecords[mapId]
if (!rec) throw new Error('unknown map ' + mapId)
const sc = rec.scale || 1

const gi = new GameInstance(mapId, null)
for (let i = 0; i < 300 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never became ready')
const meshes = gi.occluderMeshes

const up = (x, y, z, max = 40) => nearestWorldHit(meshes,
	new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(0, 1, 0)), max)
const lateral = (x, y, z, r) => {
	// is the capsule's waist clear of geometry in 8 directions?
	let worst = Infinity
	for (let i = 0; i < 8; i++) {
		const a = (i / 8) * Math.PI * 2
		const d = nearestWorldHit(meshes,
			new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(Math.cos(a), 0, Math.sin(a))), r)
		if (d < worst) worst = d
	}
	return worst
}

const pts = rec.SPAWN_POINTS || []
const mode = effectiveMode(rec)
const teamGated = mode === 'CTF' || mode === 'DOM'

console.log(`\n${'='.repeat(74)}`)
console.log(`${mapId}  [${rec.name}]  mode=${rec.mode}->${mode}  scale=${sc}  killY=${rec.killY}`)
console.log('='.repeat(74))

const rows = []
for (let i = 0; i < pts.length; i++) {
	const p = pts[i]
	const wx = p.x * sc, wz = p.z * sc, wyNative = p.y * sc
	const floorY = gi._dropProbeY(wx, wyNative, wz)
	const centreY = floorY != null ? floorY + SPAWN_REST : wyNative
	const clear = floorY != null ? up(wx, floorY + 0.05, wz) : NaN
	const lat = floorY != null ? lateral(wx, centreY, wz, PLAYER_R) : NaN
	const survives = p.headroom === undefined || p.headroom >= SPAWN_MIN_HEADROOM
	const belowKill = rec.killY != null && centreY <= rec.killY
	const w = rec.walkable
	const outside = w ? (wx < w.minX * sc || wx > w.maxX * sc || wz < w.minZ * sc || wz > w.maxZ * sc) : false
	rows.push({
		i, team: p.team, headroom: p.headroom, survives,
		wx, wz, wyNative, floorY, centreY,
		yErr: floorY != null ? Math.abs(wyNative - floorY) : null,
		clear, lat, belowKill, outside,
		fits: floorY != null && clear >= PLAYER_TOP + 0.05 && lat >= PLAYER_R - 1e-6,
	})
}

console.log('\n  #  team  hdrm  used   floorY   regY   |dy|   ceil-clear  lateral  verdict')
for (const r of rows) {
	const bad = []
	if (r.floorY == null) bad.push('NO FLOOR (probe miss)')
	else {
		if (r.clear < PLAYER_TOP + 0.05) bad.push(`CEILING ${r.clear.toFixed(2)}m < ${(PLAYER_TOP + 0.05).toFixed(2)}m`)
		if (r.lat < PLAYER_R - 1e-6) bad.push(`WALL ${r.lat.toFixed(2)}m < r${PLAYER_R}`)
		if (r.yErr > 3) bad.push(`registry y off floor by ${r.yErr.toFixed(2)}m`)
	}
	if (r.belowKill) bad.push('BELOW killY')
	if (r.outside) bad.push('OUTSIDE walkable')
	console.log(
		`  ${String(r.i).padStart(2)}   ${String(r.team ?? '-').padStart(2)}  `
		+ `${(r.headroom ?? 0).toFixed(2).padStart(5)}  ${r.survives ? ' YES ' : ' no  '} `
		+ `${r.floorY == null ? '  MISS ' : r.floorY.toFixed(2).padStart(7)} `
		+ `${r.wyNative.toFixed(2).padStart(6)} `
		+ `${r.yErr == null ? '   -  ' : r.yErr.toFixed(2).padStart(6)} `
		+ `${Number.isFinite(r.clear) ? (r.clear === Infinity ? '   open  ' : r.clear.toFixed(2).padStart(9)) : '     -   '} `
		+ `${Number.isFinite(r.lat) ? (r.lat === Infinity ? '   open' : r.lat.toFixed(2).padStart(7)) : '      -'}  `
		+ (bad.length ? '** ' + bad.join('; ') : 'ok'))
}

const used = rows.filter(r => r.survives)
const pool = used.length ? used : rows
const geomBad = rows.filter(r => !r.fits || r.belowKill || r.outside)
const poolBad = pool.filter(r => !r.fits || r.belowKill || r.outside)

console.log(`\n  SPAWN POOL`)
console.log(`    authored points            : ${rows.length}`)
console.log(`    pass headroom >= ${SPAWN_MIN_HEADROOM}         : ${used.length}` +
	(used.length === 0 ? '  (none -> server falls back to ALL points)' : ''))
console.log(`    ACTUALLY REACHABLE IN PLAY : ${pool.length}` +
	(pool.length < rows.length ? `   << ${rows.length - pool.length} authored spawns are dead` : ''))
if (teamGated) {
	console.log(`    team-gated (mode ${mode}): team0=${pool.filter(r => r.team === 0).length} team1=${pool.filter(r => r.team === 1).length}`)
} else {
	console.log(`    team tags IGNORED (mode ${mode} from a ${rec.mode} source) -> both teams share all ${pool.length}`)
}
console.log(`    geometrically bad (all)    : ${geomBad.length}`)
console.log(`    geometrically bad (in pool): ${poolBad.length}`)

// clustering: how close are the live spawns to each other?
if (pool.length > 1) {
	let mn = Infinity, mnPair = null
	const dists = []
	for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
		const d = Math.hypot(pool[a].wx - pool[b].wx, pool[a].centreY - pool[b].centreY, pool[a].wz - pool[b].wz)
		dists.push(d)
		if (d < mn) { mn = d; mnPair = [pool[a].i, pool[b].i] }
	}
	dists.sort((x, y) => x - y)
	console.log(`    closest live pair          : ${mn.toFixed(2)}m (idx ${mnPair})`)
	console.log(`    median live separation     : ${dists[dists.length >> 1].toFixed(2)}m`)
} else if (pool.length === 1) {
	console.log(`    ** ONLY ONE LIVE SPAWN — every player spawns in the same spot **`)
}

// ---- what the actor pipelines actually built ----
console.log(`\n  ACTORS BUILT AT RUNTIME`)
const pk = gi.pickups || []
const byType = {}
pk.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1 })
const authored = rec.PICKUPS || {}
const authoredTotal = Object.values(authored).reduce((a: any, v: any) => a + (v ? v.length : 0), 0)
console.log(`    pickups   authored ${authoredTotal}  ->  spawned ${pk.length}` +
	(pk.length < (authoredTotal as number) ? `   ** ${(authoredTotal as number) - pk.length} dropped (unreachable floor probe) **` : '   ok')
	+ `   byType=${JSON.stringify(byType)}`)
console.log(`    teleporters authored ${(rec.TELEPORTERS || []).length}  ->  paired ${(gi.portals || []).length}`
	+ ((rec.TELEPORTERS || []).length && !(gi.portals || []).length ? '   ** none built **' : ''))
console.log(`    jump pads  authored ${(rec.JUMP_PADS || []).length}  ->  built ${(gi.jumpPads || []).length}`)
const movers = gi.moverController && gi.moverController.movers ? gi.moverController.movers.length : 0
console.log(`    movers/lifts authored ${(rec.MOVERS || []).length}  ->  built ${movers}`)
console.log(`    flags ${(gi.flags || []).length}   control points ${(gi.controlPoints || []).length}   (mode ${mode})`)
const mega = gi.megaSpawnPos ? gi.megaSpawnPos() : null
if (mega) {
	const mfloor = gi._dropProbeY(mega.x, mega.y, mega.z)
	console.log(`    mega health @(${mega.x.toFixed(1)},${mega.y.toFixed(1)},${mega.z.toFixed(1)})  floor below=`
		+ (mfloor == null ? 'NONE ** unreachable **' : mfloor.toFixed(2) + `  (${(mega.y - mfloor).toFixed(2)}m above)`))
}
if (mode === 'CTF' && !(gi.flags || []).length) console.log('    ** CTF map with NO flags built **')
if (mode === 'DOM' && !(gi.controlPoints || []).length) console.log('    ** DOM map with NO control points built **')
}

main().then(() => process.exit(0), e => { console.error('FAILED:', e.message); process.exit(1) })
