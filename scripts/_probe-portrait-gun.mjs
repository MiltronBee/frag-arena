// Portrait viewmodel-framing probe — "guns appear off screen in vertical mode".
// Root cause: vmCamera.fov is VERTICAL-fixed; portrait collapses the horizontal
// frustum below the authored gun mounts. Fix: FOVMODE_HORIZONTAL_FIXED when
// cssW < cssH (BABYLONRenderer._applyRenderScale).
//
// Verifies BOTH orientations in one run:
//   portrait 390x844  -> gun bounds project on-screen (the fix)
//   landscape 1280x720 -> gun bounds project on-screen (no regression)
// PASS requires both. Also saves screenshots to _work/portrait-gun-{p,l}.png.
//
// Reuses an already-running vite on :8080 if present (shared dev server), else
// boots its own. Boots its own tsx game server on 8078/8079 (waits for free
// ports, 20s poll, 10 min cap). Cleans up ONLY what it started.
import { spawn } from 'child_process'
import { execSync } from 'child_process'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => { try { execSync(`ss -ltn | grep -q ':${p} '`); return true } catch { return false } }

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

// wait for the game-server ports (another agent may hold them)
const t0 = Date.now()
while ((portBusy(8078) || portBusy(8079)) && Date.now() - t0 < 600000) {
	console.log('game ports busy, waiting 20s...')
	await sleep(20000)
}
if (portBusy(8078) || portBusy(8079)) { console.error('ports never freed'); process.exit(1) }

let failed = false
let browser = null
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'grove', BOTS: '0' }, 'server')
	const ownVite = !portBusy(8080)
	if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
	await sleep(ownVite ? 9000 : 7000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})

	async function checkOrientation(w, h, tag) {
		const page = await browser.newPage()
		await page.setViewport({ width: w, height: h, isMobile: w < h, hasTouch: w < h })
		const errors = []
		page.on('pageerror', e => errors.push(e.message))
		await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
		// MENU SAFETY (v1): no entity until the explicit deploy request — connect,
		// deploy programmatically, THEN wait for the entity + viewmodel.
		await page.waitForFunction(
			'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
			{ timeout: 45000 })
		await page.evaluate(() => window.gameClient.simulator.requestDeploy())
		await page.waitForFunction(
			'window.gameClient.simulator.myRawEntity && window.gameClient.simulator.viewmodel && window.gameClient.simulator.viewmodel.ready',
			{ timeout: 60000 })
		// click through splash / force arena entry the way _verify-map-cycle does
		for (let i = 0; i < 12 && await page.$('#splash'); i++) { await page.mouse.click(w / 2, h / 2); await sleep(300) }
		await page.evaluate(() => {
			;['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
			document.body.classList.add('arena-entered')
		})
		await sleep(1500)
		const res = await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const r = sim.renderer
			const vm = sim.viewmodel
			const cam = r.vmCamera
			const engine = r.scene.getEngine()
			// no BABYLON global needed: the camera's own frustum test answers
			// "does the vm camera see the gun" directly.
			cam.getViewMatrix(true); cam.getProjectionMatrix(true) // force fresh matrices
			const meshes = vm.holder.getChildMeshes().filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
			const inFrustum = meshes.filter(m => cam.isInFrustum(m))
			return {
				W: engine.getRenderWidth(), H: engine.getRenderHeight(),
				fovMode: cam.fovMode, total: meshes.length, onScreen: inFrustum.length,
				names: inFrustum.slice(0, 4).map(m => m.name),
			}
		})
		await page.screenshot({ path: `_work/portrait-gun-${tag}.png` })
		const pass = res.total > 0 && res.onScreen > 0 && errors.length === 0
		console.log(JSON.stringify({ tag, ...res, pageErrors: errors, verdict: pass ? 'PASS' : 'FAIL' }, null, 1))
		await page.close()
		return pass
	}

	const portrait = await checkOrientation(390, 844, 'p')
	const landscape = await checkOrientation(1280, 720, 'l')
	failed = !(portrait && landscape)
} catch (e) {
	console.error('PROBE ERROR:', e.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	procs.forEach(p => { try { p.kill('SIGTERM') } catch {} })
	await sleep(1500)
	procs.forEach(p => { try { p.kill('SIGKILL') } catch {} })
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
