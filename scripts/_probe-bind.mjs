// BIND-POSE CATCHER: watch every model's hand-bone TransformNode. When it sits at the
// rest offset (~y0.84) for >120ms, dump animatable-level state: is the death clip's
// animatable in scene._activeAnimatables, does it target THIS model's nodes, is it paused.
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
const RUN_MS = +(process.env.RUN_MS || 240000)
const OUT = process.env.SHOT_DIR || '/tmp/bindpose'
fs.mkdirSync(OUT, { recursive: true })
let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'visage', BOTS: process.env.BOTS || '6', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  page.on('pageerror', e => console.error('PAGEERR', e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(4000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    window.__ev = []
    window.__badNid = null
    const state = new Map()
    const dumpA = (m, g) => {
      if (!g) return null
      const a = g._animatables[0]
      const handNode = m._handNode()
      const owns = handNode ? g._targetedAnimations.some(ta => ta.target === handNode) : null
      return {
        name: g.name, st: !!g._isStarted, pa: !!g._isPaused, an: g._animatables.length,
        speed: g.speedRatio, from: g.from, to: g.to,
        targetsThisModel: owns,
        a0: a ? {
          tgt: a.target && a.target.name, mf: +a.masterFrame.toFixed(2), paused: !!a._paused,
          off: a._localDelayOffset, rt: a._runtimeAnimations.length, w: a._weight,
          inScene: scene._activeAnimatables.indexOf(a), started: !!a.animationStarted,
        } : null,
      }
    }
    scene.onAfterRenderObservable.add(() => {
      const now = performance.now()
      for (const [nid, m] of sim.characterModels) {
        if (!m.ready || !m.holder || m.disposed || !m.holder.isEnabled()) { state.delete(nid); continue }
        let h = null
        try {
          const n = m._handNode(); if (!n) continue
          n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
          const a = n.absolutePosition, b = m.holder.absolutePosition
          h = [a.x - b.x, a.y - b.y, a.z - b.z]
        } catch (e) { continue }
        const s = state.get(nid)
        const bind = Math.abs(h[1] - 0.8398) < 0.02
        if (!s || !bind || Math.hypot(h[0] - s.h[0], h[1] - s.h[1], h[2] - s.h[2]) > 0.0015) {
          state.set(nid, { h, since: now, reported: false }); continue
        }
        const held = now - s.since
        if (held >= 120 && !s.reported) {
          s.reported = true
          window.__badNid = nid
          window.__ev.push({
            nid, held: Math.round(held), t: Math.round(now), h: h.map(v => +v.toFixed(3)),
            corpse: !!m._corpse, using: !!m._usingDeathClip, alive: m.host?.isAlive,
            ageMs: m.__born ? Math.round(now - m.__born) : null,
            sceneAnimatables: scene._activeAnimatables.length,
            cur: m.current ? m.current.name : null,
            death: dumpA(m, m.deathClip), idle: dumpA(m, m.idle),
            oneShot: m._oneShot ? m._oneShot.name : null,
          })
        }
      }
      for (const [nid, m] of sim.characterModels) if (m.ready && !m.__born) m.__born = now
    })
  })

  let shots = 0
  const deadline = Date.now() + RUN_MS
  while (Date.now() < deadline) {
    await sleep(400)
    if (shots >= 6) continue
    try {
      const st = await page.evaluate(() => {
        const sim = window.gameClient.simulator
        const nid = window.__badNid
        if (nid == null) return null
        window.__badNid = null
        const m = sim.characterModels.get(nid)
        if (!m || !m.holder) return null
        const p = m.holder.absolutePosition
        const cam = sim.renderer.camera
        cam.position.set(p.x + 2.2, p.y + 1.1, p.z + 2.2)
        const dx = p.x - cam.position.x, dy = (p.y + 0.5) - cam.position.y, dz = p.z - cam.position.z
        const len = Math.hypot(dx, dy, dz) || 1
        cam.rotation.y = Math.atan2(dx, dz); cam.rotation.x = -Math.asin(dy / len)
        return { nid, corpse: !!m._corpse }
      })
      if (st) { await page.screenshot({ path: `${OUT}/bind-${++shots}-nid${st.nid}-${st.corpse ? 'corpse' : 'live'}.png` }) }
    } catch (e) {}
  }
  const r = await page.evaluate(() => window.__ev)
  fs.writeFileSync(`${OUT}/bind.json`, JSON.stringify(r, null, 1))
  console.log('BIND-POSE EVENTS', r.length)
  r.slice(0, 20).forEach(e => console.log(JSON.stringify(e)))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
