// Why is a just-loaded model's animation not stepped? Watch scene-level animation state
// per frame for a model that is sitting in bind pose.
import { spawn } from 'child_process'
import net from 'net'
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
let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '5', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 560 })
  page.on('pageerror', e => console.error('PAGEERR', e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  // hook as EARLY as possible so we catch the first ready frame of a model
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    window.__rows = []
    window.__done = false
    let target = null
    scene.onAfterRenderObservable.add(() => {
      if (window.__done) return
      if (!target) {
        for (const [nid, m] of sim.characterModels) {
          if (m.ready && m.idle) { target = m; break }
        }
        if (!target) return
      }
      const m = target
      const g = m.current || m.idle
      const a = g && g._animatables[0]
      let h = null
      try {
        const n = m._handNode()
        if (n && m.holder) {
          n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
          const p = n.absolutePosition, b = m.holder.absolutePosition
          h = [+(p.x - b.x).toFixed(3), +(p.y - b.y).toFixed(3), +(p.z - b.z).toFixed(3)]
        }
      } catch (e) {}
      window.__rows.push({
        h, clip: g && g.name, st: g ? !!g._isStarted : null, an: g ? g._animatables.length : null,
        off: a ? (a._localDelayOffset === null ? null : Math.round(a._localDelayOffset)) : null,
        mf: a ? +a.masterFrame.toFixed(1) : null, idx: a ? scene._activeAnimatables.indexOf(a) : null,
        started: a ? !!a.animationStarted : null,
        sAn: scene._activeAnimatables.length, dt: Math.round(scene.deltaTime),
        aTime: Math.round(scene._animationTime), pend: scene._pendingData.length,
        animEnabled: scene.animationsEnabled,
      })
      if (window.__rows.length >= 60) window.__done = true
    })
  })
  await page.waitForFunction('window.__done === true', { timeout: 90000 })
  const rows = await page.evaluate(() => window.__rows)
  rows.forEach((r, i) => console.log(i, JSON.stringify(r)))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
