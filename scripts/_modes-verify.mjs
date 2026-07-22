// _modes-verify.mjs — CTF/DOM objective-data readiness + sanity check.
//
// The mode-objective data (CTF flag bases, DOM control points) was extracted long
// ago by _work/ut-actors/export_actors.py (FlagBase / ControlPoint UT actor classes)
// and already lives in BOTH _work/ut-actors/registry/*.json AND, hand-copied, in
// common/mapRegistry.js (visage.mode_data.flags, dom_elder.mode_data.controlPoints).
//
// This script is the AUDIT + SANITY tool for that data — NOT an extractor that needs
// to run (there is nothing missing to extract). It:
//   1. re-reads the raw extraction (_work/ut-actors/<MAP>.actors.json) mode_data,
//   2. confirms it round-tripped identically into registry/<id>.json,
//   3. confirms the SAME numbers are embedded in common/mapRegistry.js (text scan),
//   4. runs the two sanity checks the task calls for:
//        - CTF flag bases sit near their team's SPAWN_POINTS cluster,
//        - DOM control points are spread across the map (3-pt triangle).
//
// If a future re-extraction ever DID drop the data from mapRegistry.js, step 3 fails
// loudly and the fix is: copy mode_data from registry/<id>.json back into the record
// (native units, x/z horizontal + y height; team tag on flags; id/name on points).
// Drop-probe y is intentionally NOT stored — the server drop-probes objectives to the
// floor at load time exactly like pickups (server/setupPickups.js) and teleporters
// (server/teleporters.js) do.

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ACT = path.join(ROOT, '_work/ut-actors')
const REG = path.join(ACT, 'registry')
const registryText = fs.readFileSync(path.join(ROOT, 'common/mapRegistry.js'), 'utf8')

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.log('  ✗ ' + m); failures++ }

// Is `needle` (a rounded coordinate) present literally in mapRegistry.js?
const inRegistry = (n) => registryText.includes(String(n))

// ---- CTF-Visage / visage : flag bases ------------------------------------
function checkCTF() {
	console.log('\n=== CTF-Visage (visage) — flag bases ===')
	const actors = readJSON(path.join(ACT, 'CTF-Visage.actors.json'))
	const reg = readJSON(path.join(REG, 'ctf_visage.json'))
	const flags = actors.mode_data && actors.mode_data.flags
	if (!Array.isArray(flags) || flags.length < 2) return bad(`actors.json has ${flags ? flags.length : 0} flags (need 2)`)
	ok(`actors.json: ${flags.length} FlagBase actors`)

	const teams = new Set(flags.map(f => f.team))
	if (teams.has(0) && teams.has(1)) ok('both teams (0 RED, 1 BLUE) present')
	else bad(`flags cover teams {${[...teams].join(',')}} — need both 0 and 1`)

	// round-trip: registry/ctf_visage.json mode_data.flags == actors mode_data.flags
	const rf = reg.mode_data && reg.mode_data.flags
	const same = rf && rf.length === flags.length && rf.every((r, i) =>
		r.team === flags[i].team && Math.abs(r.x - flags[i].x) < 1e-3 && Math.abs(r.z - flags[i].z) < 1e-3)
	same ? ok('registry/ctf_visage.json matches actors mode_data') : bad('registry/ctf_visage.json DRIFTED from actors mode_data')

	// embedded in common/mapRegistry.js?
	const embedded = flags.every(f => inRegistry(f.x) && inRegistry(f.z))
	embedded ? ok('flag coords embedded in common/mapRegistry.js (visage.mode_data.flags)')
		: bad('flag coords MISSING from common/mapRegistry.js — copy from registry/ctf_visage.json')

	// SANITY: each flag near its team spawn cluster centroid
	const sp = reg.SPAWN_POINTS || []
	for (const f of flags) {
		const team = sp.filter(p => p.team === f.team)
		if (!team.length) { bad(`team ${f.team} has no SPAWN_POINTS to compare`); continue }
		const cx = team.reduce((s, p) => s + p.x, 0) / team.length
		const cz = team.reduce((s, p) => s + p.z, 0) / team.length
		const d = Math.hypot(f.x - cx, f.z - cz)
		d < 25 ? ok(`team ${f.team} flag ${d.toFixed(1)}m from its ${team.length}-spawn cluster (near — sane)`)
			: bad(`team ${f.team} flag ${d.toFixed(1)}m from its spawn cluster (too far — check extraction)`)
	}
}

// ---- DOM-Elder / dom_elder : control points ------------------------------
function checkDOM() {
	console.log('\n=== DOM-Elder (dom_elder) — control points ===')
	const actors = readJSON(path.join(ACT, 'DOM-Elder.actors.json'))
	const reg = readJSON(path.join(REG, 'dom_elder.json'))
	const cps = actors.mode_data && actors.mode_data.controlPoints
	if (!Array.isArray(cps) || cps.length < 3) return bad(`actors.json has ${cps ? cps.length : 0} control points (classic DOM wants 3-4)`)
	ok(`actors.json: ${cps.length} ControlPoint actors [${cps.map(c => c.id).join(', ')}]`)

	const rc = reg.mode_data && reg.mode_data.controlPoints
	const same = rc && rc.length === cps.length && rc.every((r, i) =>
		r.id === cps[i].id && Math.abs(r.x - cps[i].x) < 1e-3 && Math.abs(r.z - cps[i].z) < 1e-3)
	same ? ok('registry/dom_elder.json matches actors mode_data') : bad('registry/dom_elder.json DRIFTED from actors mode_data')

	const embedded = cps.every(c => inRegistry(c.x) && inRegistry(c.z))
	embedded ? ok('control-point coords embedded in common/mapRegistry.js (dom_elder.mode_data.controlPoints)')
		: bad('control-point coords MISSING from common/mapRegistry.js — copy from registry/dom_elder.json')

	// SANITY: points spread across the walkable box (min pairwise separation)
	let minSep = Infinity
	for (let i = 0; i < cps.length; i++)
		for (let j = i + 1; j < cps.length; j++)
			minSep = Math.min(minSep, Math.hypot(cps[i].x - cps[j].x, cps[i].z - cps[j].z))
	minSep > 15 ? ok(`points spread out — min pairwise separation ${minSep.toFixed(1)}m (sane triangle)`)
		: bad(`points clustered — min separation ${minSep.toFixed(1)}m (expected a spread triangle)`)

	const wk = reg.walkable
	const inBox = cps.every(c => c.x >= wk.minX - 2 && c.x <= wk.maxX + 2 && c.z >= wk.minZ - 2 && c.z <= wk.maxZ + 2)
	inBox ? ok('all points inside the walkable AABB') : bad('a control point falls outside walkable — check units')
}

checkCTF()
checkDOM()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} problem(s).`)
process.exit(failures === 0 ? 0 : 1)
