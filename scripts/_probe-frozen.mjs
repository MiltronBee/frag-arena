// GLOBAL FROZEN-RIG DETECTOR: sample every CharacterModel's hand-bone offset each rendered
// frame. A "statue" = the offset unchanged for >=350ms while the body is enabled+visible.
// Report the model's full animation state at the moment it froze, corpse or not.
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
const OUT = process.env.SHOT_DIR || '/tmp/frozen'
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
  await sleep(6000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    window.__events = []
    window.__stat = { frames: 0, samples: 0, still: 0 }
    const state = new Map() // nid -> { h, t, since, reported }
    const gsnap = (g) => g ? { n: g.name, st: !!g._isStarted, pa: !!g._isPaused, an: g._animatables.length, ta: g._targetedAnimations.length, mf: g._animatables[0] ? +g._animatables[0].masterFrame.toFixed(1) : null } : null
    scene.onAfterRenderObservable.add(() => {
      window.__stat.frames++
      const now = performance.now()
      for (const [nid, m] of sim.characterModels) {
        if (!m.ready || !m.holder || m.disposed) continue
        if (!m.holder.isEnabled()) { state.delete(nid); continue }
        let h = null
        try {
          const n = m._handNode(); if (!n) continue
          n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
          const a = n.absolutePosition, b = m.holder.absolutePosition
          h = [a.x - b.x, a.y - b.y, a.z - b.z]
        } catch (e) { continue }
        window.__stat.samples++
        const s = state.get(nid)
        if (!s) { state.set(nid, { h, since: now, reported: false }); continue }
        const d = Math.hypot(h[0] - s.h[0], h[1] - s.h[1], h[2] - s.h[2])
        if (d > 0.0015) { state.set(nid, { h, since: now, reported: false }); continue }
        window.__stat.still++
        const heldMs = now - s.since
        if (heldMs >= 350 && !s.reported) {
          s.reported = true
          window.__events.push({
            nid, heldMs: Math.round(heldMs), t: Math.round(now),
            h: h.map(v => +v.toFixed(3)),
            corpse: !!m._corpse, using: !!m._usingDeathClip, hidden: !!m._hidden,
            alive: m.host?.isAlive, hitStop: m._hitStopUntil ? Math.round(m._hitStopUntil - now) : 0,
            cur: gsnap(m.current), death: gsnap(m.deathClip), one: gsnap(m._oneShot),
            idle: gsnap(m.idle), run: gsnap(m.run),
          })
        }
      }
    })
    window.__frozenNow = () => {
      const now = performance.now()
      for (const [nid, s] of state) if (!s.reported && now - s.since > 250) return nid
      for (const [nid, s] of state) if (s.reported) return nid
      return null
    }
  })

  let shots = 0
  const deadline = Date.now() + RUN_MS
  while (Date.now() < deadline) {
    await sleep(600)
    if (shots >= 8) continue
    try {
      const st = await page.evaluate(() => {
        const sim = window.gameClient.simulator
        const nid = window.__frozenNow()
        if (nid == null) return null
        const m = sim.characterModels.get(nid)
        if (!m || !m.holder) return null
        const p = m.holder.absolutePosition
        const cam = sim.renderer.camera
        const dx = p.x - cam.position.x, dy = (p.y + 0.5) - cam.position.y, dz = p.z - cam.position.z
        const len = Math.hypot(dx, dy, dz) || 1
        if (len > 14) return null
        cam.rotation.y = Math.atan2(dx, dz); cam.rotation.x = -Math.asin(dy / len)
        return { nid, dist: +len.toFixed(1), corpse: !!m._corpse }
      })
      if (st) { await sleep(60); await page.screenshot({ path: `${OUT}/frozen-${++shots}-nid${st.nid}-${st.corpse ? 'corpse' : 'live'}-d${st.dist}.png` }) }
    } catch (e) {}
  }

  const r = await page.evaluate(() => ({ stat: window.__stat, events: window.__events }))
  fs.writeFileSync(`${OUT}/frozen.json`, JSON.stringify(r))
  console.log('STAT', JSON.stringify(r.stat))
  console.log('FREEZE EVENTS', r.events.length)
  const byKind = {}
  for (const e of r.events) { const k = e.corpse ? 'corpse' : 'live'; byKind[k] = (byKind[k] || 0) + 1 }
  console.log('BY KIND', JSON.stringify(byKind))
  r.events.slice(0, 25).forEach(e => console.log(JSON.stringify(e)))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
