// SKYBOX EARTH orientation check. Boots its own server+vite, joins, then parks the
// camera at several vantage points AIMED AT THE EARTH (world -360,-320,820, d=1200)
// and screenshots. Purely visual: we need to see which way up the continents read and
// how the axis is tilted before touching the sphere/texture transform.
//   node scripts/shot-earth.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/earth-shots/' + (process.env.SKY || 'earth')
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.PROBE_VITE_PORT || '8081'
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

let browser = null, reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'visage', BOT_FILL: '0', PORT: '8078' }, 'server')
	reuseVite = await portBusy(PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', PORT, '--strictPort'], {}, 'vite')
	await sleep(8000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome', headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1280,720'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errs = []
	page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
	await page.goto(`http://localhost:${PORT}/${process.env.SKY ? "?sky=" + process.env.SKY : ""}`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 60000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	await sleep(2000)
	await page.evaluate(() => ['entry-overlay', 'splash', 'menu', 'main-menu', 'hud'].forEach(id => {
		const el = document.getElementById(id); if (el) el.style.display = 'none'
	}))

	// report what the scene actually holds, then aim at it
	const info = await page.evaluate(() => {
		const sc = window.gameClient.simulator.renderer.scene
		const e = sc.getMeshByName('earth'), m = sc.getMeshByName('moon')
		const d = o => o ? { pos: [o.position.x, o.position.y, o.position.z], rot: [o.rotation.x, o.rotation.y, o.rotation.z], scaling: [o.scaling.x, o.scaling.y, o.scaling.z] } : null
		const t = e && e.material && e.material.diffuseTexture
		return { earth: d(e), moon: d(m), diffuse: t ? { uScale: t.uScale, vScale: t.vScale, uOffset: t.uOffset, vOffset: t.vOffset, wAng: t.wAng, invertY: t._invertY } : null }
	})
	console.log('SCENE', JSON.stringify(info, null, 2))

	// camera vantage points that frame the Earth
	const E = { x: -360, y: -320, z: 820 }
	const views = [
		{ name: 'earth-center', cam: { x: 0, y: 20, z: 0 }, aim: E },
		{ name: 'earth-close', cam: { x: -200, y: 60, z: 200 }, aim: E },
		{ name: 'earth-limb', cam: { x: 0, y: 20, z: 0 }, aim: { x: E.x, y: E.y + 380, z: E.z } },
		{ name: 'moon', cam: { x: 0, y: 20, z: 0 }, aim: { x: 300, y: 700, z: -250 } },
	]
	for (const v of views) {
		await page.evaluate((v) => {
			const s = window.gameClient.simulator
			const cam = s.renderer.camera
			const dx = v.aim.x - v.cam.x, dy = v.aim.y - v.cam.y, dz = v.aim.z - v.cam.z
			const yaw = Math.atan2(dx, dz)
			const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) // +x = look down
			cam.position.set(v.cam.x, v.cam.y, v.cam.z)
			cam.rotation.set(pitch, yaw, 0)
			// stop the sim from rebasing the camera onto the entity next frame
			s._camFreeze = true
			const e = s.myRawEntity
			if (e) { e.x = v.cam.x; e.y = v.cam.y - 1.6; e.z = v.cam.z; e.velX = e.velY = e.velZ = 0 }
		}, v)
		for (let i = 0; i < 30; i++) {
			await page.evaluate((v) => {
				const s = window.gameClient.simulator, cam = s.renderer.camera
				const dx = v.aim.x - v.cam.x, dy = v.aim.y - v.cam.y, dz = v.aim.z - v.cam.z
				cam.position.set(v.cam.x, v.cam.y, v.cam.z)
				cam.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0)
				try { s.renderer.scene.render() } catch (e) {}
			}, v)
			await sleep(16)
		}
		await page.screenshot({ path: `${OUT}/${v.name}.png` })
		console.log('shot', v.name)
	}
	console.log('pageErrors', errs.slice(0, 3))
	console.log('OUT', OUT)
} catch (err) {
	console.error('SHOT ERROR:', err.message)
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(0)
