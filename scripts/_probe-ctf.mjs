// CTF (Capture the Flag) end-to-end probe on CTF-Visage. Two server phases; ONE
// BROWSER PER CLIENT (background tabs rAF-throttle headless clients — the late-joiner
// lesson) with anti-throttle flags. Reuses a vite already on :8080; never sweeps a
// port it didn't open. Boots its own game server on 8078/8079.
//
//   node scripts/_probe-ctf.mjs
//
// PHASE 1 — MAP=visage, BOTS=0, DEV_SPAWN_AT=BLUE flag, FLAG_RETURN_SECONDS=4.
//   Two clients pinned to the BLUE (team1) flag stand:
//     A (team0) steals the BLUE flag on spawn (enemy touch); carrierNid = A; the
//       FLAG_TAKEN event fires; A's spawn immunity is revoked by the grab.
//     A then disconnects mid-carry (combat-log): the server DROPS the flag at the
//       death spot (FLAG_DROPPED), and the timed auto-return brings it HOME
//       (FLAG_RETURNED) within FLAG_RETURN_SECONDS. B observes the whole arc.
//
// PHASE 2 — MAP=visage, BOTS=1 (a lone OFFENSE bot with no enemy roams the objective),
//   one SPECTATOR observer (receives the messageAll ObjectiveEvent broadcasts):
//     the bot completes the full steal -> carry -> capture loop; each carry captures
//     EXACTLY once (captured == taken, small counts — the rising-edge / scores-once
//     proof); a bot participates in the objective (CTF bot smoke signal).
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
	await page.setViewport({ width: 640, height: 400 })
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
const listenObjective = page => page.evaluate(() => { window.__obj = []; window.gameClient.simulator.client.on('message::ObjectiveEvent', m => window.__obj.push({ kind: m.kind, team: m.team, nid: m.playerNid })) })
const deploy = async page => { await page.evaluate(() => window.gameClient.simulator.requestDeploy()); await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 20000 }) }

const results = []
const record = (name, ok, detail) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

let failed = false
let browserA = null, browserB = null, serverProc = null, viteProc = null, reuseVite = false
const errsA = [], errsB = []
try {
	// ============================ PHASE 1 =====================================
	serverProc = boot('npx', ['tsx', 'server/serverMain.js'],
		{ MAP: 'visage', BOTS: '0', DEV_SPAWN_AT: '-19.306,-37.508,-11.28', FLAG_RETURN_SECONDS: '4' }, 'server1', true)
	reuseVite = await portBusy(VITE_PORT)
	if (reuseVite) console.log(`[vite] reusing dev server already on :${VITE_PORT}`)
	else viteProc = boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	if (!(await waitServerBound(20000))) throw new Error('phase-1 server never bound :8079')
	await sleep(4000)

	browserA = await openBrowser(); browserB = await openBrowser()
	const pageA = await openPage(browserA, errsA)
	await listenObjective(pageA)
	await deploy(pageA)
	await sleep(1500)

	// A stole the BLUE (team1) flag on spawn
	const steal = await pageA.evaluate(() => {
		const sim = window.gameClient.simulator
		let blue = null
		sim.client.entities.forEach(e => { if (e.protocol && e.protocol.name === 'Flag' && e.team === 1) blue = e })
		return {
			mode: sim._matchState ? (sim._matchState.mode | 0) : -1,
			myTeam: sim.myRawEntity.teamId, mySmooth: sim.mySmoothId,
			flagState: blue ? blue.state : -1, carrier: blue ? blue.carrierNid : -1,
			imm: sim.myRawEntity.spawnImmunity,
			taken: window.__obj.filter(o => o.kind === 0).length,
		}
	})
	record('mode is CTF (2)', steal.mode === 2, `mode=${steal.mode}`)
	record('steal: enemy-flag touch -> CARRIED by me + FLAG_TAKEN event',
		steal.flagState === 1 && steal.carrier === steal.mySmooth && steal.taken >= 1,
		`state=${steal.flagState} carrier=${steal.carrier} me=${steal.mySmooth} takenEvents=${steal.taken}`)
	record('grab revokes spawn immunity (stood still — decay would take 1s)', steal.imm === 0, `spawnImmunity=${steal.imm}`)

	// B observes the drop + timed return after A combat-logs
	const pageB = await openPage(browserB, errsB)
	await listenObjective(pageB)
	await deploy(pageB) // B is team1 (BLUE owner), co-located; just observes
	await sleep(800)
	await pageA.close() // combat-log: A vanishes mid-carry -> server drops the flag
	// wait for DROPPED then RETURNED (timed auto-return within ~4s)
	let dropped = false, returned = false, endState = -1
	const t0 = Date.now()
	while (Date.now() - t0 < 12000) {
		const st = await pageB.evaluate(() => {
			const sim = window.gameClient.simulator
			let blue = null
			sim.client.entities.forEach(e => { if (e.protocol && e.protocol.name === 'Flag' && e.team === 1) blue = e })
			return { drop: window.__obj.filter(o => o.kind === 1).length, ret: window.__obj.filter(o => o.kind === 2).length, state: blue ? blue.state : -1 }
		})
		if (st.drop >= 1) dropped = true
		if (st.ret >= 1) returned = true
		endState = st.state
		if (dropped && returned && endState === 0) break
		await sleep(300)
	}
	record('drop on combat-log: carrier disconnect -> FLAG_DROPPED', dropped, `droppedEvent=${dropped}`)
	record('timed auto-return: DROPPED flag returns HOME (FLAG_RETURNED)', returned && endState === 0, `returnedEvent=${returned} endState=${endState}`)

	// ============================ PHASE BOUNDARY ==============================
	await browserA.close().catch(() => {}); browserA = null
	await browserB.close().catch(() => {}); browserB = null
	await killTree(serverProc)
	const portsFree = await waitPortsFree(15000)
	record('phase-1 server dead + ports free before phase 2', portsFree, `portsFree=${portsFree}`)
	if (!portsFree) throw new Error('ports still bound — refusing phase 2')
	serverLog = ''

	// ============================ PHASE 2 (capture) ==========================
	// Lone OFFENSE bot (nid 65532, even -> offense; no enemy -> roams the objective and
	// A*-navigates the full steal->carry->capture loop). A spectator observes the
	// messageAll ObjectiveEvent broadcasts without perturbing the bot (no entity).
	serverProc = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '1' }, 'server2', true)
	if (!(await waitServerBound(20000))) throw new Error('phase-2 server never bound')
	await sleep(4000)
	browserA = await openBrowser()
	const spec = await openPage(browserA, errsA)
	await listenObjective(spec) // stays a SPECTATOR — no deploy
	// let the bot run a couple full loops (round trip on Facing Worlds is ~20-30s)
	const t1 = Date.now()
	let taken = 0, captured = 0
	while (Date.now() - t1 < 75000) {
		const c = await spec.evaluate(() => ({ taken: window.__obj.filter(o => o.kind === 0).length, captured: window.__obj.filter(o => o.kind === 3).length }))
		taken = c.taken; captured = c.captured
		if (captured >= 1) { await sleep(1500); const c2 = await spec.evaluate(() => ({ taken: window.__obj.filter(o => o.kind === 0).length, captured: window.__obj.filter(o => o.kind === 3).length })); taken = c2.taken; captured = c2.captured; break }
		await sleep(1000)
	}
	record('capture: lone bot completes steal -> carry -> capture (FLAG_CAPTURED)', captured >= 1, `taken=${taken} captured=${captured}`)
	record('scores exactly once per carry: captured == taken (rising-edge guard)', captured >= 1 && captured === taken, `taken=${taken} captured=${captured}`)
	record('bot participates in the CTF objective', taken >= 1, `takenEvents=${taken}`)

	const realErrs = [...errsA, ...errsB].filter(m => !/client\/graphics\//.test(m))
	record('no page errors (CTF surface)', realErrs.length === 0, JSON.stringify(realErrs.slice(0, 3)))

	failed = results.some(r => !r[1])
	console.log(`\nCTF probe verdict: ${failed ? 'FAIL' : 'PASS'} (${results.filter(r => r[1]).length}/${results.length})`)
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browserA) await browserA.close().catch(() => {})
	if (browserB) await browserB.close().catch(() => {})
	await killTree(serverProc); await killTree(viteProc)
	await sleep(400)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
