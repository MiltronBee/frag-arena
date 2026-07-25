// BIND-POSE CATCHER v2: full state on every bind-pose frame — the CURRENT clip's
// animatables, frame delta, model identity/age (fresh instance?), and model churn counts.
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
const RUN_MS = +(process.env.RUN_MS || 210000)
const OUT = process.env.SHOT_DIR || '/tmp/bind2'
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
  await sleep(3000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    window.__ev = []
    window.__churn = { seen: 0, ids: 0 }
    window.__badNid = null
    const seen = new WeakSet()
    const state = new Map()
    let lastT = performance.now()
    const dumpA = (m, g) => {
      if (!g) return null
      const a = g._animatables[0]
      return {
        n: g.name, st: !!g._isStarted, pa: !!g._isPaused, an: g._animatables.length, sp: g.speedRatio,
        a0: a ? { tgt: a.target && a.target.name, mf: +a.masterFrame.toFixed(2), paused: !!a._paused,
          off: a._localDelayOffset === null ? null : Math.round(a._localDelayOffset), rt: a._runtimeAnimations.length,
          w: a._weight, inScene: scene._activeAnimatables.indexOf(a), started: !!a.animationStarted } : null,
      }
    }
    scene.onAfterRenderObservable.add(() => {
      const now = performance.now()
      const dt = now - lastT; lastT = now
      for (const [nid, m] of sim.characterModels) {
        if (!seen.has(m)) { seen.add(m); window.__churn.seen++; m.__born = now }
        if (!m.ready || !m.holder || m.disposed || !m.holder.isEnabled()) { state.delete(nid); continue }
        let h = null
        try {
          const n = m._handNode(); if (!n) continue
          n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
          const a = n.absolutePosition, b = m.holder.absolutePosition
          h = [a.x - b.x, a.y - b.y, a.z - b.z]
        } catch (e) { continue }
        const bind = Math.abs(h[1] - 0.8398) < 0.02 && Math.abs(Math.hypot(h[0], h[2]) - 0.409) < 0.02
        const s = state.get(nid)
        if (!bind) { state.set(nid, { since: now, reported: false, frames: 0 }); continue }
        if (!s) { state.set(nid, { since: now, reported: false, frames: 1 }); continue }
        s.frames++
        const held = now - s.since
        if (s.frames >= 3 && !s.reported) {
          s.reported = true
          window.__badNid = nid
          window.__ev.push({
            nid, held: Math.round(held), frames: s.frames, dt: Math.round(dt), t: Math.round(now),
            age: Math.round(now - m.__born), corpse: !!m._corpse, using: !!m._usingDeathClip,
            alive: m.host?.isAlive, sceneAn: scene._activeAnimatables.length,
            cur: dumpA(m, m.current), death: dumpA(m, m.deathClip), one: dumpA(m, m._oneShot),
          })
        }
      }
    })
  })

  let shots = 0
  const deadline = Date.now() + RUN_MS
  while (Date.now() < deadline) {
    await sleep(300)
    if (shots >= 6) continue
    try {
      const st = await page.evaluate(() => {
        const sim = window.gameClient.simulator
        const nid = window.__badNid
        if (nid == null) return null
        const m = sim.characterModels.get(nid)
        if (!m || !m.holder) return null
        const p = m.holder.absolutePosition
        const cam = sim.renderer.camera
        const dx = p.x - cam.position.x, dy = (p.y + 0.5) - cam.position.y, dz = p.z - cam.position.z
        const len = Math.hypot(dx, dy, dz) || 1
        if (len < 3 || len > 18) return null
        window.__badNid = null
        cam.rotation.y = Math.atan2(dx, dz); cam.rotation.x = -Math.asin(dy / len)
        return { nid, dist: +len.toFixed(1), corpse: !!m._corpse }
      })
      if (st) { await page.screenshot({ path: `${OUT}/b-${++shots}-nid${st.nid}-${st.corpse ? 'corpse' : 'live'}-d${st.dist}.png` }) }
    } catch (e) {}
  }
  const r = await page.evaluate(() => ({ ev: window.__ev, churn: window.__churn, models: window.gameClient.simulator.characterModels.size }))
  fs.writeFileSync(`${OUT}/bind2.json`, JSON.stringify(r, null, 1))
  console.log('CHURN', JSON.stringify(r.churn), 'models now', r.models)
  console.log('BIND EVENTS', r.ev.length)
  r.ev.slice(0, 20).forEach(e => console.log(JSON.stringify(e)))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
