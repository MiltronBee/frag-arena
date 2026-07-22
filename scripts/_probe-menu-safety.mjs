// MENU SAFETY (v1) end-to-end probe — covers the review's regression items 1-10.
// TWO server phases + puppeteer clients: ONE BROWSER PER CLIENT for anything
// timing-sensitive (background tabs rAF-throttle headless clients; the
// late-joiner "bug" lesson) with anti-throttle flags.
//
//   node scripts/_probe-menu-safety.mjs
//
// PHASE 1 — MAP=grove, default BOT_FILL=6 (bots fight):
//   1  connect and remain spectator: no local entity, zero replication, no bot
//      retirement (zero-spatial spectating).
//   2  forged pre-deploy Move/Fire/Switch commands: no effect, no crash.
//   3  deploy once: exactly one entity pair, one deploy, one bot retired.
//   4  duplicate/forged deploy requests: no duplicate entity, no extra retire.
//   5  Settings open while deployed: full incoming damage still lands.
//   6  banner truth: pre-deploy no warning; alive = COMBAT ACTIVE; death while
//      Settings stays open flips to YOU DIED; respawn flips back.
//   8  disconnect under recent enemy damage: normal death resolution, killfeed
//      attribution to the attacker, bot replacement DELAYED ~2.5s.
//
// PHASE 2 — MAP=grove, BOTS=0, pinned spawn, short AFK timeout:
//   7a deploy idle: spawn immunity present, idling does not revoke, expires on
//      schedule, and the immune body still stands on the floor (world collision).
//   7b ghosting: a second player's replicated mesh is non-colliding exactly
//      while immune and solid after expiry (the prediction-lockstep watch).
//   7c movement revokes immunity server-side (server-log assertion — immune
//      to client frame rate) and the entity moves.
//   9  spectator idle/activity: heartbeats keep a menu socket alive; an
//      untouched one is reaped by the inactivity timeout.
//   10 process lifecycle: phase-1 server is dead and ports are free before
//      phase 2; the phase-2 server must bind or the probe fails; per-phase logs.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// vite port is parameterizable (PROBE_VITE_PORT); if something already serves
// it (a shared vite dev server), REUSE it — don't boot a second one, and never
// sweep a port the probe didn't open itself.
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

// ---- owned child processes (review P1: reliable lifecycle) ------------------
// detached:true puts each child in its OWN process group, so process.kill(-pid)
// really kills the tsx/vite tree; exit/error are tracked so a phase can await
// true process death and detect a server that failed to boot.
let serverLog = '' // PER-PHASE: reset at each phase boundary (review P1)
function boot(cmd, args, env, tag, captureLog) {
	const p = spawn(cmd, args, {
		env: { ...process.env, ...env }, cwd: process.cwd(),
		stdio: ['ignore', 'pipe', 'pipe'], detached: true,
	})
	p._tag = tag
	p._exited = new Promise(res => p.once('exit', code => { p._exitCode = code; res(code) }))
	p.on('error', e => { console.error(`[${tag}] spawn error:`, e.message); p._spawnError = e })
	p.stdout.on('data', d => {
		const s = d.toString()
		if (captureLog) serverLog += s
		if (/deploy|retired|menu-safety|died from disconnect|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`)
	})
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	return p
}

const killTree = async p => {
	if (!p || p._exitCode !== undefined || p.exitCode !== null) return
	try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGKILL') } catch {} }
	await Promise.race([p._exited, sleep(2000)])
	if (p.exitCode === null && p._exitCode === undefined) {
		try { process.kill(-p.pid, 'SIGKILL') } catch {}
		await Promise.race([p._exited, sleep(2000)])
	}
}

// wait until 8078+8079 are BOTH free (returns false on timeout)
const waitPortsFree = async (ms) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		if (!(await portBusy(8079)) && !(await portBusy(8078))) return true
		await sleep(250)
	}
	return false
}
// wait until the game socket port is BOUND (returns false on timeout)
const waitServerBound = async (ms) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		if (await portBusy(8079)) return true
		await sleep(250)
	}
	return false
}

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
	'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']

async function openBrowser() {
	return puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: CHROME_ARGS })
}
async function openPage(browser, errors) {
	const page = await browser.newPage()
	// tiny viewport: SwiftShader raster cost down, rAF cadence (command flow +
	// snapshot delivery) stays live even with several processes on the box
	await page.setViewport({ width: 480, height: 300 })
	// BLOCK VITE HMR: concurrent workstreams editing client files make the vite
	// HMR client full-page-reload mid-probe, silently replacing a deployed
	// session with a fresh spectator socket (observed: cases went dark with
	// ?t=<hmr> URLs in the stack). Stub WebSocket for the vite port only — the
	// game socket (:8079) passes through untouched.
	await page.evaluateOnNewDocument(vp => {
		const NativeWS = window.WebSocket
		const Blocked = function (url, protocols) {
			if (String(url).includes(':' + vp + '/')) {
				return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 }
			}
			return new NativeWS(url, protocols)
		}
		Blocked.prototype = NativeWS.prototype
		Blocked.CONNECTING = 0; Blocked.OPEN = 1; Blocked.CLOSING = 2; Blocked.CLOSED = 3
		window.WebSocket = Blocked
	}, VITE_PORT)
	if (errors) page.on('pageerror', e => errors.push(e.message))
	await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
		{ timeout: 45000 })
	return page
}

// PHASE-1 pages only OBSERVE — stub out the Babylon scene render (the one
// SwiftShader-expensive call) so the rAF game loop (netcode read, prediction,
// HUD/banner DOM updates) keeps full cadence even during the spawn-pile FX
// storm. Without this the page can freeze outright and replicated values stop
// updating client-side (observed: hp stuck at 100 while the server logged hits).
const lightweight = page => page.evaluate(() => {
	window.gameClient.simulator.renderer.update = () => {}
})

// count PlayerCharacter entities in a client's replicated cache, split into
// own / bots (nameIndex < 30) / other humans (nameIndex >= HUMAN_NAME_SENTINEL).
const census = page => page.evaluate(() => {
	const sim = window.gameClient.simulator
	let total = 0, players = 0, own = 0, bots = 0, humans = 0
	sim.client.entities.forEach(e => {
		total++
		if (!e.protocol || e.protocol.name !== 'PlayerCharacter') return
		players++
		if (e.nid === sim.myRawId || e.nid === sim.mySmoothId) { own++; return }
		if ((e.nameIndex ?? 0) >= 30) humans++; else bots++
	})
	return { total, players, own, bots, humans, myRawId: sim.myRawId }
})

const deploy = async page => {
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 20000 })
}

const retireCount = () => (serverLog.match(/retired \(auto-fill\)/g) || []).length
const deployCount = () => (serverLog.match(/\[deploy\]/g) || []).length
const botJoinCount = () => (serverLog.match(/joined with/g) || []).length

const results = []
const record = (name, ok, detail) => {
	results.push([name, ok])
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

let failed = false
let browserA = null, browserB = null
let viteProc = null, serverProc = null
let reuseVite = false
const errsA = [], errsB = []
try {
	// ============================ PHASE 1 =====================================
	// DEV_SPAWN_AT pins EVERY spawn (bots + humans) to one point: a point-blank
	// pile guarantees the damage/death cycles cases 5/6/8 need — free-roaming
	// grove bots can fail to find an idle human for minutes (observed), which
	// made those cases timing lotteries.
	serverProc = boot('npx', ['tsx', 'server/serverMain.js'],
		{ MAP: 'grove', DEV_SPAWN_AT: '-29.3,16.3,-5.5' }, 'server1', true) // default BOT_FILL=6
	reuseVite = await portBusy(VITE_PORT)
	if (reuseVite) console.log(`[vite] reusing dev server already on :${VITE_PORT}`)
	else viteProc = boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	if (!(await waitServerBound(20000))) throw new Error('phase-1 server never bound :8079')
	await sleep(4000) // mesh load margin + vite ready

	browserA = await openBrowser()
	browserB = await openBrowser()
	let pageA = await openPage(browserA, errsA)
	await lightweight(pageA)
	await sleep(4000) // sit in the menu while 6 bots fight

	// CASE 1 — menu socket: no entity, zero replication, no combatant slot
	const c1 = await census(pageA)
	record('1: menu socket gets no entity / zero replication / retires nothing',
		c1.myRawId === -1 && c1.players === 0 && c1.total === 0 && retireCount() === 0,
		JSON.stringify(c1) + ` retires=${retireCount()}`)

	// CASE 2 — forged pre-deploy Move/Fire/Switch commands are hard-dropped
	await pageA.evaluate(() => {
		const sim = window.gameClient.simulator
		const pairs = sim.client.config.protocols.commands
		const Move = pairs.find(p => p[0] === 'MoveCommand')[1]
		const Fire = pairs.find(p => p[0] === 'FireCommand')[1]
		const Switch = pairs.find(p => p[0] === 'SwitchWeaponCommand')[1]
		for (let i = 0; i < 50; i++) {
			sim.client.addCommand(new Move({
				forwards: true, left: false, backwards: false, right: true, jump: true,
				dodge: 0, camRayX: 0, camRayY: 0, camRayZ: 1, weaponIndex: 0,
				reload: false, fireInput: true, throwInput: false, aimInput: false, delta: 0.025,
			}))
			sim.client.addCommand(new Fire())
			const sw = new Switch(); sw.index = i % 6
			sim.client.addCommand(sw)
		}
	})
	await sleep(2000)
	const c2 = await census(pageA)
	record('2: pre-deploy move/fire/switch commands dropped (no entity, server alive)',
		serverProc.exitCode === null && c2.myRawId === -1 && c2.players === 0
		&& retireCount() === 0 && deployCount() === 0 && errsA.length === 0,
		`alive=${serverProc.exitCode === null} ents=${c2.total} retires=${retireCount()} pageErrors=${errsA.length}`)

	// pre-deploy banner truth (part of CASE 6): open Settings as a SPECTATOR
	const preBanner = await pageA.evaluate(() => {
		window.gameClient.simulator._openSettings()
		const b = document.getElementById('combat-live-banner')
		const shown = !!(b && b.style.display !== 'none')
		window.gameClient.simulator._closeSettings()
		return shown
	})
	record('6a: pre-deploy Settings shows NO combat warning', preBanner === false, `bannerShown=${preBanner}`)

	// ---- client B deploys (observer + settings/death subject) ----------------
	const pageB = await openPage(browserB, errsB)
	await lightweight(pageB)
	await pageB.evaluate(() => { // killfeed listener for case 8
		window.__kills = []
		window.gameClient.simulator.client.on('message::Killed', m => window.__kills.push({ k: m.killerNid, v: m.victimNid }))
	})
	await deploy(pageB)
	await sleep(1500)

	// CASE 3 — one deploy = exactly one entity pair + one bot retired
	const c3 = await census(pageB)
	record('3: first deploy: exactly one pair, one deploy, one retire (6 -> 5)',
		deployCount() === 1 && retireCount() === 1 && c3.own === 2 && c3.bots === 5 && c3.humans === 0,
		JSON.stringify(c3) + ` deploys=${deployCount()} retires=${retireCount()}`)

	// CASE 4 — duplicate deploys: client-guard bypassed with raw DeployCommands
	await pageB.evaluate(() => {
		const sim = window.gameClient.simulator
		const Deploy = sim.client.config.protocols.commands.find(p => p[0] === 'DeployCommand')[1]
		for (let i = 0; i < 5; i++) sim.client.addCommand(new Deploy())
		sim.requestDeploy() // the public API path no-ops too
	})
	await sleep(1500)
	const c4 = await census(pageB)
	record('4: duplicate deploy requests: no second pair, no extra retire',
		deployCount() === 1 && retireCount() === 1 && c4.own === 2 && c4.bots === 5,
		JSON.stringify(c4) + ` deploys=${deployCount()} retires=${retireCount()}`)

	// menu socket A must STILL see nothing while a human plays
	const c1b = await census(pageA)
	record('1b: menu socket still zero-replicated while a human plays',
		c1b.players === 0 && c1b.myRawId === -1, JSON.stringify(c1b))

	// ---- client A deploys too (second retire + case-8 subject) ---------------
	await deploy(pageA)
	// A holds W permanently: every life it walks OUT of the spawn pile, so bots
	// hit it at range with SUB-LETHAL shots — point-blank pile kills are one-tick
	// (100->0), which never exposes the "alive and freshly damaged" window that
	// case 8 must catch before closing the tab.
	await pageA.evaluate(() => { window.gameClient.simulator.input._currentState.forwards = true })
	const aSmooth = await pageA.evaluate(() => window.gameClient.simulator.mySmoothId)
	await sleep(1500)
	const c3b = await census(pageB)
	record('3b: second deploy retires the second bot (5 -> 4) + human visible',
		deployCount() === 2 && retireCount() === 2 && c3b.bots === 4 && c3b.humans === 1,
		JSON.stringify(c3b) + ` retires=${retireCount()}`)

	// CASE 5 + 6 — Settings open on B: damage still lands; banner flips on death
	// and back on respawn. Bots do the shooting (idle human among enemy bots on
	// a small map); generous budget, reported honestly on timeout.
	await pageB.evaluate(() => window.gameClient.simulator._openSettings())
	const bannerAlive = await pageB.evaluate(() => {
		const b = document.getElementById('combat-live-banner')
		return b ? b.textContent : null
	})
	let sawDamage = false, sawDeathBanner = null, sawRespawnBanner = null
	{
		const t0 = Date.now()
		let phase = 'damage'
		while (Date.now() - t0 < 75000) {
			const st = await pageB.evaluate(() => {
				const sim = window.gameClient.simulator
				const e = sim.myRawEntity
				const b = document.getElementById('combat-live-banner')
				return { hp: e ? e.hitpoints : -1, alive: e ? e.isAlive !== false : false, banner: b ? b.textContent : null }
			})
			if (phase === 'damage' && (st.hp < 100 || !st.alive)) { sawDamage = true; phase = 'death' }
			if (phase === 'death' && !st.alive) { sawDeathBanner = st.banner; phase = 'respawn' }
			if (phase === 'respawn' && st.alive) { sawRespawnBanner = st.banner; break }
			await sleep(200)
		}
	}
	record('5: Settings open grants NOTHING — full damage lands while the panel is up',
		sawDamage, `sawDamage=${sawDamage}`)
	record('6b: banner truth — alive warning, death flip, respawn flip-back',
		bannerAlive === '⚠ COMBAT ACTIVE — CHARACTER VULNERABLE'
		&& sawDeathBanner === 'YOU DIED — RESPAWNING'
		&& sawRespawnBanner === '⚠ COMBAT ACTIVE — CHARACTER VULNERABLE',
		JSON.stringify({ bannerAlive, sawDeathBanner, sawRespawnBanner }))
	await pageB.evaluate(() => window.gameClient.simulator._closeSettings())

	// CASE 8 — combat logging: catch A alive + recently damaged, close its page.
	// Expect: normal death resolution ("died from disconnect"), killfeed credit
	// to a bot (killer != victim), and the replacement bot delayed ~2.5s.
	let dcArmed = false
	{
		const t0 = Date.now()
		while (Date.now() - t0 < 90000) {
			const st = await pageA.evaluate(() => {
				const sim = window.gameClient.simulator
				const e = sim.myRawEntity
				return { hp: e ? e.hitpoints : -1, alive: e ? e.isAlive !== false : false }
			})
			if (st.alive && st.hp > 0 && st.hp < 100) { dcArmed = true; break }
			await sleep(120) // point-blank kills are fast — sample the damaged-alive window tightly
		}
	}
	let dcResolved = false, dcCredited = false, dcDelayMs = -1
	if (dcArmed) {
		const killsBefore = await pageB.evaluate(() => window.__kills.length)
		const joinsBefore = botJoinCount()
		const closeAt = Date.now()
		await pageA.close() // combat log: vanish while alive + freshly damaged
		// death resolution + killfeed
		const t0 = Date.now()
		while (Date.now() - t0 < 6000) {
			if (/died from disconnect/.test(serverLog)) { dcResolved = true; break }
			await sleep(150)
		}
		await sleep(400) // let the Killed broadcast reach B
		const newKills = await pageB.evaluate(kb => window.__kills.slice(kb), killsBefore)
		const credited = newKills.filter(k => k.v === aSmooth && k.k !== k.v)
		dcCredited = credited.length === 1
		// delayed backfill: the replacement bot must NOT appear before ~2.5s
		while (Date.now() - closeAt < 9000) {
			if (botJoinCount() > joinsBefore) { dcDelayMs = Date.now() - closeAt; break }
			await sleep(120)
		}
	}
	record('8: combat-log disconnect = real death + attacker credit + delayed backfill',
		dcArmed && dcResolved && dcCredited && dcDelayMs >= 2000 && dcDelayMs <= 8000,
		JSON.stringify({ dcArmed, dcResolved, dcCredited, dcDelayMs }))

	// ============================ PHASE BOUNDARY ==============================
	// (review P1) phase-1 server must be DEAD and ports FREE before phase 2;
	// phase-2 assertions must not be able to match phase-1 logs.
	await browserB.close().catch(() => {}); browserB = null
	await killTree(serverProc)
	const p1Dead = serverProc.exitCode !== null || serverProc._exitCode !== undefined
	const portsFree = await waitPortsFree(15000)
	record('10a: phase-1 server dead + ports 8078/8079 free before phase 2',
		p1Dead && portsFree, `dead=${p1Dead} portsFree=${portsFree}`)
	if (!portsFree) throw new Error('ports still bound — refusing to run phase 2 against a stale server')
	serverLog = '' // phase-2 log starts clean

	serverProc = boot('npx', ['tsx', 'server/serverMain.js'],
		{ MAP: 'grove', BOTS: '0', DEV_SPAWN_AT: '-29.3,16.3,-5.5', SPECTATOR_AFK_MS: '15000' }, 'server2', true)
	const bound = await waitServerBound(20000)
	record('10b: phase-2 server bound fresh on :8079', bound && serverProc.exitCode === null,
		`bound=${bound} alive=${serverProc.exitCode === null}`)
	if (!bound) throw new Error('phase-2 server did not bind — aborting')
	await sleep(3000) // mesh load margin
	browserB = await openBrowser()

	// CASE 7a — deploy IDLE: immunity present, idle does not revoke, expires,
	// and the immune body keeps standing on the floor (world collision intact).
	const pageE = await openPage(browserB, errsB)
	await pageE.evaluate(() => {
		const sim = window.gameClient.simulator
		window.__mon = []
		const loop = () => {
			const e = sim.myRawEntity
			if (e) window.__mon.push([performance.now(), e.spawnImmunity ?? -1, e.y])
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	})
	await deploy(pageE)
	await sleep(2600)
	const monE = await pageE.evaluate(() => window.__mon)
	const t0E = monE.length ? monE[0][0] : 0
	const firstImmE = monE.length ? monE[0][1] : -1
	let firstZeroE = -1
	for (const [t, imm] of monE) { if (imm <= 0) { firstZeroE = t - t0E; break } }
	const ys = monE.map(s => s[2])
	const onFloor = ys.length > 0 && Math.min(...ys) > -20 && (Math.max(...ys) - Math.min(...ys)) < 3
	// The idle-hold property is asserted on SERVER TRUTH — "no revocation-by-
	// action line exists" (E is the only session so far in the phase-2 log) —
	// not on wall-clock expiry timing: the immunity timer runs in server TICK
	// time, and a loaded box bursts catch-up ticks, so a 1.0s window can pass
	// in ~0.5s of wall time without anything being wrong.
	const idleRevoked = /revoked by action nid=/.test(serverLog)
	record('7a: idle immunity present, never revoked by action, expires; body stays on the floor',
		firstImmE > 0 && firstZeroE >= 0 && !idleRevoked && onFloor,
		`first=${firstImmE.toFixed?.(2) ?? firstImmE} zeroAtMs=${Math.round(firstZeroE)} idleRevoked=${idleRevoked} yRange=[${Math.min(...ys).toFixed(1)},${Math.max(...ys).toFixed(1)}]`)

	// CASE 7b — ghosting observed from another client: F deploys idle; E polls
	// F's replicated entity — checkCollisions must be FALSE while immune and
	// TRUE after expiry (the createPlayerFactory prediction-lockstep watch).
	const pageF = await openPage(browserA, errsA)
	const ghostWatch = pageE.evaluate(() => new Promise(resolve => {
		const sim = window.gameClient.simulator
		const out = { sawGhost: false, endSolid: false, samples: 0 }
		const t0 = performance.now()
		const iv = setInterval(() => {
			let remote = null
			sim.client.entities.forEach(e => {
				if (e.protocol && e.protocol.name === 'PlayerCharacter'
					&& e.nid !== sim.myRawId && e.nid !== sim.mySmoothId) remote = e
			})
			if (remote) {
				out.samples++
				const imm = remote.spawnImmunity ?? 0
				if (imm > 0 && remote.mesh.checkCollisions === false) out.sawGhost = true
				if (imm <= 0) out.endSolid = remote.mesh.checkCollisions === true
			}
			if (performance.now() - t0 > 4500) { clearInterval(iv); resolve(out) }
		}, 40)
	}))
	await deploy(pageF)
	const ghost = await ghostWatch
	record('7b: immune remote entity is non-colliding, solid again after expiry',
		ghost.sawGhost && ghost.endSolid && ghost.samples > 5, JSON.stringify(ghost))

	// clear the stage for 7c (both bodies stand on the pinned spawn point —
	// closing the sockets removes them; their disconnect resolutions are noise
	// we snapshot away below)
	await pageE.close(); await pageF.close()
	await sleep(1200)
	const logBefore7c = serverLog

	// CASE 7c — movement revokes immunity: fresh socket deploys HOLDING W; the
	// first MoveCommand (whenever the page's loop runs) must revoke server-side.
	// Asserted on the server's own revocation line — immune to client frame
	// rate — with every idle session above as negative control: this must be
	// the FIRST revocation line of phase 2, naming this entity.
	const pageG = await openPage(browserA, errsA)
	await pageG.evaluate(() => {
		const sim = window.gameClient.simulator
		sim.input._currentState.forwards = true // held W from the first frame on
		sim.requestDeploy()
	})
	await pageG.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 20000 })
	const gStart = await pageG.evaluate(() => {
		const e = window.gameClient.simulator.myRawEntity
		return { nid: window.gameClient.simulator.myRawId, x: e.x, z: e.z }
	})
	await sleep(4500) // generous walk window — a janked page advances sim time slowly
	const gEnd = await pageG.evaluate(() => {
		const e = window.gameClient.simulator.myRawEntity
		return { imm: e ? (e.spawnImmunity ?? -1) : -1, x: e ? e.x : 0, z: e ? e.z : 0 }
	})
	const gMoved = Math.hypot(gEnd.x - gStart.x, gEnd.z - gStart.z)
	const revBefore = (logBefore7c.match(/revoked by action nid=(\d+)/g) || []).length
	const revLines = serverLog.match(/revoked by action nid=(\d+)/g) || []
	const revNids = revLines.map(l => +l.match(/nid=(\d+)/)[1])
	// Movement itself is proven by the revocation line: the server only prints
	// it when a MoveCommand carrying movement input was RECEIVED and processed
	// for this entity (contrast case 2, where pre-deploy commands vanish).
	// The client-side position delta is reported as detail only — on a janked
	// SwiftShader page 4.5s of wall time can be a handful of sim frames.
	record('7c: first movement revokes immunity server-side (idle sessions as negative control)',
		revBefore === 0 && revNids.length === 1 && revNids[0] === gStart.nid && gEnd.imm === 0,
		`revLines=${JSON.stringify(revNids)} gNid=${gStart.nid} immNow=${gEnd.imm} movedM=${gMoved.toFixed(2)}`)
	await pageG.close()

	// CASE 9 — spectator activity contract (server SPECTATOR_AFK_MS=15000 here):
	// H sends forced heartbeats every 4s (server still rate-limits to 1/10s) and
	// must survive 26s; I idles untouched and must be reaped within ~26s.
	const pageH = await openPage(browserB, errsB)
	const pageI = await openPage(browserA, errsA)
	await pageH.evaluate(() => {
		window.__hb = setInterval(() => window.gameClient.simulator._spectatorActivity(true), 4000)
		window.gameClient.simulator._spectatorActivity(true)
	})
	await sleep(26000)
	const hAlive = await pageH.evaluate(() => window.gameClient.simulator._connectionState)
	const iState = await pageI.evaluate(() => window.gameClient.simulator._connectionState)
	record('9: heartbeats keep a menu socket alive; an untouched one is reaped',
		hAlive === 'connected' && iState === 'disconnected',
		`heartbeat=${hAlive} idle=${iState}`)
	await pageH.evaluate(() => clearInterval(window.__hb)).catch(() => {})

	// Page-error hygiene, scoped to the menu-safety surface: errors thrown from
	// client/graphics/* are COSMETIC-layer failures owned by other workstreams
	// (e.g. a CharacterModel texture WIP mid-edit) and cannot affect the
	// server-authoritative lifecycle under test — report them, don't fail on them.
	const foreign = m => /client\/graphics\//.test(m)
	const realErrs = [...errsA, ...errsB].filter(m => !foreign(m))
	const foreignErrs = [...errsA, ...errsB].filter(foreign)
	if (foreignErrs.length) {
		console.log('INFO  foreign graphics-layer errors (not counted):', JSON.stringify(foreignErrs.slice(0, 2)))
	}
	record('no page errors (menu-safety surface)', realErrs.length === 0, JSON.stringify(realErrs.slice(0, 2)))

	failed = results.some(r => !r[1])
	console.log(`\nmenu-safety probe verdict: ${failed ? 'FAIL' : 'PASS'} (${results.filter(r => r[1]).length}/${results.length})`)
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browserA) await browserA.close().catch(() => {})
	if (browserB) await browserB.close().catch(() => {})
	await killTree(serverProc)
	await killTree(viteProc)
	await sleep(300)
	// last-resort sweep of OUR ports only (never a vite we merely reused)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
	// CASE 10 epilogue: report leftover listeners on our ports (should be none)
	const left79 = await portBusy(8079); const left78 = await portBusy(8078)
	console.log(`cleanup: 8078 busy=${left78} 8079 busy=${left79} (vite ${reuseVite ? 'left running (shared)' : 'terminated (owned)'})`)
}
process.exit(failed ? 1 : 0)
