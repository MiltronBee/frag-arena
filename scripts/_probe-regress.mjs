// REGRESSION: force each way the death clip can fail to run and assert the rig is never
// left with nothing animating it (the bind-pose statue).
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
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '3', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 620 })
  page.on('pageerror', e => console.error('PAGEERR', e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(7000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    window.__setup = () => {
      const m = [...sim.characterModels.values()].find(x => x.ready && x.deathClip && !x._corpse)
      window.__m = m
      return !!m
    }
    window.__frame = () => new Promise(r => sim.renderer.scene.onAfterRenderObservable.addOnce(() => r()))
    window.__hand = (m) => {
      const n = m._handNode(); if (!n) return null
      n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
      const a = n.absolutePosition, b = m.holder.absolutePosition
      return [+(a.x - b.x).toFixed(3), +(a.y - b.y).toFixed(3), +(a.z - b.z).toFixed(3)]
    }
    // "did the rig move over N frames, and did it avoid bind pose?"
    window.__watchPose = async (m, n) => {
      const rows = []
      for (let i = 0; i < n; i++) { await window.__frame(); rows.push(window.__hand(m)) }
      let moved = 0
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i], b = rows[i - 1]
        if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.002) moved++
      }
      const bind = rows.filter(r => r && Math.abs(r[1] - 0.8398) < 0.02 && Math.abs(Math.hypot(r[0], r[2]) - 0.409) < 0.02).length
      return { moved, bind, first: rows[0], last: rows[rows.length - 1] }
    }
    window.__case = async (kind) => {
      const m = window.__m, dc = m.deathClip
      if (m._corpse) m.setCorpse(false)
      await window.__frame()
      let saved = null
      if (kind === 'stuckStarted') { dc.start(false, 1.0); dc.stop(); dc._isStarted = true; dc._animatables.length = 0 }
      if (kind === 'startStopSameTick') { dc.start(false, 1.0); dc.stop() }
      if (kind === 'noDeathClip') { saved = m.deathClip; m.deathClip = null }
      m.setCorpse(true)
      const post = { playing: dc.isPlaying, an: dc.animatables.length, using: m._usingDeathClip, cur: m.current && m.current.name }
      const pose = await window.__watchPose(m, 30)
      const tip = m.holder.rotationQuaternion ? 1 : 0
      m.setCorpse(false)
      if (saved) m.deathClip = saved
      await window.__frame()
      const after = await window.__watchPose(m, 10)
      return { kind, post, pose, tipApplied: tip, afterRespawn: after }
    }
  })

  const ok = await page.evaluate(() => window.__setup())
  if (!ok) throw new Error('no model')
  for (const kind of ['plain', 'startStopSameTick', 'stuckStarted', 'noDeathClip', 'plain']) {
    const r = await page.evaluate((k) => window.__case(k), kind)
    const verdict = (r.pose.bind === 0 && r.pose.moved >= 5) ? 'PASS' : 'FAIL'
    console.log(verdict, JSON.stringify(r))
  }
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
