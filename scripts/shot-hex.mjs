// DM-Hex][ (UT DM-Curse][) first-boot check: boots its own server on the new map,
// captures the server's mover/pickup log lines, joins, and screenshots the spawn view
// plus both lift shafts. Verifies the map is playable, not just that it validates.
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/hex-shots/' + (process.env.MAP || 'dm_hex2')
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.PROBE_VITE_PORT || '8081'
const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})
const procs = []
const srvLog = []
function boot(cmd, args, env, tag, sink) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (sink) sink.push(s); if (/error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => { const s = d.toString(); if (sink) sink.push(s); process.stderr.write(`[${tag}!] ${s}`) })
	procs.push(p)
	return p
}

let browser = null, reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'dm_hex2', BOT_FILL: '3' }, 'server', srvLog)
	reuseVite = await portBusy(PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', PORT, '--strictPort'], {}, 'vite')
	await sleep(9000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome', headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1280,720'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errs = []
	page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 60000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	await sleep(3000)

	const state = await page.evaluate(() => {
		const s = window.gameClient.simulator, e = s.myRawEntity
		return {
			spawn: { x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2) },
			grounded: e.grounded,
			movers: s.movers ? [...s.movers.values()].map(m => ({ x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: +m.z.toFixed(2), w: +m.width.toFixed(2), d: +m.depth.toFixed(2), state: m.state })) : [],
			pickups: s._pickups ? s._pickups.size : null,
			mapName: s._mapName || null,
		}
	})
	console.log('CLIENT STATE', JSON.stringify(state, null, 1))

	await page.evaluate(() => ['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => {
		const el = document.getElementById(id); if (el) el.style.display = 'none'
	}))

	// scale 0.65: native lift centres (17.069,-18.288) and (-8.534,-35.052) -> world
	const views = [
		{ name: 'hex-spawn', natural: true },
		{ name: 'hex-lift1', x: 11.1, y: -1.0, z: -11.9, yaw: 0, pitch: 0.1 },
		{ name: 'hex-lift2', x: -5.5, y: 2.5, z: -22.8, yaw: Math.PI / 2, pitch: 0.1 },
		{ name: 'hex-aerial', x: 0, y: 22, z: -14, yaw: 0.6, pitch: -0.8 },
		{ name: 'hex-mega', x: -20.3, y: 1.2, z: -12.1, yaw: -Math.PI / 2, pitch: 0 },
	]
	for (const v of views) {
		if (!v.natural) {
			await page.evaluate((v) => {
				const s = window.gameClient.simulator, e = s.myRawEntity, cam = s.renderer.camera
				e.x = v.x; e.y = v.y; e.z = v.z; e.velX = e.velY = e.velZ = 0
				cam.position.set(v.x, v.y + 1.6, v.z)
				cam.rotation.set(v.pitch, v.yaw, 0)
			}, v)
		}
		for (let i = 0; i < 30; i++) {
			await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} })
			await sleep(16)
		}
		await page.screenshot({ path: `${OUT}/${v.name}.png` })
		console.log('shot', v.name)
	}
	console.log('pageErrors', errs.slice(0, 3))
	const log = srvLog.join('')
	console.log('--- server lines of interest ---')
	for (const line of log.split('\n')) {
		if (/mover|lift|map|spawn|pickup|teleport/i.test(line)) console.log('  ' + line.trim())
	}
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
