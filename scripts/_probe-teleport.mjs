// UT99 teleporter end-to-end probe. Boots its OWN server (MAP=grove — exactly
// one bidirectional portal pair) with DEV_SPAWN_AT pinned to the L0_secret1
// portal ENTRY, plus a vite client on :8080, joins with puppeteer and asserts
// the server teleported the player to the exit AND the client's predicted
// entity followed (the Teleported message handover).
//
//   node scripts/_probe-teleport.mjs
//
// Anti-throttle Chrome flags copied from _probe-spawn-loadout.mjs (background
// tabs rAF-throttle headless clients — the late-joiner "bug" lesson). ONE
// browser per client if this ever grows a second client.
import { spawn } from 'child_process'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// grove portal pair (native units, from common/mapRegistry TELEPORTERS):
// entry L0_secret1 (-1.757, 23.818) -> exit L3_secret4 (16.898, -16.971), s=0.65
const ENTRY = { x: -1.757 * 0.65, z: 23.818 * 0.65 }              // (-1.14, 15.48)
const EXIT = { x: 16.898 * 0.65, z: -16.971 * 0.65 }              // (10.98, -11.03)
const DEV_SPAWN_AT = '-1.757,-2.182,23.818'                        // native x,y,z of the entry

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/teleport|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

let failed = false
let browser = null
try {
	boot('npx', ['tsx', 'server/serverMain.js'],
		{ MAP: 'grove', BOTS: '0', DEV_SPAWN_AT }, 'server')
	boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
	await sleep(7000) // server mesh load + vite ready

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
	await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
		{ timeout: 45000 })
	await sleep(2500) // ≥2s: the teleport fires on the first server tick after spawn

	const st = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const e = sim.myRawEntity
		// enter the arena so the world renders for the shimmer screenshot
		;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
		document.body.classList.add('arena-entered')
		return { x: e.x, y: e.y, z: e.z, map: sim.map.id }
	})

	// shimmer screenshot: markers are created once the map VISUAL loads (they
	// drop-probe it), so give it a beat, then step the client-side entity a few
	// metres off the exit portal and face its marker. Client-only nudge — the
	// probe ends here, desync is irrelevant.
	await sleep(5000)
	const shim = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const markers = sim.renderer.scene.meshes.filter(m => /^teleporter\d+$/.test(m.name))
		const e = sim.myRawEntity
		// nearest marker to the exit position we teleported to
		let mk = null, best = Infinity
		for (const m of markers) {
			const d = Math.hypot(m.position.x - e.x, m.position.z - e.z)
			if (d < best) { best = d; mk = m }
		}
		if (mk) {
			// stand 3m toward the map centre, look back at the marker
			const dir = Math.atan2(0 - mk.position.x, 0 - mk.position.z)
			e.x = mk.position.x + Math.sin(dir) * 3
			e.z = mk.position.z + Math.cos(dir) * 3
			e.y = mk.position.y - 0.3
			e.velX = 0; e.velY = 0; e.velZ = 0
			const cam = sim.renderer.camera
			cam.rotation.x = 0.05
			cam.rotation.y = Math.atan2(mk.position.x - e.x, mk.position.z - e.z)
		}
		return { markers: markers.length, markerY: mk ? +mk.position.y.toFixed(2) : null }
	})
	await sleep(350) // a few frames of marker pulse; short enough that gravity barely moves us
	await page.screenshot({ path: '_work/probe-teleport.png' })

	const dExit = Math.hypot(st.x - EXIT.x, st.z - EXIT.z)
	const dEntry = Math.hypot(st.x - ENTRY.x, st.z - ENTRY.z)
	const ok = st.map === 'grove' && dExit < 3 && dEntry > 5 && errors.length === 0 && shim.markers === 2
	console.log(JSON.stringify({
		map: st.map,
		pos: { x: +st.x.toFixed(2), y: +st.y.toFixed(2), z: +st.z.toFixed(2) },
		distToExit: +dExit.toFixed(2),
		distToEntry: +dEntry.toFixed(2),
		shimmerMarkers: shim.markers,
		markerY: shim.markerY,
		pageErrors: errors.slice(0, 3),
		screenshot: '_work/probe-teleport.png',
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	// tsx/vite spawn children; sweep anything still holding the ports
	await sleep(500)
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 8080/tcp 2>/dev/null; true'])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
