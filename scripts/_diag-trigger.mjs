// Is the MATCH_END trigger wired, or did the client simply never see phase 1?
// Boots a server, enters the arena, records the phase the client actually holds, then
// flips MatchState.phase to MATCH_END locally and calls the same _updateMatchHud() the
// frame loop calls. If the overlay opens, the trigger is correct and the real-run
// failure was a replication/timing issue; if it does not, the trigger is the bug.
import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = '8080'
const procs = []
const boot = (cmd, args, env, tag) => {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	const log = fs.createWriteStream(`/tmp/trig-${tag}.log`)
	p.stdout.on('data', d => log.write(d)); p.stderr.on('data', d => log.write(d))
	procs.push(p); return p
}
const kill = p => { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})

let browser = null
try {
	if (await portBusy(8079)) throw new Error('8079 busy')
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_hex2', BOT_FILL: '1', MATCH_SECONDS: '900' }, 'srv')
	const upBy = Date.now() + 120000
	let alive = false
	while (Date.now() < upBy && !alive) {
		if (await portBusy(8079)) {
			try { const r = await fetch('http://127.0.0.1:8078/mapinfo'); if (r.ok) alive = !!(await r.json()).mapId } catch (e) {}
		}
		if (!alive) await sleep(500)
	}
	if (!alive) throw new Error('server never ready')
	console.log('[diag] server ready')

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome', headless: 'new',
		// protocolTimeout: swiftshader renders this scene at a couple of fps, so the page's
		// main thread is saturated and a Runtime.evaluate can sit in the queue for minutes.
		// A small viewport cuts the software-raster cost roughly quadratically.
		protocolTimeout: 240000,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--window-size=640,360'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 640, height: 360 })
	const errs = []
	page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 250)))
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })

	for (let i = 0; i < 24; i++) {
		if (await page.evaluate('!document.getElementById("splash")').catch(() => false)) break
		await page.keyboard.press('Space'); await sleep(500)
	}
	for (let i = 0; i < 20; i++) {
		const done = await page.evaluate(`(() => { const w = document.getElementById('whoami'); if (!w) return true
			const s = getComputedStyle(w); return s.display === 'none' || +s.opacity < 0.01 })()`).catch(() => false)
		if (done) break
		await page.evaluate(`(() => { const b = document.getElementById('whoami-human'); if (b) b.click() })()`).catch(() => {})
		await sleep(400)
	}
	await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
	await page.waitForFunction('!document.getElementById("enter-arena").disabled', { timeout: 90000 })
	await page.evaluate('window.gameClient.simulator._enterArena()')
	await page.waitForFunction('window.gameClient.simulator.myRawEntity && window.gameClient.simulator._arenaEntered', { timeout: 45000 })
	await sleep(4000)
	console.log('[diag] in arena')

	console.log('OBSERVED:', JSON.stringify(await page.evaluate(`(() => {
    const sim = window.gameClient.simulator
    const ms = sim._matchState
    return {
      hasMatchState: !!ms,
      phase: ms ? ms.phase : null, winner: ms ? ms.winner : null, mode: ms ? ms.mode : null,
      timeRemainingMs: ms ? ms.timeRemainingMs : null,
      lastTdmPhase: sim._lastTdmPhase, arenaEntered: sim._arenaEntered,
      playerEntities: (() => { let n = 0; sim.client.entities.forEach(e => { if (e && typeof e.kills === 'number') n++ }); return n })(),
    }
  })()`), null, 1))

	// What do the replicated player entities ACTUALLY carry? The ranking renders every
	// name as "PLAYER" and shows no [AGENT] badge, so nameIndex is not what was assumed.
	console.log('ENTITY FIELDS:', JSON.stringify(await page.evaluate(`(() => {
    const sim = window.gameClient.simulator
    const out = []
    sim.client.entities.forEach(e => {
      if (!e || typeof e.kills !== 'number') return
      out.push({ nid: e.nid, proto: e.protocol && e.protocol.name, nameIndex: e.nameIndex,
                 teamId: e.teamId, kills: e.kills, deaths: e.deaths,
                 isMine: sim.mySmoothEntity && e.nid === sim.mySmoothEntity.nid,
                 isMyRaw: sim.myRawEntity && e.nid === sim.myRawEntity.nid })
    })
    let total = 0; sim.client.entities.forEach(() => total++)
    return { count: out.length, totalEntities: total, entities: out,
             mySmoothNid: sim.mySmoothEntity && sim.mySmoothEntity.nid,
             myRawNid: sim.myRawEntity && sim.myRawEntity.nid,
             myRawId: sim.myRawId,
             nameRegistry: Array.from(sim._nameRegistry.entries()) }
  })()`), null, 1))

	// Flip the phase the way the server would, then run the real frame-loop handler.
	console.log('AFTER LOCAL PHASE FLIP:', JSON.stringify(await page.evaluate(`(() => {
    const sim = window.gameClient.simulator
    sim._matchState.phase = 1
    sim._matchState.winner = 0
    sim._matchState.timeRemainingMs = 12000
    sim._updateMatchHud()
    sim._matchEnd.update()
    const el = document.getElementById('match-end')
    return {
      overlayClasses: el.className, display: getComputedStyle(el).display,
      bodyClass: document.body.className,
      rows: document.getElementById('me-rows').children.length,
      title: document.getElementById('me-title').textContent,
      score: document.getElementById('me-score').textContent,
      sub: document.getElementById('me-sub').textContent,
      stats: document.getElementById('me-stats').textContent,
      clock: document.getElementById('me-clock').textContent,
      firstRow: document.getElementById('me-rows').firstElementChild
        ? document.getElementById('me-rows').firstElementChild.textContent : null,
    }
  })()`), null, 1))

	await sleep(11000)
	await page.evaluate('window.gameClient.simulator._matchEnd.update()').catch(() => {})
	try { await page.screenshot({ path: '/tmp/overlay-live.png', captureBeyondViewport: false }) ; console.log('[diag] screenshot ok') }
	catch (e) { console.log('[diag] screenshot failed:', String(e).slice(0, 90)) }
	console.log('ERRORS:', errs.slice(0, 6).join(' | ') || '(none)')
} catch (e) {
	console.error('[diag] FAILED', String(e).slice(0, 300))
} finally {
	if (browser) await browser.close().catch(() => {})
	procs.forEach(kill)
	await sleep(500)
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
	await sleep(800)
	process.exit(0)
}
