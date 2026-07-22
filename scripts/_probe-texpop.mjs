// ============================================================================
// _probe-texpop.mjs — A/B verification of the mesh-map texture-pop upgrades
// (hex-grid stochastic tiling + detail grunge, client/graphics/mapMaterialPop.js).
//
//   node scripts/_probe-texpop.mjs
//
// Boots its OWN server (MAP=grove, spawn pinned) + vite on :8080 — but first
// WAITS for 8078/8079/8080 to be free (other agents may own them; poll 20s up
// to 10 min, never kill anything we didn't start). Then loads the client twice
// (?flat=1 baseline vs default pop), shoots the SAME two vantages each time:
//   far  = spawn, pitched down over the floor expanse
//   near = nearest wall (deterministic ray sweep), 1.5 m close-up
// -> _work/texpop/{flat,pop}-{far,near}.png
// Also asserts: zero console/page errors, zero 'Unable to compile', plugin
// actually attached in pop mode, and reports avg rAF delta (~5 s) on vs off.
//
// Anti-throttle Chrome flags per the late-joiner lesson; one browser per run.
// ============================================================================
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const OUTDIR = '_work/texpop'
const PORTS = [8078, 8079] // 8080 = shared vite, REUSED when already up (never a blocker)

// --- wait for free ports (other agents may own them) -------------------------
function portFree(port) {
	return new Promise(resolve => {
		const srv = net.createServer()
		srv.once('error', () => resolve(false))
		srv.once('listening', () => srv.close(() => resolve(true)))
		srv.listen(port, '0.0.0.0')
	})
}
async function waitForPorts() {
	const deadline = Date.now() + 10 * 60 * 1000
	for (;;) {
		const free = await Promise.all(PORTS.map(portFree))
		if (free.every(Boolean)) return
		const busy = PORTS.filter((_, i) => !free[i])
		if (Date.now() > deadline) throw new Error(`ports still busy after 10min: ${busy}`)
		console.log(`[texpop] ports busy (${busy.join(',')}) — another agent owns them, retrying in 20s`)
		await sleep(20000)
	}
}

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	p.stdout.on('data', d => { const s = d.toString(); if (/error|listening|Local:/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

// one full client session: join, frame the two vantages, screenshot, measure
async function runSession(label, urlSuffix) {
	const browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio',
			'--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding'],
	})
	try {
		const page = await browser.newPage()
		await page.setViewport({ width: 1280, height: 720 })
		const errors = [], compileFails = []
		page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))
		page.on('console', msg => {
			const text = msg.text()
			if (/Unable to compile/i.test(text)) compileFails.push(text.slice(0, 300))
			else if (msg.type() === 'error' && !/favicon|net::ERR_/i.test(text)) errors.push(text.slice(0, 200))
		})
		const consoleTail = []
		page.on('console', msg => { consoleTail.push(msg.text().slice(0, 160)); if (consoleTail.length > 25) consoleTail.shift() })
		await page.goto(`http://localhost:8080/${urlSuffix}`, { waitUntil: 'domcontentloaded' })
		try {
			await page.waitForFunction(
				'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
				{ timeout: 45000 })
			await page.evaluate(() => window.gameClient.simulator.requestDeploy())
			await page.waitForFunction('window.gameClient.simulator.myRawEntity',
				{ timeout: 60000 })
		} catch (err) {
			console.error(`[texpop:${label}] join timeout; page console tail:\n  ` + consoleTail.join('\n  '))
			throw err
		}

		// hide chrome + wait for the map visual, light bake and (pop mode) the
		// materials to actually carry the upgrades
		await page.evaluate(() => {
			['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => {
				const el = document.getElementById(id); if (el) el.remove()
			})
			document.body.classList.add('arena-entered')
		})
		let state = null
		for (let i = 0; i < 40; i++) { // up to 20s for map + textures
			state = await page.evaluate(() => {
				const sim = window.gameClient.simulator
				const scene = sim.renderer && sim.renderer.scene
				if (!scene) return { ready: false }
				const mapMats = scene.materials.filter(m => m.getClassName() === 'StandardMaterial'
					&& m.diffuseTexture && (m.diffuseTexture.url || '').includes('/assets/maps/'))
				const hexed = mapMats.filter(m => m.pluginManager && m.pluginManager.getPlugin('HexTilePop'))
				const detailed = mapMats.filter(m => m.detailMap && m.detailMap.isEnabled && m.detailMap.texture)
				const detailReady = detailed.length === 0 || detailed.every(m => m.detailMap.texture.isReady())
				const texReady = mapMats.length > 0 && mapMats.every(m => m.diffuseTexture.isReady())
				return {
					ready: mapMats.length > 0 && texReady && detailReady && !!sim.renderer._vertexlightApplied,
					mapMats: mapMats.length, hexed: hexed.length, detailed: detailed.length,
					map: sim.map && sim.map.id,
				}
			})
			if (state.ready) break
			await sleep(500)
		}
		await sleep(1500) // settle: shadow re-bake + any plugin recompiles

		// ---- vantage FAR: spawn, pitched down across the floor expanse --------
		await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const e = sim.myRawEntity
			const cam = sim.renderer.camera
			e.velX = 0; e.velY = 0; e.velZ = 0
			cam.rotation.x = 0.34
			cam.rotation.y = Math.atan2(0 - e.x, 0 - e.z) // face map centre
		})
		await sleep(400)
		await page.screenshot({ path: `${OUTDIR}/${label}-far.png` })

		// ---- vantage NEAR: deterministic ray sweep to the nearest wall --------
		const near = await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const scene = sim.renderer.scene
			const cam = sim.renderer.camera
			const e = sim.myRawEntity
			const B = window.BABYLON
			const pred = m => m.checkCollisions && m.name !== 'ground' && m.name !== 'sky'
			let best = null
			for (let k = 0; k < 24; k++) {
				const yaw = (k / 24) * Math.PI * 2
				const dir = new B.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
				const hit = scene.pickWithRay(new B.Ray(cam.globalPosition.clone(), dir, 40), pred)
				if (hit && hit.hit && hit.distance > 1.2) {
					const n = hit.getNormal(true)
					if (n && Math.abs(n.y) < 0.4) { // vertical-ish surface = wall
						if (!best || hit.distance < best.d) best = { d: hit.distance, x: hit.pickedPoint.x, z: hit.pickedPoint.z, yaw }
					}
				}
			}
			if (best) {
				e.x = best.x - Math.sin(best.yaw) * 1.5
				e.z = best.z - Math.cos(best.yaw) * 1.5
				e.velX = 0; e.velY = 0; e.velZ = 0
				cam.rotation.x = 0.02
				cam.rotation.y = best.yaw
			}
			return best ? { wallDist: +best.d.toFixed(2) } : { wallDist: null }
		})
		await sleep(400)
		await page.screenshot({ path: `${OUTDIR}/${label}-near.png` })

		// ---- coarse perf: average rAF delta over ~5 s -------------------------
		const avgFrameMs = await page.evaluate(() => new Promise(resolve => {
			let n = 0, sum = 0, last = 0
			function tick(t) {
				if (last) { sum += t - last; n++ }
				last = t
				if (n >= 300) resolve(+(sum / n).toFixed(3))
				else requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		}))

		return { label, ...state, ...near, avgFrameMs, errors, compileFails }
	} finally {
		await browser.close().catch(() => {})
	}
}

let failed = false
try {
	mkdirSync(OUTDIR, { recursive: true })
	// boot with race-retry: another agent can grab the ports between our free
	// check and our listen — if we lost the race, release OUR procs and requeue.
	for (let attempt = 1; ; attempt++) {
		await waitForPorts()
		boot('npx', ['tsx', 'server/serverMain.js'],
			{ MAP: 'grove', BOTS: '0', DEV_SPAWN_AT: '-17.3,13.9,-30.2' }, 'server')
		const viteBusy = !(await portFree(8080))
		if (viteBusy) console.log('[texpop] reusing shared vite on :8080')
		else boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
		await sleep(viteBusy ? 6000 : 8000) // server mesh load (+ vite boot when ours)
		const holds = await Promise.all(PORTS.map(p => portFree(p).then(f => !f)))
		if (holds.every(Boolean)) break
		for (const p of procs.splice(0)) { try { process.kill(-p.pid) } catch { try { p.kill('SIGKILL') } catch {} } }
		if (attempt >= 5) throw new Error('could not claim dev ports after 5 attempts')
		console.log(`[texpop] lost a port race (attempt ${attempt}) — backing off 20s`)
		await sleep(20000)
	}

	const flat = await runSession('flat', '?flat=1')
	const pop = await runSession('pop', '')

	const perfDeltaPct = +(((pop.avgFrameMs - flat.avgFrameMs) / flat.avgFrameMs) * 100).toFixed(1)
	const ok =
		flat.errors.length === 0 && pop.errors.length === 0
		&& flat.compileFails.length === 0 && pop.compileFails.length === 0
		&& flat.hexed === 0 && flat.detailed === 0        // ?flat=1 really is the baseline
		&& pop.hexed > 0 && pop.detailed > 0              // upgrades actually attached
		&& pop.wallDist !== null && flat.wallDist !== null
	console.log(JSON.stringify({
		flat, pop,
		perf: { flatAvgMs: flat.avgFrameMs, popAvgMs: pop.avgFrameMs, deltaPct: perfDeltaPct, over10pct: perfDeltaPct > 10 },
		screenshots: ['flat-far', 'flat-near', 'pop-far', 'pop-near'].map(n => `${OUTDIR}/${n}.png`),
		verdict: ok ? (perfDeltaPct > 10 ? 'PASS (perf flag: tiling >10%)' : 'PASS') : 'FAIL',
	}, null, 2))
	failed = !ok
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	for (const p of procs) { try { process.kill(-p.pid) } catch { try { p.kill('SIGKILL') } catch {} } }
	await sleep(800)
	// sweep only OUR spawned trees' leftovers on the dev ports — we verified the
	// ports were free before booting, so anything on them now is ours.
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 8080/tcp 2>/dev/null; true'])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
