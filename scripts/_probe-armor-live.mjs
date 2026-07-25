// Render a bot in-game to verify the armor mount (armor shows on OTHER players only —
// the local player is first-person). Boots server (1 bot) + vite dev, deploys, finds a
// bot CharacterModel, frames the game camera on it, screenshots.
import { spawn, execSync } from 'child_process'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => { try { execSync(`ss -ltn | grep -q ':${p} '`); return true } catch { return false } }
const procs = []
const boot = (c, a, e, t) => { const p = spawn(c, a, { env: { ...process.env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stderr.on('data', d => process.stderr.write(`[${t}!] ${d}`)); procs.push(p); return p }
let browser = null
try {
  const t0 = Date.now(); while ((portBusy(8078) || portBusy(8079)) && Date.now() - t0 < 90000) await sleep(5000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'grove', BOTS: '1' }, 'server')
  const ownVite = !portBusy(8080); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 5000)
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] })
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 1000 })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  // dismiss splash + enter the arena so the 3D view is visible (not the menu overlay)
  await page.evaluate(() => {
    const sp = document.getElementById('splash'); if (sp) sp.remove()
    const sim = window.gameClient.simulator
    sim.requestDeploy()
    if (sim._enterArena) sim._enterArena()
    const ov = document.getElementById('entry-overlay'); if (ov) ov.style.display = 'none'
  })
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  // wait for a bot character model that is ready
  await page.waitForFunction(() => {
    const sim = window.gameClient.simulator
    for (const m of sim.characterModels.values()) if (m.ready && m.host) return true
    return false
  }, { timeout: 45000 })
  await sleep(3500) // let armor pieces async-load + mount
  const info = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    let model = null
    for (const m of sim.characterModels.values()) { if (m.ready && m.host) { model = m; break } }
    const h = model.host.position
    // FREEZE the sim so the per-frame camera rebase stops stomping our framing.
    sim.update = () => {}
    const cam = sim.renderer.camera
    cam.parent = null
    cam.position.set(h.x + 0.2, h.y + 1.15, h.z + 2.6)
    cam.setTarget ? cam.setTarget(new (cam.position.constructor)(h.x, h.y + 1.0, h.z)) : cam.rotation.set(0.05, Math.PI, 0)
    if (sim.viewmodel && sim.viewmodel.setActive) sim.viewmodel.setActive(false)
    return { armorCount: (model._armorRoots || []).length }
  })
  await sleep(700)
  await page.screenshot({ path: '/tmp/armor_live.png' })
  console.log(JSON.stringify({ ...info, errors: errors.slice(0, 3), verdict: info.armorCount > 0 ? 'MOUNTED' : 'NO_ARMOR' }, null, 2))
} catch (e) { console.error('ERR', e.message) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(400)
}
