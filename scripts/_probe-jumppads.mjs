// UT99 JUMP-PAD end-to-end probe. Boots its OWN server (MAP=dm_somnus — 7 Kickers)
// with DEV_SPAWN_AT pinned to the first (yaw-less, pure-vertical) Kicker, plus a vite
// client on :8080, joins with puppeteer and asserts the server launched the player AND
// the client's OWN predicted entity followed (the Teleported velocity handover): a velY
// spike, an apex >=6 m above the pad, and a live landing — with zero page errors.
//
//   node scripts/_probe-jumppads.mjs
//
// Anti-throttle Chrome flags (background tabs rAF-throttle headless clients — the
// late-joiner lesson). ONE browser per client if this ever grows a second.
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

// dm_somnus JUMP_PADS[0]: native (2.749, y 20.576, z -5.16), no yaw = straight up.
const DEV_SPAWN_AT = '2.749,20.576,-5.16'

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/jumppad|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

let failed = false
let browser = null
let reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOTS: '0', DEV_SPAWN_AT }, 'server')
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

	// baseline (on the pad, before the ~0.5s cooldown grace lets it fire)
	const start = await page.evaluate(() => {
		const e = window.gameClient.simulator.myRawEntity
		return { x: e.x, y: e.y, z: e.z }
	})

	// poll the client's OWN predicted entity for ~3.5 s and track the apex + velY spike.
	let apexY = start.y
	let peakVelY = 0
	for (let i = 0; i < 70; i++) {
		const s = await page.evaluate(() => {
			const e = window.gameClient.simulator.myRawEntity
			return { y: e.y, velY: e.velY, alive: e.isAlive }
		})
		if (s.y > apexY) apexY = s.y
		if (s.velY > peakVelY) peakVelY = s.velY
		await sleep(50)
	}
	// settle, then confirm alive + landed (came back down from the apex)
	await sleep(1500)
	const end = await page.evaluate(() => {
		const e = window.gameClient.simulator.myRawEntity
		;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
		document.body.classList.add('arena-entered')
		return { y: e.y, alive: e.isAlive, map: window.gameClient.simulator.map.id }
	})
	await sleep(400)
	await page.screenshot({ path: '_work/probe-jumppads.png' })

	const apexRise = apexY - start.y
	const landedBack = (apexY - end.y) > 2 // came down at least 2 m from the peak
	const ok = end.map === 'dm_somnus' && peakVelY > 10 && apexRise >= 6 && end.alive && landedBack && errors.length === 0
	console.log(JSON.stringify({
		map: end.map,
		startY: +start.y.toFixed(2),
		apexY: +apexY.toFixed(2),
		apexRise: +apexRise.toFixed(2),
		peakVelY: +peakVelY.toFixed(2),
		endY: +end.y.toFixed(2),
		alive: end.alive,
		landedBack,
		pageErrors: errors.slice(0, 3),
		screenshot: '_work/probe-jumppads.png',
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
