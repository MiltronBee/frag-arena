// SPAWN SAFETY regression. Exercises GameInstance._rateSpawn against the REAL authored
// spawn tables of the live maps, with living players parked on the map, and asserts the
// properties a player actually feels:
//
//   * you are never dropped inside somebody
//   * you are not dropped next to somebody when a safer point exists
//   * the same point does not come up twice in a row (no farmable spawn)
//   * it is still random — a safe map must not produce a deterministic rotation
//
// Uses Object.create(GameInstance.prototype) so no Babylon scene or map mesh is needed;
// _rateSpawn only reads combatants() and occluderMeshes, both of which we supply. With
// no meshes the line-of-sight term is skipped, which makes this a strictly HARDER test:
// the distance terms alone have to carry every assertion.
import GameInstance from '../server/GameInstance'
import { MAPS } from '../common/mapMesh'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `   ${detail}`}`)
	cond ? pass++ : fail++
}

function harness(living: any[]) {
	const g: any = Object.create(GameInstance.prototype)
	g.occluderMeshes = []          // no geometry -> LoS term skipped (harder test)
	g._lastSpawnPick = null
	g.combatants = () => living
	return g
}

// Every map that ships a real authored spawn table.
const maps = Object.entries(MAPS as any)
	.filter(([, m]: any) => Array.isArray(m.SPAWN_POINTS) && m.SPAWN_POINTS.length > 1)

console.log(`Auditing ${maps.length} maps with authored spawn tables\n`)

for (const [id, m] of maps as any) {
	const sc = m.scale || 1
	const pool = m.SPAWN_POINTS.filter((p: any) => p.headroom === undefined || p.headroom >= 2.0)
	const world = (p: any) => ({ x: p.x * sc, y: p.y * sc, z: p.z * sc })

	// how clustered is this map's authored table? (diagnostic, not an assertion —
	// the tables are Epic's, we only get to choose well among them)
	let minPair = Infinity
	for (let i = 0; i < pool.length; i++) {
		for (let j = i + 1; j < pool.length; j++) {
			const a = world(pool[i]), b = world(pool[j])
			minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
		}
	}
	console.log(`${id}: ${pool.length} usable spawns, closest pair ${minPair.toFixed(2)} units apart`)

	// ── 1. never spawn inside a living player ────────────────────────────────
	// Park a player ON each of the first few spawns and check we never pick one of
	// those occupied points.
	const occupied = pool.slice(0, Math.min(4, pool.length - 1))
	const living = occupied.map((p: any) => ({ ...world(p), isAlive: true }))
	const g = harness(living)
	// clearance = distance from the chosen spawn to the NEAREST living player.
	// Judge the chooser against what the map actually allows, not against an absolute:
	// a cramped authored table cannot be rescued by picking better, and blaming the
	// picker for Epic's spawn placement would just be a test that lies.
	const clearanceOf = (p: any) => {
		const w = world(p)
		return Math.min(...living.map((o: any) => Math.hypot(o.x - w.x, o.y - w.y, o.z - w.z)))
	}
	const bestPossible = Math.max(...pool.map(clearanceOf))
	let insideSomeone = 0, total = 0, worst = Infinity
	for (let i = 0; i < 300; i++) {
		const c = clearanceOf(g._rateSpawn(pool, sc))
		if (c < 1.6) insideSomeone++
		total += c
		worst = Math.min(worst, c)
	}
	const avg = total / 300
	console.log(`  clearance: avg ${avg.toFixed(1)}, worst ${worst.toFixed(1)},`
		+ ` best the map allows ${bestPossible.toFixed(1)} units`)
	ok(`  ${id}: never spawns inside a living player`, insideSomeone === 0, `${insideSomeone}/300`)
	// Uniform-random would average roughly the pool mean; we want to be well above it
	// and close to what the map allows.
	const poolMean = pool.reduce((a: number, p: any) => a + clearanceOf(p), 0) / pool.length
	ok(`  ${id}: picks safer than random would (${avg.toFixed(1)} vs ${poolMean.toFixed(1)})`, avg > poolMean * 1.15,
		`avg ${avg.toFixed(1)} is not meaningfully better than random ${poolMean.toFixed(1)}`)
	ok(`  ${id}: worst case still clears the danger zone`, worst >= 6,
		`worst pick was ${worst.toFixed(1)} units from a living player (map allows ${bestPossible.toFixed(1)})`)

	// ── 2. no immediate repeat ───────────────────────────────────────────────
	const g2 = harness([])
	let repeats = 0
	let prev: any = null
	for (let i = 0; i < 300; i++) {
		const pick = g2._rateSpawn(pool, sc)
		if (pick === prev) repeats++
		prev = pick
	}
	ok(`  ${id}: never reuses the point it just used`, repeats === 0, `${repeats}/300`)

	// ── 3. still unpredictable on an empty map ───────────────────────────────
	const g3 = harness([])
	const seen = new Set()
	for (let i = 0; i < 400; i++) seen.add(g3._rateSpawn(pool, sc))
	const coverage = seen.size / pool.length
	ok(`  ${id}: still uses the whole map (${seen.size}/${pool.length} points)`, coverage > 0.8,
		`only ${(coverage * 100).toFixed(0)}% of spawns ever chosen`)
	console.log('')
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
