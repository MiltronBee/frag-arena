// ============================================================================
// _probe-variants.mjs — A/B verification of per-cluster texture VARIANTS
// (client/graphics/textureVariants.js) on the mesh-map floor expanse.
//
//   node scripts/_probe-variants.mjs
//
// Boots its OWN server (MAP=grove, spawn pinned) + vite on :8080 — but first WAITS
// for 8078/8079/8080 to be free (other agents may own them; poll 20s up to 15 min,
// REUSE a vite already listening on 8080, never kill foreign processes). Loads the
// client twice, shooting the big floor expanse each time:
//   variants OFF (?variants=0)  vs  variants ON (default)
// -> _work/variants/{off,on}-floor.png  (+ a top-down orbit each)
// Asserts: zero page/console errors both runs; 0 clusters when off; >0 clusters +
// >0 split materials when on; added draw calls within the 40-budget. Reports the
// FPS (rAF) delta and the draw-call delta.
//
// Anti-throttle Chrome flags (late-joiner lesson); one browser per session.
// ============================================================================
import { spawn, execSync } from 'child_process'
import { mkdirSync } from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const OUTDIR = '_work/variants'
const OUR_PORTS = [8078, 8079]   // server ports we must OWN
const VITE_PORT = 8080           // reuse a foreign vite here if one is already up

function portFree(port) {
	return new Promise(resolve => {
		const srv = net.createServer()
		srv.once('error', () => resolve(false))
		srv.once('listening', () => srv.close(() => resolve(true)))
		srv.listen(port, '0.0.0.0')
	})
}
async function waitForServerPorts() {
	const deadline = Date.now() + 15 * 60 * 1000
	for (;;) {
		const free = await Promise.all(OUR_PORTS.map(portFree))
		if (free.every(Boolean)) return
		const busy = OUR_PORTS.filter((_, i) => !free[i])
		if (Date.now() > deadline) throw new Error(`server ports still busy after 15min: ${busy}`)
		console.log(`[variants] server ports busy (${busy.join(',')}) — another agent owns them, retry 20s`)
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
		const errors = []
		page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))
		page.on('console', msg => {
			const text = msg.text()
			if (msg.type() === 'error' && !/favicon|net::ERR_/i.test(text)) errors.push(text.slice(0, 200))
		})
		const consoleTail = []
		page.on('console', msg => { consoleTail.push(msg.text().slice(0, 160)); if (consoleTail.length > 30) consoleTail.shift() })
		await page.goto(`http://localhost:${VITE_PORT}/${urlSuffix}`, { waitUntil: 'domcontentloaded' })
		try {
			await page.waitForFunction(
				'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
				{ timeout: 45000 })
			await page.evaluate(() => window.gameClient.simulator.requestDeploy())
			await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
		} catch (err) {
			console.error(`[variants:${label}] join timeout; console tail:\n  ` + consoleTail.join('\n  '))
			throw err
		}

		await page.evaluate(() => {
			['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => {
				const el = document.getElementById(id); if (el) el.remove()
			})
			document.body.classList.add('arena-entered')
		})

		// wait for map visual + vertex-light bake + (on) the variant split to run
		let state = null
		for (let i = 0; i < 50; i++) { // up to 25s
			state = await page.evaluate(() => {
				const sim = window.gameClient.simulator
				const scene = sim.renderer && sim.renderer.scene
				if (!scene) return { ready: false }
				const mapMats = scene.materials.filter(m => m.getClassName() === 'StandardMaterial'
					&& m.diffuseTexture && (m.diffuseTexture.url || '').includes('/assets/maps/'))
				const texReady = mapMats.length > 0 && mapMats.every(m => m.diffuseTexture.isReady())
				// split meshes = map meshes that now carry a MultiMaterial + >1 subMesh
				const meshes = scene.meshes.filter(m => m.material && m.material.getClassName
					&& m.material.getClassName() === 'MultiMaterial')
				const splitMeshes = meshes.filter(m => m.subMeshes && m.subMeshes.length > 1)
				const cloneMats = scene.materials.filter(m => /\.v\d+$/.test(m.name || ''))
				return {
					ready: mapMats.length > 0 && texReady && !!sim.renderer._vertexlightApplied,
					mapMats: mapMats.length,
					splitMeshes: splitMeshes.length,
					subMeshTotal: splitMeshes.reduce((a, m) => a + m.subMeshes.length, 0),
					cloneMats: cloneMats.length,
					variantStats: scene._texVariantsStats || null,
					map: sim.map && sim.map.id,
				}
			})
			if (state.ready) break
			await sleep(500)
		}
		await sleep(1500) // settle

		// draw-call count (active submeshes rendered this frame)
		const drawCalls = await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const inst = sim.renderer.scene.getEngine().getGlInfo ? null : null
			// count active render submeshes on the map meshes
			const scene = sim.renderer.scene
			let dc = 0
			for (const m of scene.meshes) {
				if (!m.isEnabled() || !m.subMeshes) continue
				if (m.material && (m.material.name || '').includes('__variants')) dc += m.subMeshes.length
			}
			return dc
		})

		// ---- vantage: spawn, pitched down across the floor expanse -------------
		await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const e = sim.myRawEntity
			const cam = sim.renderer.camera
			e.velX = 0; e.velY = 0; e.velZ = 0
			cam.rotation.x = 0.42
			cam.rotation.y = Math.atan2(0 - e.x, 0 - e.z) // face map centre
		})
		await sleep(400)
		await page.screenshot({ path: `${OUTDIR}/${label}-floor.png` })

		// ---- vantage: lifted top-down orbit to see the cluster patchwork -------
		await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const e = sim.myRawEntity
			const cam = sim.renderer.camera
			e.y += 8
			cam.rotation.x = 1.15 // look steeply down
			cam.rotation.y = 0.6
			e.velX = 0; e.velY = 0; e.velZ = 0
		})
		await sleep(400)
		await page.screenshot({ path: `${OUTDIR}/${label}-topdown.png` })

		// ---- coarse perf: avg rAF delta over ~5 s ------------------------------
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

		return { label, ...state, drawCalls, avgFrameMs, errors }
	} finally {
		await browser.close().catch(() => {})
	}
}

let failed = false
try {
	mkdirSync(OUTDIR, { recursive: true })
	// server ports must be OURS; vite on 8080 is REUSED if a foreign one is up.
	for (let attempt = 1; ; attempt++) {
		await waitForServerPorts()
		boot('npx', ['tsx', 'server/serverMain.js'],
			{ MAP: 'grove', BOTS: '0', DEV_SPAWN_AT: '-17.3,13.9,-30.2' }, 'server')
		const viteUp = !(await portFree(VITE_PORT))
		if (viteUp) console.log(`[variants] reusing vite already listening on :${VITE_PORT}`)
		else boot('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {}, 'vite')
		await sleep(9000)
		const serverUp = await Promise.all(OUR_PORTS.map(p => portFree(p).then(f => !f)))
		if (serverUp.every(Boolean)) break
		for (const p of procs.splice(0)) { try { process.kill(-p.pid) } catch { try { p.kill('SIGKILL') } catch {} } }
		if (attempt >= 5) throw new Error('could not claim server ports after 5 attempts')
		console.log(`[variants] lost a port race (attempt ${attempt}) — backing off 20s`)
		await sleep(20000)
	}

	const off = await runSession('off', '?variants=0')
	const on = await runSession('on', '')

	const perfDeltaPct = +(((on.avgFrameMs - off.avgFrameMs) / off.avgFrameMs) * 100).toFixed(1)
	const ok =
		off.errors.length === 0 && on.errors.length === 0
		&& off.splitMeshes === 0 && off.cloneMats === 0          // ?variants=0 really is baseline
		&& on.splitMeshes > 0 && on.cloneMats > 0                // split actually happened
		&& !!(on.variantStats) && on.variantStats.addedDrawCalls <= 40  // within budget
	console.log(JSON.stringify({
		off, on,
		drawCallDelta: on.drawCalls - off.drawCalls,
		perf: { offAvgMs: off.avgFrameMs, onAvgMs: on.avgFrameMs, deltaPct: perfDeltaPct },
		screenshots: ['off-floor', 'off-topdown', 'on-floor', 'on-topdown'].map(n => `${OUTDIR}/${n}.png`),
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	for (const p of procs) { try { process.kill(-p.pid) } catch { try { p.kill('SIGKILL') } catch {} } }
	await sleep(800)
	// sweep only OUR server ports (we verified they were free before booting); leave
	// any foreign vite on 8080 alone.
	try { execSync('fuser -k 8078/tcp 8079/tcp 2>/dev/null; true') } catch {}
	await sleep(500)
}
process.exit(failed ? 1 : 0)
