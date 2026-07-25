// PROOF SHOTS: telephoto burst across one bot's death, so the death animation is visible
// frame by frame (not a T-pose statue). Only fires while the local player is alive, so
// the death-cam overlay doesn't cover the shot.
import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${String(d).slice(0, 200)}`))
  procs.push(p); return p
}
const OUT = process.env.SHOT_DIR || '/tmp/proof'
fs.mkdirSync(OUT, { recursive: true })
let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '6', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 640 })
  page.on('pageerror', e => console.error('PAGEERR', e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(8000)
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    // brighten the scene a touch so the corpse reads in a screenshot of a dark map
    sim.renderer.scene.lights.forEach(l => { l.__i = l.intensity })
    window.__boost = (k) => sim.renderer.scene.lights.forEach(l => { l.intensity = l.__i * k })
    window.__fresh = () => {
      const sim = window.gameClient.simulator
      const cam = sim.renderer.camera
      for (const [nid, m] of sim.characterModels) {
        if (!m._corpse || !m.holder || !m.deathClip) continue
        const a = m.deathClip.animatables[0]
        if (!a || a.masterFrame > 25) continue // only just-started deaths
        const p = m.holder.absolutePosition
        const d = Math.hypot(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z)
        if (d < 4 || d > 30) continue
        return { nid, d: +d.toFixed(1) }
      }
      return null
    }
    window.__aim = (nid) => {
      const sim = window.gameClient.simulator
      const m = sim.characterModels.get(nid); if (!m || !m.holder) return null
      const p = m.holder.absolutePosition
      const cam = sim.renderer.camera
      const dx = p.x - cam.position.x, dy = (p.y + 0.4) - cam.position.y, dz = p.z - cam.position.z
      const len = Math.hypot(dx, dy, dz) || 1
      cam.fov = 0.30
      cam.rotation.y = Math.atan2(dx, dz); cam.rotation.x = -Math.asin(dy / len)
      const a = m.deathClip.animatables[0]
      return { mf: a ? +a.masterFrame.toFixed(0) : null, alive: !!sim.myRawEntity?.isAlive }
    }
  })
  await page.evaluate(() => window.__boost(2.4))

  let burst = 0
  const deadline = Date.now() + 180000
  while (Date.now() < deadline && burst < 2) {
    await sleep(120)
    const found = await page.evaluate(() => (window.gameClient.simulator.myRawEntity?.isAlive ? window.__fresh() : null))
    if (!found) continue
    burst++
    for (let i = 0; i < 8; i++) {
      const st = await page.evaluate((nid) => window.__aim(nid), found.nid)
      if (!st) break
      await page.screenshot({ path: `${OUT}/death${burst}-${String(i).padStart(2, '0')}-mf${st.mf}.png` })
      await sleep(130)
    }
    console.log('burst', burst, 'nid', found.nid, 'dist', found.d)
  }
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
