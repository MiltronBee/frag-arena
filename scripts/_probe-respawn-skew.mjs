// RESPAWN CAMERA-SKEW probe. Boots its OWN server (MAP=dm_somnus BOT_FILL=4) +
// vite on :8080, joins, deploys, then stands still so the 4 bots kill it. An
// in-page rAF sampler records camera.rotation.z (the roll) + death-cam / recoil
// state EVERY FRAME into window.__skewLog. We wait through >=2 death->respawn
// cycles and assert the roll law: within ~1s AFTER each respawn the DEATH-CAM must
// be inactive while the player is ALIVE (and stay inactive for the following 3s,
// catching a LATE re-application), i.e. the ~23deg roll never bleeds into the new
// life. Keyed on _deathCam.active (not raw |z|) so the tiny, intended LIVE recoil-
// spring roll of a continuously-fired roll weapon is never a false positive; a
// death-cam-scale |z| >= 0.15 rad while alive is a backstop.
//
// Two variants (VARIANT=idle default, VARIANT=fire): 'fire' holds the fire button
// down the whole run so death lands MID-RECOIL-SPRING (dying while the roll spring
// is live) — the suspected conditional leak.
//
// LEAK=drop additionally SWALLOWS the first Respawned network message (models real
// packet loss / the documented map-rotation-reconnect miss): the replicated isAlive
// field still flips true, so the server respawns you, but the client never runs the
// Respawned handler's onRespawned() — so the death-cam roll's reset is missed. This
// is the residual leak the ordinary (message-delivered) path already survives.
//
// On failure the full per-frame roll timeline is dumped to
//   _work/respawn-skew/timeline.json
// so the leak's timing is visible.
//
//   node scripts/_probe-respawn-skew.mjs            # idle death
//   VARIANT=fire node scripts/_probe-respawn-skew.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/respawn-skew'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const VARIANT = process.env.VARIANT || 'idle'
const LEAK = process.env.LEAK || ''
const CYCLES_WANTED = LEAK === 'drop' ? 1 : 2  // death->respawn cycles to observe
const HOLD_AFTER_MS = 3000     // window after respawn the roll must STAY level
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

let failed = false
let browser = null
let reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOT_FILL: process.env.BOT_FILL || '4' }, 'server')
	reuseVite = await portBusy(VITE_PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
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
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })

	// install the per-frame roll sampler + (fire variant) hold the trigger down.
	await page.evaluate(({ variant, leak }) => {
		const sim = window.gameClient.simulator
		window.__skewLog = []
		window.__respawns = 0
		let prevAlive = true
		const ROLL_WEAPON = 5 // Flak — camKick.roll 0.30 (the biggest roll channel)

		// LEAK=drop: swallow the FIRST Respawned message (packet-loss / reconnect miss).
		// The isAlive entity-field update still arrives on its own channel, so the server
		// still respawns us — only the message-driven onRespawned() reset is missed.
		if (leak === 'drop') {
			const client = sim.client
			const origEmit = client.emit.bind(client)
			let dropped = false
			client.emit = (ev, ...args) => {
				if (!dropped && ev === 'message::Respawned' && window.__armDrop) {
					dropped = true
					return // eat it — models the Respawned packet never arriving
				}
				return origEmit(ev, ...args)
			}
		}
		const s = () => {
			const cam = sim.renderer.camera
			const e = sim.myRawEntity
			const alive = e ? e.isAlive !== false : null
			// arm the Respawned-drop the instant we first observe death
			if (prevAlive === true && alive === false) window.__armDrop = true
			if (prevAlive === false && alive === true) window.__respawns++
			if (alive != null) prevAlive = alive
			// FIRE variant: keep a roll-bearing weapon owned + equipped whenever alive
			// (the spawn pistol has roll:0, and Respawned force-equips it), so death can
			// land while the recoil-roll spring is live.
			if (variant === 'fire' && e && alive) {
				e.ownedWeapons = 0xff
				if (sim.weaponIndex !== ROLL_WEAPON) sim.switchWeapon(ROLL_WEAPON)
			}
			window.__skewLog.push({
				t: +performance.now().toFixed(1),
				z: cam.rotation.z,
				dc: !!(sim.fragLayer && sim.fragLayer._deathCam && sim.fragLayer._deathCam.active),
				alive,
				hp: e ? e.hitpoints : null,
				rz: sim._recoil ? sim._recoil.z : null,
				respawns: window.__respawns,
			})
			requestAnimationFrame(s)
		}
		requestAnimationFrame(s)
		if (variant === 'fire') {
			// hold LMB so death lands mid recoil-spring (see InputSystem: _currentState
			// is copied into frameState every frame by releaseKeys()).
			sim.input._currentState.mouseDown = true
		}
	}, { variant: VARIANT, leak: process.env.LEAK || '' })

	// wait through >=2 death->respawn cycles (die ~few s + 2.5s respawn delay, x2).
	const DEADLINE = Date.now() + 75000
	while (Date.now() < DEADLINE) {
		const n = await page.evaluate('window.__respawns')
		if (n >= CYCLES_WANTED) break
		await sleep(1000)
	}
	// let the post-respawn hold window fully elapse for the last respawn
	await sleep(HOLD_AFTER_MS + 500)

	const log = await page.evaluate('window.__skewLog')

	// find respawn instants (alive false->true) and assert the roll law around each.
	const respawnTimes = []
	for (let i = 1; i < log.length; i++) {
		if (log[i - 1].alive === false && log[i].alive === true) respawnTimes.push(log[i].t)
	}
	const violations = []
	for (const rt of respawnTimes) {
		// The leak's precise signature is the DEATH-CAM being active while ALIVE: that is
		// when applyDeathCamera keeps writing the ~23deg roll into the new life. Assert on
		// that directly so the tiny LIVE recoil-spring roll of a continuously-fired roll
		// weapon (dc inactive, |z| < ~0.05) is never mistaken for the leak.
		//   settle: (rt, rt+1000ms]  — the reset must have landed
		//   hold:   (rt+1000, rt+1000+HOLD] — and stayed (catches a LATE re-application)
		// Both windows ignore samples where the player is dead again (a genuine re-death's
		// death-cam roll is intended — 8 bots can re-kill inside the hold window).
		let settled = true, held = true, worstSettle = 0, worstHold = 0
		for (const s of log) {
			const dt = s.t - rt
			if (dt <= 0) continue
			if (s.alive !== true) continue
			const leaked = s.dc || Math.abs(s.z) >= 0.15 // death-cam active, or roll at death-cam scale
			if (dt <= 1000) { if (Math.abs(s.z) > worstSettle) worstSettle = Math.abs(s.z); if (leaked) settled = false }
			else if (dt <= 1000 + HOLD_AFTER_MS) { if (Math.abs(s.z) > worstHold) worstHold = Math.abs(s.z); if (leaked) held = false }
		}
		const ok = settled && held
		violations.push({ respawnT: rt, settled, held, worstSettleRoll: +worstSettle.toFixed(5), worstHoldRoll: +worstHold.toFixed(5), ok })
	}

	const anyBad = violations.some(v => !v.ok)
	const ok = respawnTimes.length >= CYCLES_WANTED && !anyBad && errors.length === 0
	if (!ok) {
		fs.writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ variant: VARIANT, respawnTimes, violations, log }, null, 2))
	}
	console.log(JSON.stringify({
		variant: VARIANT,
		respawnsObserved: respawnTimes.length,
		violations,
		pageErrors: errors.slice(0, 3),
		timeline: ok ? null : `${OUT}/timeline.json`,
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
