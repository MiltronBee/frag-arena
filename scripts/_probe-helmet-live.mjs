// Ground-truth helmet render: boots vite DEV (serves source, so my CharacterModel
// _skinHelmet change is live without a build) and loads the ?playground route, which
// now applies the same skin. Waits for the helmet to mount, frames the head, shoots.
import { spawn, execSync } from 'child_process'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => { try { execSync(`ss -ltn | grep -q ':${p} '`); return true } catch { return false } }
const procs = []
const boot = (c, a, e, t) => { const p = spawn(c, a, { env: { ...process.env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stderr.on('data', d => process.stderr.write(`[${t}!] ${d}`)); procs.push(p); return p }
let browser = null
try {
  const ownVite = !portBusy(8080)
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 4000)
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 900 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8080/?playground', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.playground && window.playground._helmetRoot', { timeout: 45000 })
  await sleep(2500)
  // frame the head: point the playground camera at the helmet
  await page.evaluate(() => {
    const pg = window.playground
    const cam = pg.camera || pg.scene.activeCamera
    const h = pg._helmetRoot.getAbsolutePosition()
    if (cam.setTarget) cam.setTarget(h)
    if ('radius' in cam) cam.radius = 1.1
    if ('beta' in cam) { cam.alpha = -Math.PI / 2 - 0.5; cam.beta = 1.35 }
    if ('target' in cam && cam.target.copyFrom) cam.target.copyFrom(h)
  })
  await sleep(600)
  await page.screenshot({ path: '/tmp/helmet_live.png' })
  console.log(JSON.stringify({ errors: errors.slice(0, 3), verdict: errors.length ? 'ERRORS' : 'OK' }))
} catch (e) { console.error('ERR', e.message) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
}
