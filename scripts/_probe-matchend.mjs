// MATCH-END EXPERIENCE probe. Not an assertion harness — a RECORDER. It boots a
// rotation-driven server with a short regulation (MATCH_SECONDS), enters the arena the
// normal way, then samples the player-visible DOM + screenshots continuously from
// before the winner banner through the intermission, the socket drop, the CHANGING MAP
// reload, and the READY card, so the whole "victory -> next match" window can be read
// as one timeline.
import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.PROBE_VITE_PORT || '8080'
const OUT = process.env.PROBE_OUT || '/tmp/matchend'
const MATCH_SECONDS = process.env.MATCH_SECONDS || '30'
const WATCH_MS = parseInt(process.env.WATCH_MS || '95000', 10)
const SHOT_EVERY_MS = 2000

fs.mkdirSync(OUT, { recursive: true })

const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})
const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	const log = fs.createWriteStream(`${OUT}/${tag}.log`)
	p.stdout.on('data', d => log.write(d))
	p.stderr.on('data', d => log.write(d))
	procs.push(p)
	return p
}
const kill = p => { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }

// Everything the player can actually read on screen, in one snapshot.
const SNAP = `(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null }
  const cls = (sel) => { const e = document.querySelector(sel); return e ? e.className : null }
  const vis = (sel) => { const e = document.querySelector(sel); if (!e) return null
    const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.01 }
  const sim = window.gameClient && window.gameClient.simulator
  const ms = sim && sim._matchState   // NOT sim.matchState — that field does not exist
  const feed = Array.from(document.querySelectorAll('#killfeed *, .killfeed *')).map(e => e.textContent.trim()).filter(Boolean).slice(-4)
  return {
    conn: sim ? sim._connectionState : null,
    entered: sim ? !!sim._arenaEntered : null,
    lastTdmPhase: sim ? sim._lastTdmPhase : null,
    overlayVisible: sim && sim._matchEnd ? !!sim._matchEnd._visible : null,
    overlayRoot: sim && sim._matchEnd ? !!sim._matchEnd.root : null,
    phase: ms ? (ms.phase | 0) : null,
    winner: ms ? (ms.winner | 0) : null,
    timer: t('tdm-timer'),
    red: t('tdm-score-red'),
    blue: t('tdm-score-blue'),
    boardCls: cls('#tdm-scoreboard'),
    bannerShown: vis('#tdm-banner'),
    bannerTitle: t('tdm-banner-title'),
    bannerScore: t('tdm-banner-score'),
    meCls: cls('#match-end'),
    meDisplay: (() => { const e = document.getElementById('match-end'); return e ? getComputedStyle(e).display : null })(),
    meTitle: t('me-title'),
    meRows: (() => { const e = document.getElementById('me-rows'); return e ? e.children.length : null })(),
    mcCls: cls('#map-change'),
    mcShown: vis('#map-change'),
    mcMap: t('mc-map-name'),
    mcMode: t('mc-mode-name'),
    entryOverlay: vis('#entry-overlay'),
    entryStatus: t('entry-status') || t('uplink-status'),
    enterLabel: t('enter-label') || t('enter-arena'),
    connLabel: t('connection-label'),
    ping: t('ping-ms'),
    myKills: sim && sim.myRawEntity ? sim.myRawEntity.kills : null,
    body: document.body.className,
    feed,
  }
})()`

let browser = null
const timeline = []
try {
	if (await portBusy(8079)) { console.error('game port 8079 busy — refusing to boot a second server'); process.exit(2) }
	// rotation-driven boot (NO MAP env) so onMatchCycle is armed and the process really
	// exits at the end of the intermission; serve-loop.sh is the pm2 stand-in.
	boot('bash', ['scripts/serve-loop.sh'], { MATCH_SECONDS, BOT_FILL: '1' }, 'srv')
	if (!(await portBusy(PORT))) boot('npx', ['vite', '--port', PORT, '--strictPort'], {}, 'vite')
	// WAIT FOR THE PORT, don't guess at it. The server needs ~18s to bind 8079 (Babylon
	// NullEngine + map load + pickups + movers), and GameClient calls client.connect()
	// exactly ONCE with no retry — so a browser that loads even a second early gets
	// ERR_CONNECTION_REFUSED and sits on 'disconnected' forever. A fixed sleep here is
	// what made the first run of this probe time out with zero samples.
	// Waiting on the PORT alone is not enough: a just-killed predecessor can still show a
	// LISTEN socket for a moment, so the port test passes, the browser connects to a
	// corpse, and the socket drops right after onConnect. /mapinfo is served from the
	// SAME process and only answers once the map, pickups and bot nav are actually built,
	// so a 200 from it is the real "this server is alive" signal.
	const upBy = Date.now() + 120000
	let alive = false
	while (Date.now() < upBy && !alive) {
		if (await portBusy(8079)) {
			try {
				const r = await fetch('http://127.0.0.1:8078/mapinfo', { cache: 'no-store' })
				if (r.ok) { const j = await r.json(); alive = !!j.mapId }
			} catch (e) {}
		}
		if (!alive) await sleep(500)
	}
	if (!alive) throw new Error('game server never became ready (/mapinfo)')
	console.log('[probe] game server ready')

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome', headless: 'new',
		protocolTimeout: 240000,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--window-size=640,360'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 640, height: 360 })
	page.on('pageerror', e => timeline.push({ t: Date.now(), pageerror: String(e).slice(0, 200) }))
	page.on('console', m => { if (/error|fail|refused|matchend/i.test(m.text())) timeline.push({ console: m.text().slice(0, 300) }) })

	// Getting into the arena is itself racy (a dropped socket before entry is terminal —
	// GameClient.connect() is called ONCE, with no retry), so reload and try again rather
	// than failing the whole recording on one unlucky boot.
	let inArena = false
	for (let attempt = 1; attempt <= 3 && !inArena; attempt++) {
		try {
			if (attempt === 1) await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
			else { console.log(`[probe] entry attempt ${attempt} — reloading`); await page.reload({ waitUntil: 'domcontentloaded' }) }
			// DISMISS THE SPLASH FIRST. Card 0 is a hard gesture gate ("TAP TO INITIALIZE")
			// that exists to unlock audio, and it covers the whole viewport — which is why a
			// synthetic click on #enter-arena did nothing and why every screenshot from this
			// probe was a picture of the splash rather than the game. It advances on any
			// keydown and removes its own node when dismissed, so press through its cards.
			for (let i = 0; i < 24; i++) {
				const gone = await page.evaluate('!document.getElementById("splash")').catch(() => false)
				if (gone) break
				await page.keyboard.press('Space')
				await sleep(500)
			}
			// THEN the human-or-agent gate (#whoami, added with the public FragBench endpoint).
			// It is a second full-viewport overlay and it also has to be answered before the
			// menu is reachable, or every screenshot is a picture of this card instead.
			for (let i = 0; i < 20; i++) {
				const done = await page.evaluate(`(() => {
					const w = document.getElementById('whoami')
					if (!w) return true
					const s = getComputedStyle(w)
					return s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.01
				})()`).catch(() => false)
				if (done) break
				await page.evaluate(`(() => { const b = document.getElementById('whoami-human'); if (b) b.click() })()`).catch(() => {})
				await sleep(400)
			}
			await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
			await page.waitForFunction('!document.getElementById("enter-arena").disabled', { timeout: 90000 })
			// Call the real entry path directly instead of clicking the plate: the splash
			// overlay can still be on top of #enter-arena, so a synthetic click lands on the
			// splash and silently does nothing (that is what timed out here before).
			// _enterArena() is what the PLAY click calls — it sets _arenaEntered and sends the
			// DeployCommand; only the pointer-lock/fullscreen requests inside it need a real
			// gesture, and those fail harmlessly headless.
			await page.evaluate('window.gameClient.simulator._enterArena()')
			await page.waitForFunction('window.gameClient.simulator.myRawEntity && window.gameClient.simulator._arenaEntered', { timeout: 45000 })
			inArena = true
		} catch (e) {
			const st = await page.evaluate('(() => { const s = window.gameClient && window.gameClient.simulator; const b = document.getElementById("enter-arena"); return { conn: s && s._connectionState, assets: s && s._assetsReady, stage: s && s._assetStage, disabled: b && b.disabled } })()').catch(() => null)
			console.log(`[probe] entry attempt ${attempt} failed: ${String(e).slice(0, 90)} state=${JSON.stringify(st)}`)
		}
	}
	if (!inArena) throw new Error('never got into the arena')
	console.log('[probe] in arena — watching for match end')

	const t0 = Date.now()
	let lastShot = 0, shotN = 0, lastKey = ''
	while (Date.now() - t0 < WATCH_MS) {
		let snap = null
		try { snap = await page.evaluate(SNAP) } catch (e) { snap = { evalError: String(e).slice(0, 80) } }
		const rel = Date.now() - t0
		// Record every sample where anything the player reads changed, so the timeline
		// is transitions rather than 200 identical rows.
		const key = JSON.stringify(snap)
		if (key !== lastKey) { lastKey = key; timeline.push({ ms: rel, ...snap }) }
		if (Date.now() - lastShot > SHOT_EVERY_MS) {
			lastShot = Date.now()
			const name = `${OUT}/shot-${String(shotN++).padStart(3, '0')}-${rel}ms.png`
			try { await page.screenshot({ path: name }) } catch (e) {}
		}
		await sleep(400)
	}
	// Finally: does DROP IN still work after all that?
	try {
		const hasDrop = await page.evaluate('!!document.getElementById("mc-drop") && document.getElementById("map-change").classList.contains("mc-ready")')
		timeline.push({ ms: Date.now() - t0, note: 'end-of-watch', readyCardUp: hasDrop })
	} catch (e) {}
} catch (e) {
	console.error('[probe] FAILED', e)
} finally {
	fs.writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 1))
	console.log(`[probe] ${timeline.length} transitions -> ${OUT}/timeline.json`)
	if (browser) await browser.close().catch(() => {})
	procs.forEach(kill)
	await sleep(500)
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
	await sleep(800)
	process.exit(0)
}
