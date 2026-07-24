// SCENE-BRIGHTNESS probe. Boots its OWN server per map + vite on :8080, joins,
// deploys, and screenshots the player's spawn viewpoint after the map + bake
// settle, then prints mean luminance + p5/p50/p95 luma percentiles decoded from
// the PNG pixels (pngjs). Used to MEASURE the darkness-retune in
// client/graphics/BABYLONRenderer.js instead of eyeballing it.
//
//   TAG=before node scripts/_probe-brightness.mjs      # baseline
//   TAG=after  node scripts/_probe-brightness.mjs      # post-retune
//   MAPS=visage TAG=mobile-sim node scripts/_probe-brightness.mjs   # single map
//
// All 6 rotation maps are MESH maps (no box arena is selectable via MAP), so we
// measure two contrasting mesh maps: visage (open CTF, void) + dm_gantry162
// (enclosed indoor Deck16, the darkest-complaint case). The grade retune is set
// on scene.imageProcessingConfiguration BEFORE map load, so it applies IDENTICALLY
// to the box-arena (ArenaDressing) path too.
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import puppeteer from 'puppeteer-core'
import { PNG } from 'pngjs'

const OUT = process.env.HOME + '/unreal/_work/brightness'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const TAG = process.env.TAG || 'run'
const MAPS = (process.env.MAPS || 'visage,dm_gantry162').split(',').map(s => s.trim()).filter(Boolean)
const BOT_FILL = process.env.BOT_FILL || '2'

const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}
async function killServers() {
	// free the game ports (8078 mapinfo, 8079 ws) and WAIT until BOTH are actually
	// free before returning — the next server boot races the previous socket's close,
	// and a crashed boot can leave 8079 held while 8078 is free.
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
	for (let i = 0; i < 40; i++) {
		await sleep(300)
		if (!(await portBusy('8078')) && !(await portBusy('8079'))) return
	}
}

// Rec.709 luma stats from a PNG buffer via a 256-bin histogram (exact for 8-bit).
function lumaStats(pngBuf) {
	const png = PNG.sync.read(pngBuf)
	const { data, width, height } = png
	const hist = new Float64Array(256)
	let n = 0
	for (let i = 0; i < data.length; i += 4) {
		const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
		hist[Math.min(255, Math.round(y))]++
		n++
	}
	let sum = 0
	for (let v = 0; v < 256; v++) sum += v * hist[v]
	const mean = sum / n
	const pct = q => {
		const target = q * n
		let acc = 0
		for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v }
		return 255
	}
	return {
		width, height, mean: +mean.toFixed(2),
		p5: pct(0.05), p50: pct(0.50), p95: pct(0.95),
		blownFrac: +((hist[255] / n) * 100).toFixed(3), // % of pixels at 255 (blowout)
	}
}

let failed = false
let browser = null
let reuseVite = false
const results = []
try {
	reuseVite = await portBusy(VITE_PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})

	let currentServer = null
	for (const MAP of MAPS) {
		// explicitly kill the PREVIOUS map's server proc (fuser alone raced the socket
		// close and the next boot connected to the leftover), then wait for ports free.
		if (currentServer) { try { currentServer.kill('SIGKILL') } catch {} }
		await killServers()
		currentServer = boot('npx', ['tsx', 'server/serverMain.js'], { MAP, BOT_FILL }, `srv:${MAP}`)
		await sleep(8000)

		const page = await browser.newPage()
		await page.setViewport({ width: 1280, height: 720 })
		const errors = []
		const bakeLogs = []
		page.on('pageerror', e => errors.push(e.message))
		page.on('console', m => { const t = m.text(); if (/\[map\].*(bake|vertex-light)/i.test(t)) bakeLogs.push(t) })
		await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
		await page.waitForFunction(
			'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
			{ timeout: 45000 })
		await page.evaluate(() => window.gameClient.simulator.requestDeploy())
		await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
		await sleep(9000) // map GLB import + vertex-light bake + textures settle

		// clear the boot/entry overlays so they don't cover the spawn view.
		await page.evaluate(() => {
			;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
			document.body.classList.add('arena-entered')
		})
		await sleep(500)

		// FREEZE the scene: the render loop is a manual rAF in clientMain.js that calls
		// gameClient.update() (which advances the sim AND re-drives the camera from the
		// player every frame). engine.stopRenderLoop() does NOT touch it, so earlier the
		// player kept falling to spawn + the camera kept swinging and the three grade shots
		// caught different CONTENT (before read brighter than after — impossible for the
		// grade alone). No-op'ing update() halts everything; our manual scene.render() is
		// then the only thing that draws, so the A/B/C shots are the SAME frozen frame.
		// Pin the camera to a fixed pose (walkable-AABB centre, looking down-and-across the
		// floor; world = (nx*s, nz*s, -ny*s), native Z-up -> world Y-up).
		await page.evaluate(() => {
			window.gameClient.update = () => {}
			const r = window.gameClient.simulator.renderer
			// also freeze the light-corona + teleporter-shimmer wobble: they animate via
			// scene.registerBeforeRender (performance.now driven), which still fires on each
			// manual scene.render(), so a strobe corona flaring between two grade shots was
			// swinging gantry's mean/p95 (a false +120%). Clearing before-render freezes
			// them at a fixed phase — identical across all grade shots, so the delta is pure grade.
			r.scene.onBeforeRenderObservable.clear()
			const w = r.map.walkable, sc = r.map.scale || 1
			const cx = (w.minX + w.maxX) / 2, cy = (w.minY + w.maxY) / 2, cz = (w.minZ + w.maxZ) / 2
			const cam = r.camera
			// eye level, near-horizontal look across the arena — the representative
			// gameplay view (the top-down-at-floor pose was mostly black void, which
			// dilutes the grade delta since black stays black under any grade).
			cam.position.set(cx * sc, cz * sc + 1.6, -cy * sc)
			cam.rotation.x = 0.05; cam.rotation.y = 0.9; cam.rotation.z = 0
		})
		await sleep(200)

		// SAME-FROZEN-FRAME grade sweep: flip the scene's imageProcessingConfiguration
		// LIVE between grades and screenshot each on the identical frozen frame.
		// contrast/exposure/vignetteWeight are live uniforms — this is EXACTLY what the
		// constructor sets — so it isolates the grade with zero viewpoint variance.
		// `before` = pre-retune baseline; `after`/`mobile-sim` = the shipped numbers; the
		// c*/m* rows are candidates measured to pick numbers that land in the +20-35% band.
		const GRADES = process.env.SWEEP ? {
			before: { c: 1.35, e: 1.05, v: 1.6 },
			'c-a': { c: 1.25, e: 1.20, v: 1.0 },
			'c-b': { c: 1.20, e: 1.28, v: 0.95 },
			'c-c': { c: 1.15, e: 1.32, v: 0.90 },
			'c-d': { c: 1.15, e: 1.38, v: 0.85 },
			'm-c': { c: 1.15, e: 1.47, v: 0.65 },
			'm-d': { c: 1.15, e: 1.52, v: 0.60 },
		} : {
			before: { c: 1.35, e: 1.05, v: 1.6 },       // pre-retune (STANDARD tonemap baseline)
			after: { c: 1.25, e: 1.20, v: 1.0 },        // desktop retune (shipped) — measured +~22-25%
			'mobile-sim': { c: 1.25, e: 1.35, v: 0.7 }, // touch branch (shipped) — exposure +0.15, lighter vignette
		}
		// NATIVE mode: measure the grade the RENDERER ITSELF applied (no in-page override),
		// to verify the isTouch branch routes to the right numbers. Used with a temporary
		// `const isTouch = true` hack in BABYLONRenderer.js to prove the mobile branch.
		if (process.env.NATIVE) {
			const shot = await page.evaluate(() => {
				const r = window.gameClient.simulator.renderer
				const ip = r.scene.imageProcessingConfiguration
				r.scene.render()
				const canvas = document.getElementById('main-canvas')
				const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
				const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight
				const px = new Uint8Array(W * H * 4)
				gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
				const hist = new Array(256).fill(0), n = W * H
				for (let i = 0; i < px.length; i += 4) { const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; hist[Math.min(255, Math.round(y))]++ }
				let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v]
				const pct = q => { const t = q * n; let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= t) return v } return 255 }
				const c2 = document.createElement('canvas'); c2.width = W; c2.height = H
				const ctx = c2.getContext('2d'); const img = ctx.createImageData(W, H)
				for (let row = 0; row < H; row++) { const s = row * W * 4, dq = (H - 1 - row) * W * 4; img.data.set(px.subarray(s, s + W * 4), dq) }
				ctx.putImageData(img, 0, 0)
				return {
					ip: { contrast: ip.contrast, exposure: ip.exposure, vignetteWeight: ip.vignetteWeight },
					stats: { width: W, height: H, mean: +(sum / n).toFixed(2), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), blownFrac: +((hist[255] / n) * 100).toFixed(3) },
					dataURL: c2.toDataURL('image/png'),
				}
			})
			const tag = process.env.NATIVE_TAG || 'native'
			const file = path.join(OUT, `${MAP}-${tag}.png`)
			fs.writeFileSync(file, Buffer.from(shot.dataURL.split(',')[1], 'base64'))
			results.push({ map: MAP, grade: `native(${tag})`, rendererIp: shot.ip, screenshot: file, ...shot.stats, bake: bakeLogs.slice(0, 1), pageErrors: errors.slice(0, 2) })
			await page.close()
			continue
		}

		for (const [grade, g] of Object.entries(GRADES)) {
			// Set the grade, render, and read the WebGL BACKBUFFER directly with
			// gl.readPixels IN THE SAME SYNCHRONOUS TICK. puppeteer's compositor screenshot
			// caught stale/half-cleared frames once the game's rAF loop was noop'd (Babylon
			// doesn't preserveDrawingBuffer), which is what produced the erratic bright/dark
			// jumps. readPixels reads exactly what we just drew. Stats + a PNG dataURL are
			// built in-page from that pixel array (via a 2D canvas), so the saved image and
			// the numbers come from the identical buffer.
			const shot = await page.evaluate((g) => {
				const r = window.gameClient.simulator.renderer
				const ip = r.scene.imageProcessingConfiguration
				ip.contrast = g.c; ip.exposure = g.e; ip.vignetteWeight = g.v
				r.scene.render()
				const canvas = document.getElementById('main-canvas')
				const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
				const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight
				const px = new Uint8Array(W * H * 4)
				gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
				// histogram (Rec.709 luma) over the raw buffer
				const hist = new Array(256).fill(0)
				const n = W * H
				for (let i = 0; i < px.length; i += 4) {
					const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
					hist[Math.min(255, Math.round(y))]++
				}
				let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v]
				const pct = q => { const t = q * n; let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= t) return v } return 255 }
				const stats = { width: W, height: H, mean: +(sum / n).toFixed(2), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), blownFrac: +((hist[255] / n) * 100).toFixed(3) }
				// build a PNG dataURL from the same pixels (flip vertically — readPixels is bottom-up)
				const c2 = document.createElement('canvas'); c2.width = W; c2.height = H
				const ctx = c2.getContext('2d'); const img = ctx.createImageData(W, H)
				for (let row = 0; row < H; row++) {
					const src = row * W * 4, dst = (H - 1 - row) * W * 4
					img.data.set(px.subarray(src, src + W * 4), dst)
				}
				ctx.putImageData(img, 0, 0)
				return { stats, dataURL: c2.toDataURL('image/png') }
			}, g)
			const file = path.join(OUT, `${MAP}-${grade}.png`)
			fs.writeFileSync(file, Buffer.from(shot.dataURL.split(',')[1], 'base64'))
			results.push({ map: MAP, grade, screenshot: file, ...shot.stats, bake: bakeLogs.slice(0, 1), pageErrors: errors.slice(0, 2) })
		}
		await page.close()
	}

	console.log(JSON.stringify(results, null, 2))
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
