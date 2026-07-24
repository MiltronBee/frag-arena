// FFA NEUTRAL-UNIFORM probe. Boots its OWN server (MAP=dm_somnus — the rotation's
// FFA map — BOT_FILL=4) + vite on :8080, joins, and asserts the FFA uniform law:
// NO red/blue in FFA — every remote CharacterModel goes NEUTRAL (matching black
// uniform + gray nametag), i.e.
//   - model._neutral === true (the factory routed teamId -> setNeutral)
//   - the suit material's albedoTexture url carries 'uniform_black'
//   - no suit material still points at uniform_red / uniform_blue
// plus one close-up screenshot for the eyeball check and zero page errors.
// (TDM red/blue regression is _probe-uniforms.mjs — run both.)
//
//   node scripts/_probe-ffa-uniforms.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/uniforms'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
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

let failed = false
let browser = null
let reuseVite = false
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOT_FILL: '4' }, 'server')
	reuseVite = await portBusy(VITE_PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	await sleep(7000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
		{ timeout: 45000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	await sleep(8000) // bots spawn + hero GLB imports + black uniform texture loads

	// wait until every remote model has its meshes in (GLB import is async)
	await page.waitForFunction(`(() => {
		const models = [...window.gameClient.simulator.characterModels.values()]
		return models.length >= 2 && models.every(m => m.meshes)
	})()`, { timeout: 60000 })

	const audit = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const out = { mode: sim._matchState ? (sim._matchState.mode | 0) : null, isFFA: sim.isFFA(), models: [] }
		sim.characterModels.forEach((m, nid) => {
			const suits = []
			if (m.meshes) m.meshes.forEach(mesh => {
				const mat = mesh.material
				if (mat && /superhero/i.test(mat.name || '') && mat.albedoTexture) suits.push(mat.albedoTexture.url || mat.albedoTexture.name || '')
			})
			out.models.push({
				nid, neutral: m._neutral === true,
				nametag: m._nameTag ? m._nameTag.style.color : null,
				suitTex: [...new Set(suits)],
			})
		})
		return out
	})

	// close-up screenshot of the nearest bot (freecam hack from _probe-uniforms)
	const bot = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		let best = null, bd = Infinity
		window.gameClient.client.entities.forEach(e => {
			if (e.hitpoints === undefined || e.teamId === undefined || e.isAlive === false) return
			if (e.nid === sim.myRawId || e.nid === sim.mySmoothId) return
			const d = Math.hypot(e.x - sim.myRawEntity.x, e.z - sim.myRawEntity.z)
			if (d < bd) { bd = d; best = { x: e.x, y: e.y, z: e.z } }
		})
		return best
	})
	if (bot) {
		await page.evaluate(({ bot }) => {
			const s = window.gameClient.simulator
			const e = s.myRawEntity
			const pos = { x: bot.x + 2.2, y: bot.y + 0.6, z: bot.z + 2.2 }
			e.x = pos.x; e.y = pos.y; e.z = pos.z; e.velX = e.velY = e.velZ = 0
			const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
			if (cam && cam.position) {
				cam.position.set(pos.x, pos.y + 0.4, pos.z)
				const dx = bot.x - pos.x, dz = bot.z - pos.z
				if ('rotation' in cam) {
					cam.rotation.y = Math.atan2(dx, dz)
					cam.rotation.x = -Math.atan2(bot.y - pos.y, Math.hypot(dx, dz))
				}
			}
			;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
			document.body.classList.add('arena-entered')
		}, { bot })
		for (let i = 0; i < 40; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} }); await sleep(16) }
		await page.screenshot({ path: `${OUT}/closeup-ffa-black.png` })
	}

	const allNeutral = audit.models.length >= 2 && audit.models.every(m => m.neutral)
	const allBlackTex = audit.models.every(m => m.suitTex.length && m.suitTex.every(u => /uniform_black/.test(u)))
	const noTeamTex = audit.models.every(m => m.suitTex.every(u => !/uniform_(red|blue)/.test(u)))
	const ok = audit.isFFA && allNeutral && allBlackTex && noTeamTex && errors.length === 0
	console.log(JSON.stringify({
		mode: audit.mode, isFFA: audit.isFFA,
		models: audit.models,
		allNeutral, allBlackTex, noTeamTex,
		pageErrors: errors.slice(0, 3),
		screenshot: bot ? OUT + '/closeup-ffa-black.png' : null,
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
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
