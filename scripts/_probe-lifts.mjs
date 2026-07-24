// UT99 LIFT end-to-end probe. Boots its OWN server (MAP=dm_gantry162 — Deck16's two
// lifts) with DEV_SPAWN_AT pinned to lift A's base, plus a vite client on :8080, joins
// with puppeteer and asserts: the platform RISES when stood on, the RIDER RISES WITH IT
// (the carry clamp working on the client's OWN predicted entity), and — once the rider
// walks off the top (a rider holds the lift open, UT bStandOpenTimed) — it RETURNS DOWN.
// Zero page errors.
//
//   node scripts/_probe-lifts.mjs
//
// Rise threshold: Deck16's lift travels 10.52 NATIVE units = 6.84 m in WORLD units
// (native * scale 0.65). So the world rise is ~6.8 m; we assert >=5 m, comfortably above a
// jump apex (1.44 m) — proof the carry lifted the rider, not a hop. (The task's ">=8 m"
// figure is the NATIVE-unit travel; it is not reachable in world metres.)
//
// Anti-throttle Chrome flags; ONE browser per client if this ever grows a second.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

// dm_gantry162 MOVERS[0] (lift A): native centre (24.079, z 36.271), rest surface -23.927.
// Spawn just above the rest surface so the drop-probe settles us onto the platform.
const DEV_SPAWN_AT = '24.079,-23.5,36.271'
const RISE_MIN = 5.0 // world metres (see header note)

const procs = []
const serverStates = [] // ordered lift state transitions parsed from the server log
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => {
		const s = d.toString()
		if (/lift state|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`)
		// record each authoritative state transition: "lift state X -> Y"
		let m; const re = /lift state (\d|undefined) -> (\d)/g
		while ((m = re.exec(s))) serverStates.push(+m[2])
	})
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

// snapshot the rider + the ridden lift (tracked by nid so a walked-off rider still reads it)
const sample = (nid) => `(() => {
	const sim = window.gameClient.simulator
	const e = sim.myRawEntity
	let plat = sim.movers.get(${nid ?? 'null'})
	if (!plat) { let best = Infinity; for (const m of sim.movers.values()) { const d = Math.hypot(m.x - e.x, m.z - e.z); if (d < best) { best = d; plat = m } } }
	return { riderY: e.y, ex: e.x, ez: e.z, platY: plat ? plat.y : null, platNid: plat ? plat.nid : null, platState: plat ? plat.state : null, alive: e.isAlive }
})()`

let failed = false
let browser = null
let reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_gantry162', BOTS: '0', DEV_SPAWN_AT }, 'server')
	reuseVite = await portBusy(VITE_PORT)
	if (reuseVite) console.log(`[vite] reusing dev server already on :${VITE_PORT}`)
	else boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	await sleep(7000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
		{ timeout: 45000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
		{ timeout: 45000 })

	// BASELINE captured immediately at deploy (rider at the bottom — the lift only starts
	// rising once it detects the rider, and the client clamp lags the server ~1 interp
	// window, so the first fast samples catch the bottom).
	const start = await page.evaluate(sample(null))
	const liftNid = start.platNid

	// The lift is a TIMED lift (UT bBumpOpenTimed): it rises when the rider boards, holds
	// StayOpen (3 s) at the top, then descends REGARDLESS of occupancy — the rider RIDES
	// BACK DOWN (carried by the same clamp). So the whole up-and-down cycle needs NO player
	// input: we just poll continuously and watch the rider's OWN predicted Y go bottom -> top
	// (carry up) -> bottom (carry down), while the server state machine cycles 1->2->3->0.
	// Poll ~13 s (rise 1.75 + hold 3 + descend 1.75 + interp/headless margin), tracking the
	// rider/platform peak and the post-peak return.
	let riderMin = start.riderY, riderPeak = start.riderY
	let platMin = start.platY ?? Infinity, platPeak = start.platY ?? -Infinity
	let riderReturnMin = Infinity, aliveThrough = true
	for (let i = 0; i < 150; i++) {
		const s = await page.evaluate(sample(liftNid))
		if (s.riderY < riderMin) riderMin = s.riderY
		if (s.riderY > riderPeak) riderPeak = s.riderY
		if (s.platY != null && s.platY < platMin) platMin = s.platY
		if (s.platY != null && s.platY > platPeak) platPeak = s.platY
		// once we've risen near the top, start tracking the RETURN (lowest rider y after)
		if (riderPeak - start.riderY > 4 && s.riderY < riderReturnMin) riderReturnMin = s.riderY
		if (!s.alive) aliveThrough = false
		await sleep(90)
	}
	// full authoritative cycle observed from the server state log
	const sawTop = serverStates.includes(2)
	const iTop = serverStates.indexOf(2)
	const sawDescend = iTop >= 0 && serverStates.slice(iTop + 1).includes(3)
	const descentMin = riderReturnMin // rider's lowest point after the peak (rode back down)

	const end = await page.evaluate(() => {
		const e = window.gameClient.simulator.myRawEntity
		;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
		document.body.classList.add('arena-entered')
		return { y: e.y, alive: e.isAlive, map: window.gameClient.simulator.map.id }
	})
	await sleep(400)
	await page.screenshot({ path: '_work/probe-lifts.png' })

	const riderRise = riderPeak - riderMin       // carried UP (client's own predicted entity)
	const platRise = platPeak - platMin
	const riderReturn = riderPeak - descentMin   // carried BACK DOWN after the StayOpen pause
	// full authoritative cycle: RISING(1) -> AT_TOP(2) -> DESCENDING(3)
	const serverCycle = serverStates.includes(1) && sawTop && sawDescend
	const ok = end.map === 'dm_gantry162' && liftNid != null && platRise >= RISE_MIN
		&& riderRise >= RISE_MIN && riderReturn >= 3 && serverCycle && aliveThrough && end.alive
		&& errors.length === 0
	console.log(JSON.stringify({
		map: end.map,
		startRiderY: +start.riderY.toFixed(2),
		riderPeakY: +riderPeak.toFixed(2),
		riderRise: +riderRise.toFixed(2),
		platRise: +platRise.toFixed(2),
		riderReturn: +riderReturn.toFixed(2),
		serverStateCycle: serverStates.join('->'),
		serverDescended: sawDescend,
		endRiderY: +end.y.toFixed(2),
		alive: end.alive,
		pageErrors: errors.slice(0, 3),
		screenshot: '_work/probe-lifts.png',
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
