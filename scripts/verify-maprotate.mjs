// MAP-ROTATION TRANSITION verify. Boots a server, joins, enters the arena, then KILLS
// the server to reproduce exactly what a rotation does (the rotation IS a server exit +
// pm2 restart). Asserts the new transition:
//   - the CHANGING MAP interstitial shows in its LOADING state
//   - the page reloads and comes back with the interstitial still up (no naked menu)
//   - it reaches the READY state naming the map/mode, and does NOT auto-enter
//   - the player is NOT deployed while the card is up (no being shot at in a menu)
//   - clicking DROP IN enters the arena and takes pointer lock
import { spawn } from 'child_process'
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
	// detached: own process group, so process.kill(-pid) reaches the real `tsx` child
	// and not just the npx wrapper. Without this the server survived the "rotation",
	// the socket never dropped, and the next boot hit EADDRINUSE on 8078.
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	p.stderr.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stderr.write(`[${tag}] ${s}`) })
	procs.push(p)
	return p
}
const kill = p => { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
// Belt and braces: the rotation is defined by the game port going away, so assert it.
const freeGamePorts = () => new Promise(res => {
	const k = spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
	k.on('exit', () => res())
})
const waitPortFree = async (port, ms = 15000) => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (!(await portBusy(port))) return true
		await sleep(300)
	}
	return false
}

let browser = null, reuseVite = false, fail = false
const checks = []
const ck = (name, ok, extra = '') => { checks.push([name, ok, extra]); if (!ok) fail = true }
try {
	let server = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_hex2', BOT_FILL: '1' }, 'srv')
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
	await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
	// enter the arena the normal way (a real click on PLAY)
	await page.waitForFunction('!document.getElementById("enter-arena").disabled', { timeout: 60000 })
	await page.click('#enter-arena')
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	await sleep(1500)
	ck('entered arena before rotation', await page.evaluate('!!window.gameClient.simulator._arenaEntered'))

	// ---- ROTATION: the server exits, exactly as it does at MATCH_END ----
	kill(server)
	await freeGamePorts()
	const freed = await waitPortFree(8078)
	ck('game port actually released (rotation really happened)', freed)
	await sleep(1200)
	const loading = await page.evaluate(() => {
		const mc = document.getElementById('map-change')
		return { visible: !!mc && mc.classList.contains('mc-visible'), ready: !!mc && mc.classList.contains('mc-ready') }
	})
	ck('interstitial shows on drop', loading.visible, JSON.stringify(loading))
	ck('interstitial is in LOADING state (not READY)', loading.visible && !loading.ready)

	// bring the "next map" server back up like pm2 would, then let the client reload
	server = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOT_FILL: '1' }, 'srv2')
	await page.waitForNavigation({ timeout: 30000 }).catch(() => {})
	// Wait for the READY state rather than a fixed sleep — the arena/asset gates take
	// as long as they take (headless swiftshader loads a mesh map slowly).
	await page.waitForFunction(
		'document.getElementById("map-change")?.classList.contains("mc-ready")',
		{ timeout: 90000 },
	).catch(() => {})

	try { await page.screenshot({ path: process.env.HOME + '/unreal/_work/mc-ready.png' }) } catch (e) {}
	const afterReload = await page.evaluate(() => {
		const sim = window.gameClient && window.gameClient.simulator
		const mc = document.getElementById('map-change')
		return {
			mcVisible: !!mc && mc.classList.contains('mc-visible'),
			mcReady: !!mc && mc.classList.contains('mc-ready'),
			mapName: (document.getElementById('mc-map-name') || {}).textContent,
			modeName: (document.getElementById('mc-mode-name') || {}).textContent,
			dropVisible: !!document.getElementById('mc-drop'),
			arenaEntered: !!(sim && sim._arenaEntered),
			deployed: !!(sim && sim.myRawEntity),
			connected: sim && sim._connectionState,
		}
	})
	console.log('AFTER RELOAD', JSON.stringify(afterReload))
	ck('reconnected after rotation', afterReload.connected === 'connected')
	ck('interstitial still covering (no naked menu)', afterReload.mcVisible)
	ck('reached READY state', afterReload.mcReady)
	ck('names the incoming map', !!afterReload.mapName && afterReload.mapName !== '—', afterReload.mapName)
	ck('names the mode', !!afterReload.modeName && afterReload.modeName !== '—', afterReload.modeName)
	ck('did NOT auto-enter the arena', afterReload.arenaEntered === false)
	ck('player NOT deployed while card is up', afterReload.deployed === false)

	// ---- the drop-in click ----
	await page.click('#mc-drop')
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 30000 })
	const afterDrop = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const mc = document.getElementById('map-change')
		return {
			arenaEntered: !!sim._arenaEntered,
			deployed: !!sim.myRawEntity,
			mcHidden: !mc || !mc.classList.contains('mc-visible'),
			pointerLocked: !!document.pointerLockElement,
		}
	})
	console.log('AFTER DROP-IN', JSON.stringify(afterDrop))
	ck('drop-in entered arena', afterDrop.arenaEntered)
	ck('drop-in deployed the player', afterDrop.deployed)
	ck('interstitial dismissed', afterDrop.mcHidden)
	ck('pointer lock acquired from the gesture', afterDrop.pointerLocked)
	ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
} catch (e) {
	console.error('VERIFY ERROR:', e.message)
	fail = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) kill(p)
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
process.exit(fail ? 1 : 0)
