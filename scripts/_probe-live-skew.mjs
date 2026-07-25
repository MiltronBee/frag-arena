// LIVE respawn-roll observer. Read-only: joins https://sol-pkmn.fun as ONE idle
// player, stands still so bots kill it, and samples the camera roll channel EVERY
// frame through >=2 death->respawn cycles. Nothing is written to the game; the only
// commands sent are the deploy request (and whatever the client sends by itself).
//
// Records, per frame: camera.rotation.z (the roll actually rendered), the death-cam
// state that OWNS that roll (active/roll/age), the recoil spring's roll, and isAlive
// — so a post-respawn tilt can be attributed to the death-cam leak, the recoil
// spring, or a writer we haven't found yet (z != 0 with both quiet).
//
//   node _probe-live-skew.mjs            # default 3 cycles / 240s
import fs from 'fs'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/live-skew'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const URL = process.env.URL || 'https://sol-pkmn.fun/'
const CYCLES = +(process.env.CYCLES || 3)
const DEADLINE_MS = +(process.env.DEADLINE_MS || 240000)

let browser = null
try {
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
	await page.goto(URL, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
		{ timeout: 60000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })

	await page.evaluate(() => {
		const sim = window.gameClient.simulator
		window.__log = []
		window.__respawns = 0
		window.__deaths = 0
		let prevAlive = true
		const s = () => {
			const cam = sim.renderer.camera
			const e = sim.myRawEntity
			const alive = e ? e.isAlive !== false : null
			if (prevAlive === true && alive === false) window.__deaths++
			if (prevAlive === false && alive === true) window.__respawns++
			if (alive != null) prevAlive = alive
			const dc = sim.fragLayer && sim.fragLayer._deathCam
			window.__log.push({
				t: +performance.now().toFixed(1),
				z: +cam.rotation.z.toFixed(5),
				x: +cam.rotation.x.toFixed(5),
				dc: !!(dc && dc.active),
				dcRoll: dc ? +dc.roll.toFixed(3) : null,
				dcAge: dc && dc.active ? +(performance.now() - dc.t0).toFixed(0) : null,
				rz: sim._recoil ? +sim._recoil.z.toFixed(5) : null,
				az: sim._recoilApplied ? +sim._recoilApplied.z.toFixed(5) : null,
				alive,
				hp: e ? e.hitpoints : null,
				r: window.__respawns,
			})
			if (window.__log.length > 60000) window.__log.shift()
			requestAnimationFrame(s)
		}
		requestAnimationFrame(s)
	})

	const DEADLINE = Date.now() + DEADLINE_MS
	while (Date.now() < DEADLINE) {
		const n = await page.evaluate('window.__respawns')
		if (n >= CYCLES) break
		await sleep(2000)
	}
	await sleep(4000) // let the last post-respawn window elapse

	const log = await page.evaluate('window.__log')
	const deaths = await page.evaluate('window.__deaths')

	// respawn instants + what the roll did in the 4s AFTER each
	const events = []
	for (let i = 1; i < log.length; i++) {
		if (log[i - 1].alive === false && log[i].alive === true) {
			const rt = log[i].t
			const after = log.filter(s => s.t > rt && s.t <= rt + 4000 && s.alive === true)
			let worst = 0, worstS = null, dcFrames = 0, lastNonZero = null
			for (const s of after) {
				if (s.dc) dcFrames++
				if (Math.abs(s.z) > Math.abs(worst)) { worst = s.z; worstS = s }
				if (Math.abs(s.z) > 0.02) lastNonZero = s
			}
			events.push({
				respawnT: rt, samples: after.length,
				worstRoll: worst, worstRollDeg: +(worst * 180 / Math.PI).toFixed(2),
				worstSample: worstS,
				deathCamFramesWhileAlive: dcFrames,
				lastRollAboveOneDeg: lastNonZero,
				// tail = is it STILL rolled at the end of the window (persistent) ?
				tail: after.length ? after[after.length - 1] : null,
			})
		}
	}
	fs.writeFileSync(`${OUT}/live-timeline.json`, JSON.stringify({ url: URL, deaths, events, log }, null, 2))
	console.log(JSON.stringify({ url: URL, deaths, respawns: events.length, events, pageErrors: errors.slice(0, 5), timeline: `${OUT}/live-timeline.json` }, null, 2))
} catch (err) {
	console.error('PROBE ERROR:', err.message)
} finally {
	if (browser) await browser.close().catch(() => {})
}
