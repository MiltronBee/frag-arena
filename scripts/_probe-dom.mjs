// DOM (Domination) end-to-end probe on DOM-Elder. Two phases; ONE browser (single
// client per phase). Anti-throttle Chrome flags (background tabs rAF-throttle headless
// clients — the late-joiner lesson). Reuses a vite already on :8080; never sweeps a
// port it didn't open. Boots its own game server on 8078/8079.
//
//   node scripts/_probe-dom.mjs
//
// PHASE 1 — MAP=dom_elder, BOTS=0, DEV_SPAWN_AT=point A. One client:
//   convert    — spawning ON point A converts it to my team (teleporter-style touch)
//   rising     — DOM_CAPTURED fires EXACTLY once for my conversion (no per-tick spam)
//   immunity   — the convert revokes my spawn immunity (mega-pickup rule)
//   hold-score — while I hold A my team's score TICKS up (~1/sec via the central tick)
//
// PHASE 2 — MAP=dom_elder, BOTS=3 (no pin): DOM boots with bots without breaking the
//   objective system; bots are present + points stay valid; zero page errors. (Bots
//   completing point captures is nav-limited in v1 — reported honestly, not required.)
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

let serverLog = ''
function boot(cmd, args, env, tag, captureLog) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	p._exited = new Promise(res => p.once('exit', code => { p._exitCode = code; res(code) }))
	p.stdout.on('data', d => { const s = d.toString(); if (captureLog) serverLog += s; if (/objective|match\] mode|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	return p
}
const killTree = async p => {
	if (!p || p._exitCode !== undefined || p.exitCode !== null) return
	try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGKILL') } catch {} }
	await Promise.race([p._exited, sleep(2000)])
	if (p.exitCode === null && p._exitCode === undefined) { try { process.kill(-p.pid, 'SIGKILL') } catch {}; await Promise.race([p._exited, sleep(2000)]) }
}
const waitPortsFree = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await portBusy(8079)) && !(await portBusy(8078))) return true; await sleep(250) } return false }
const waitServerBound = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await portBusy(8079)) return true; await sleep(250) } return false }

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
	'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
const openBrowser = () => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: CHROME_ARGS })
async function openPage(browser, errors) {
	const page = await browser.newPage()
	await page.setViewport({ width: 700, height: 440 })
	await page.evaluateOnNewDocument(vp => {
		const NativeWS = window.WebSocket
		const Blocked = function (url, protocols) { if (String(url).includes(':' + vp + '/')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 }; return new NativeWS(url, protocols) }
		Blocked.prototype = NativeWS.prototype; Blocked.CONNECTING = 0; Blocked.OPEN = 1; Blocked.CLOSING = 2; Blocked.CLOSED = 3
		window.WebSocket = Blocked
	}, VITE_PORT)
	if (errors) page.on('pageerror', e => errors.push(e.message))
	await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 45000 })
	return page
}

const results = []
const record = (name, ok, detail) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

let failed = false
let browser = null, serverProc = null, viteProc = null, reuseVite = false
const errs = []
try {
	// ============================ PHASE 1 =====================================
	serverProc = boot('npx', ['tsx', 'server/serverMain.js'],
		{ MAP: 'dom_elder', BOTS: '0', DEV_SPAWN_AT: '-2.497,4.002,2.556' }, 'server1', true) // point A native
	reuseVite = await portBusy(VITE_PORT)
	if (reuseVite) console.log(`[vite] reusing dev server already on :${VITE_PORT}`)
	else viteProc = boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	if (!(await waitServerBound(20000))) throw new Error('phase-1 server never bound :8079')
	await sleep(4000)

	browser = await openBrowser()
	const page = await openPage(browser, errs)
	await page.evaluate(() => { window.__obj = []; window.gameClient.simulator.client.on('message::ObjectiveEvent', m => window.__obj.push({ kind: m.kind, team: m.team, nid: m.playerNid })) })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 20000 })
	await sleep(1500)

	const st = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const cps = []
		sim.client.entities.forEach(e => { if (e.protocol && e.protocol.name === 'ControlPoint') cps.push({ index: e.index, owner: e.owner }) })
		cps.sort((a, b) => a.index - b.index)
		const A = cps.find(c => c.index === 0)
		return {
			mode: sim._matchState ? (sim._matchState.mode | 0) : -1, myTeam: sim.myRawEntity.teamId, mySmooth: sim.mySmoothId,
			nPoints: cps.length, aOwner: A ? A.owner : -1, imm: sim.myRawEntity.spawnImmunity,
			domCapturedMine: window.__obj.filter(o => o.kind === 4 && o.nid === sim.mySmoothId).length,
			s0: sim._matchState.teamScore0, s1: sim._matchState.teamScore1,
		}
	})
	record('mode is DOM (3) + 3 control points replicated', st.mode === 3 && st.nPoints === 3, `mode=${st.mode} points=${st.nPoints} myTeam=${st.myTeam}`)
	record('convert: spawning on point A flips it to my team', st.aOwner === st.myTeam, `A.owner=${st.aOwner} myTeam=${st.myTeam}`)
	record('rising edge: DOM_CAPTURED fires exactly once for my conversion', st.domCapturedMine === 1, `myDomCaptured=${st.domCapturedMine}`)
	record('convert revokes spawn immunity', st.imm === 0, `spawnImmunity=${st.imm}`)

	// hold ~6.5s standing on A; my team's score must climb (~1/sec)
	const beforeMy = st.myTeam === 0 ? st.s0 : st.s1
	await sleep(6500)
	const after = await page.evaluate(() => { const m = window.gameClient.simulator._matchState; return { s0: m.teamScore0, s1: m.teamScore1 } })
	const afterMy = st.myTeam === 0 ? after.s0 : after.s1
	record('hold-score: my team score climbs while I hold the point', afterMy - beforeMy >= 3, `myTeamScore ${beforeMy} -> ${afterMy} (+${afterMy - beforeMy})`)

	// screenshot the DOM HUD chips
	await page.evaluate(() => { ;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() }); document.body.classList.add('arena-entered') })
	await sleep(400)
	await page.screenshot({ path: '_work/probe-dom.png' })

	// ============================ PHASE BOUNDARY ==============================
	await browser.close().catch(() => {}); browser = null
	await killTree(serverProc)
	const portsFree = await waitPortsFree(15000)
	record('phase-1 server dead + ports free before phase 2', portsFree, `portsFree=${portsFree}`)
	if (!portsFree) throw new Error('ports still bound — refusing phase 2')
	serverLog = ''

	// ============================ PHASE 2 (bot smoke) ========================
	serverProc = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dom_elder', BOTS: '3' }, 'server2', true)
	if (!(await waitServerBound(20000))) throw new Error('phase-2 server never bound')
	await sleep(4000)
	browser = await openBrowser()
	const page2 = await openPage(browser, errs)
	await page2.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page2.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 20000 })
	await sleep(9000) // let bots run in DOM
	const smoke = await page2.evaluate(() => {
		const sim = window.gameClient.simulator
		let bots = 0, pointsOk = true, nPts = 0
		sim.client.entities.forEach(e => {
			if (!e.protocol) return
			if (e.protocol.name === 'PlayerCharacter' && (e.nameIndex ?? 0) < 30 && e.nid !== sim.myRawId && e.nid !== sim.mySmoothId) bots++
			if (e.protocol.name === 'ControlPoint') { nPts++; if (!(e.owner === 0 || e.owner === 1 || e.owner === 2)) pointsOk = false }
		})
		return { bots, pointsOk, nPts }
	})
	record('bot smoke: DOM boots with bots, points stay valid, server alive',
		smoke.bots >= 1 && smoke.pointsOk && smoke.nPts === 3 && serverProc.exitCode === null,
		`bots=${smoke.bots} pointsValid=${smoke.pointsOk} points=${smoke.nPts} serverAlive=${serverProc.exitCode === null}`)

	const realErrs = errs.filter(m => !/client\/graphics\//.test(m))
	record('no page errors (DOM surface)', realErrs.length === 0, JSON.stringify(realErrs.slice(0, 3)))

	failed = results.some(r => !r[1])
	console.log(`\nDOM probe verdict: ${failed ? 'FAIL' : 'PASS'} (${results.filter(r => r[1]).length}/${results.length})`)
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	await killTree(serverProc); await killTree(viteProc)
	await sleep(400)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
