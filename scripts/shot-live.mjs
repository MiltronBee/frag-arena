// Post-deploy smoke test against PROD: join sol-pkmn.fun, deploy, confirm the sky
// variant + map the server actually served, and grab a screenshot looking at the sky.
import fs from 'fs'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/live-deploy'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome', headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1280,720'],
})
try {
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errs = []
	page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
	await page.goto('https://sol-pkmn.fun/', { waitUntil: 'domcontentloaded' })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 90000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 90000 })
	await sleep(6000)

	const info = await page.evaluate(() => {
		const s = window.gameClient.simulator, r = s.renderer, sc = r.scene
		const names = ['earth', 'mars', 'jupiter', 'moon'].filter(n => !!sc.getMeshByName(n))
		return {
			mapId: window.__SERVER_MAP_ID__ || null,
			skyVariant: r.skyVariant || null,
			skyMeshes: names,
			movers: s.movers ? s.movers.size : 0,
			bots: s.characterModels ? s.characterModels.size : 0,
		}
	})
	console.log('LIVE', JSON.stringify(info))
	await page.evaluate(() => ['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => {
		const el = document.getElementById(id); if (el) el.style.display = 'none'
	}))
	// aim at whichever planet is in the scene
	await page.evaluate(() => {
		const s = window.gameClient.simulator, sc = s.renderer.scene, cam = s.renderer.camera
		const p = sc.getMeshByName('mars') || sc.getMeshByName('jupiter') || sc.getMeshByName('earth')
		if (!p) return
		const d = p.position.subtract(cam.position)
		cam.rotation.set(-Math.atan2(d.y, Math.hypot(d.x, d.z)), Math.atan2(d.x, d.z), 0)
	})
	for (let i = 0; i < 25; i++) {
		await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} })
		await sleep(16)
	}
	await page.screenshot({ path: `${OUT}/live-sky.png` })
	console.log('pageErrors', errs.slice(0, 3))
	console.log('OUT', OUT)
} catch (e) {
	console.error('LIVE SHOT ERROR:', e.message)
} finally {
	await browser.close().catch(() => {})
}
process.exit(0)
