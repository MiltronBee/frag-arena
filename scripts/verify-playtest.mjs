// Verify the 2026-07-25 playtest fixes in a REAL booted client:
//   1. settings sliders paint --fill from their value (was pinned at the CSS 50%)
//   2. the carried-weapon strip exists, and tracks ownedWeapons + the equipped slot
//   3. resetCameraTransform() zeroes a deliberately-dirtied camera (roll/pitch/springs)
//   4. onRespawned() routes through it (the respawn-tilt fix)
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.PROBE_VITE_PORT || '8081'
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})
const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stderr.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stderr.write(`[${tag}] ${s}`) })
	procs.push(p)
	return p
}

let browser = null, reuseVite = false, fail = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'dm_hex2', BOT_FILL: '1' }, 'server')
	reuseVite = await portBusy(PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', PORT, '--strictPort'], {}, 'vite')
	await sleep(9000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome', headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,720'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errs = []
	page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 60000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	await sleep(2500)

	const r = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const out = {}

		// ---- 1. slider fill ----
		sim._openSettings()
		const sliders = [...document.querySelectorAll('#settings-menu input[type="range"]')]
		out.sliderCount = sliders.length
		out.fillsBefore = sliders.map(s => s.style.getPropertyValue('--fill') || '(unset)')
		// drive one to its max and confirm the fill follows the value
		const fov = document.getElementById('fov-slider')
		fov.value = fov.max
		fov.dispatchEvent(new Event('input', { bubbles: true }))
		out.fovFillAtMax = fov.style.getPropertyValue('--fill')
		fov.value = fov.min
		fov.dispatchEvent(new Event('input', { bubbles: true }))
		out.fovFillAtMin = fov.style.getPropertyValue('--fill')
		sim._closeSettings && sim._closeSettings()

		// ---- 2. weapon strip ----
		const strip = document.getElementById('weapon-strip')
		out.stripCells = strip ? strip.querySelectorAll('.wslot').length : 0
		const e = sim.myRawEntity
		e.ownedWeapons = 0xff              // pretend we picked everything up
        sim._updateWeaponStrip()
		out.ownedAll = strip ? strip.querySelectorAll('.wslot.owned').length : 0
		e.ownedWeapons = 1 << 3            // pistol only
		sim._updateWeaponStrip()
		out.ownedPistolOnly = strip ? strip.querySelectorAll('.wslot.owned').length : 0
		out.activeCells = strip ? strip.querySelectorAll('.wslot.active').length : 0

		// ---- 3/4. camera reset ----
		const cam = sim.renderer.camera
		cam.rotation.x = 0.4; cam.rotation.y = 1.234; cam.rotation.z = 0.4
		sim._recoil.set(0.05, 0.05, 0.05)
		sim._recoilVel.set(1, 1, 1)
		sim._recoilApplied.set(0.02, 0.02, 0.02)
		sim._visClimb = 3
		sim._pumpDip = { t: 0.3, vel: 1 }
		sim.fragLayer.onRespawned()        // the real respawn path
		out.afterRespawn = {
			rotX: +cam.rotation.x.toFixed(5),
			rotY: +cam.rotation.y.toFixed(5), // must be PRESERVED (server spawn facing)
			rotZ: +cam.rotation.z.toFixed(5),
			recoil: [sim._recoil.x, sim._recoil.y, sim._recoil.z],
			recoilVel: [sim._recoilVel.x, sim._recoilVel.y, sim._recoilVel.z],
			applied: [sim._recoilApplied.x, sim._recoilApplied.y, sim._recoilApplied.z],
			visClimb: sim._visClimb,
			pumpDip: sim._pumpDip,
		}
		return out
	})

	console.log(JSON.stringify(r, null, 1))
	const a = r.afterRespawn
	const checks = [
		['sliders found', r.sliderCount >= 3],
		['fill tracks max', r.fovFillAtMax === '100.0%'],
		['fill tracks min', r.fovFillAtMin === '0.0%'],
		['strip built', r.stripCells >= 3],
		['all owned lights all', r.ownedAll === r.stripCells],
		['pistol-only lights one', r.ownedPistolOnly === 1],
		['exactly one active', r.activeCells === 1],
		['pitch levelled', a.rotX === 0],
		['YAW PRESERVED', Math.abs(a.rotY - 1.234) < 1e-4],
		['roll zeroed', a.rotZ === 0],
		['recoil zeroed', a.recoil.every(v => v === 0) && a.recoilVel.every(v => v === 0) && a.applied.every(v => v === 0)],
		['climb zeroed', a.visClimb === 0],
		['pumpDip cleared', a.pumpDip === null],
		['no page errors', errs.length === 0],
	]
	for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail = true }
	if (errs.length) console.log('errors:', errs.slice(0, 3))
} catch (e) {
	console.error('VERIFY ERROR:', e.message)
	fail = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(fail ? 1 : 0)
