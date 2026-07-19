#!/usr/bin/env node
// Dependency-free differ for two golden-collision JSON files. Reports, per sequence,
// the max POSITION deviation (mm) and the first tick of divergence past a tolerance
// (default 1mm = 0.001 units). Exit 0 = every sequence within tolerance, 1 = drift
// (or a structural mismatch: missing map/sequence, different tick count).
//
//   node scripts/golden-collision-diff.mjs a.json b.json [toleranceUnits]
import { readFileSync } from 'fs'

const [, , pathA, pathB, tolArg] = process.argv
if (!pathA || !pathB) {
	console.error('usage: golden-collision-diff.mjs <a.json> <b.json> [toleranceUnits=0.001]')
	process.exit(2)
}
const TOL = tolArg !== undefined ? Number(tolArg) : 0.001 // units; 0.001 = 1mm
const a = JSON.parse(readFileSync(pathA, 'utf8'))
const b = JSON.parse(readFileSync(pathB, 'utf8'))

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const mapIds = [...new Set([...Object.keys(a.maps || {}), ...Object.keys(b.maps || {})])]

let failed = 0, totalSeqs = 0, worstMm = 0, worstWhere = ''
console.log(`A: babylon ${a.babylonVersion}   B: babylon ${b.babylonVersion}   tol ${TOL} units (${TOL * 1000}mm)\n`)

for (const mapId of mapIds) {
	const sa = a.maps?.[mapId]?.sequences
	const sb = b.maps?.[mapId]?.sequences
	if (!sa || !sb) { console.log(`  MAP ${mapId}: MISSING in ${!sa ? 'A' : 'B'}`); failed++; continue }
	const seqNames = [...new Set([...Object.keys(sa), ...Object.keys(sb)])]
	for (const name of seqNames) {
		totalSeqs++
		const ta = sa[name], tb = sb[name]
		if (!ta || !tb) { console.log(`  ${mapId}/${name}: MISSING in ${!ta ? 'A' : 'B'}`); failed++; continue }
		if (ta.length !== tb.length) {
			console.log(`  ${mapId}/${name}: TICK-COUNT ${ta.length} vs ${tb.length}`); failed++; continue
		}
		let maxDev = 0, firstDiv = -1
		for (let t = 0; t < ta.length; t++) {
			const d = dist(ta[t], tb[t])
			if (d > maxDev) maxDev = d
			if (firstDiv < 0 && d > TOL) firstDiv = t
		}
		const mm = maxDev * 1000
		if (mm > worstMm) { worstMm = mm; worstWhere = `${mapId}/${name}` }
		if (firstDiv >= 0) {
			console.log(`  DRIFT ${mapId}/${name}: max ${mm.toFixed(4)}mm, first divergence tick ${firstDiv}`)
			failed++
		}
	}
}

console.log(`\n${totalSeqs} sequences compared. worst deviation ${worstMm.toFixed(6)}mm @ ${worstWhere || '(none)'}`)
if (failed) { console.log(`RESULT: DRIFT — ${failed} sequence(s)/map(s) exceeded tolerance`); process.exit(1) }
console.log('RESULT: no drift (all within tolerance)')
process.exit(0)
