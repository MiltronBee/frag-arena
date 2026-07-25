// DEATH-ANIM FORENSICS v3 (43fps vulkan-ANGLE backend — swiftshader ran at 3fps and
// made every pose look frozen). One record per death, keyed by a unique id so a repeat
// death on the same nid can't alias. Bind pose == hand bone offset stuck at ~y0.84.
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
const RUN_MS = +(process.env.RUN_MS || 150000)
const TAG = process.env.TAG || 'before'
const SHOT_DIR = process.env.SHOT_DIR || `/tmp/death-${TAG}`
fs.mkdirSync(SHOT_DIR, { recursive: true })

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'visage', BOTS: process.env.BOTS || '5', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(7000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    window.__frames = 0
    scene.onAfterRenderObservable.add(() => { window.__frames++ })
    window.__deaths = []
    window.__live = new Map() // nid -> record
    window.__seq = 0
    const tag = () => { for (const [nid, m] of sim.characterModels) m.__nid = nid }
    tag(); setInterval(tag, 300)

    const anyModel = [...sim.characterModels.values()][0]
    const proto = Object.getPrototypeOf(anyModel)
    window.__raw = 0
    const origSet = proto.setCorpse
    proto.setCorpse = function (on) {
      window.__raw++
      const nid = this.__nid
      if (on && !this._corpse) {
        const rec = {
          id: ++window.__seq, nid, t0: performance.now(), f0: window.__frames,
          readyAtEntry: !!this.ready, holderAtEntry: !!this.holder, clipAtEntry: !!this.deathClip,
          rows: [], closedAt: null, closedFrames: null,
        }
        window.__live.set(nid, rec)
        window.__deaths.push(rec)
        const r = origSet.call(this, on)
        rec.usingDeathClip = !!this._usingDeathClip
        rec.postPlaying = this.deathClip ? !!this.deathClip.isPlaying : null
        rec.postAnimatables = this.deathClip ? (this.deathClip.animatables || []).length : null
        return r
      }
      if (!on) {
        const rec = window.__live.get(nid)
        if (rec) { rec.closedAt = Math.round(performance.now() - rec.t0); rec.closedFrames = window.__frames - rec.f0; window.__live.delete(nid) }
      }
      return origSet.call(this, on)
    }

    const handOff = (m) => {
      try {
        const n = m._handNode()
        if (!n || !m.holder) return null
        n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
        const a = n.absolutePosition, b = m.holder.absolutePosition
        return [+(a.x - b.x).toFixed(4), +(a.y - b.y).toFixed(4), +(a.z - b.z).toFixed(4)]
      } catch (e) { return null }
    }
    window.__handOff = handOff
    window.__statueNow = () => {
      // any corpse currently frozen upright in bind pose (for the screenshot trigger)
      for (const [nid, rec] of window.__live) {
        const rows = rec.rows
        if (rows.length < 8) continue
        const last = rows.slice(-8)
        if (!last[0].h) continue
        const still = last.every(r => r.h && Math.abs(r.h[1] - last[0].h[1]) < 0.004)
        if (still && Math.abs(last[0].h[1] - 0.84) < 0.03) return nid
      }
      return null
    }

    setInterval(() => {
      for (const [nid, rec] of window.__live) {
        const m = sim.characterModels.get(nid)
        if (!m) continue
        const dc = m.deathClip
        const q = m.holder && m.holder.rotationQuaternion
        rec.rows.push({
          t: Math.round(performance.now() - rec.t0),
          f: window.__frames - rec.f0,
          rdy: m.ready ? 1 : 0,
          pl: dc ? (dc.isPlaying ? 1 : 0) : -1,
          mf: dc?.animatables?.[0] ? +dc.animatables[0].masterFrame.toFixed(1) : null,
          h: handOff(m),
          tip: q ? +(2 * Math.acos(Math.min(1, Math.abs(q.w)))).toFixed(2) : 0,
          en: m.holder ? m.holder.isEnabled() : null,
          vis: m.meshes && m.meshes[1] ? +m.meshes[1].visibility.toFixed(2) : null,
        })
      }
    }, 33)
  })

  // screenshot loop: grab any corpse frozen in bind pose, plus a couple of ordinary corpses
  let shots = 0, ok = 0
  const deadline = Date.now() + RUN_MS
  while (Date.now() < deadline) {
    await sleep(250)
    try {
      const st = await page.evaluate(() => {
        const sim = window.gameClient.simulator
        const bad = window.__statueNow()
        const anyCorpse = [...window.__live.keys()][0]
        const nid = bad != null ? bad : anyCorpse
        if (nid == null) return null
        const m = sim.characterModels.get(nid)
        if (!m || !m.holder) return null
        const p = m.holder.absolutePosition
        const cam = sim.renderer.camera
        const dx = p.x - cam.position.x, dy = (p.y + 0.4) - cam.position.y, dz = p.z - cam.position.z
        const len = Math.hypot(dx, dy, dz) || 1
        if (len < 2.5 || len > 12) return null
        cam.rotation.y = Math.atan2(dx, dz)
        cam.rotation.x = -Math.asin(dy / len)
        return { nid, bad: bad != null, dist: +len.toFixed(1), h: window.__handOff(m) }
      })
      if (!st) continue
      if (st.bad && shots < 6) {
        await page.screenshot({ path: `${SHOT_DIR}/statue-${++shots}-nid${st.nid}-d${st.dist}.png` })
      } else if (!st.bad && ok < 10) {
        await sleep(50)
        await page.screenshot({ path: `${SHOT_DIR}/corpse-${++ok}-nid${st.nid}-d${st.dist}.png` })
      }
    } catch (e) {}
  }

  const out = await page.evaluate(() => ({
    fps: +window.gameClient.simulator.renderer.scene.getEngine().getFps().toFixed(1),
    frames: window.__frames, raw: window.__raw, seq: window.__seq,
    deaths: window.__deaths.map(d => ({
      id: d.id, nid: d.nid, ready: d.readyAtEntry, holder: d.holderAtEntry, clip: d.clipAtEntry,
      using: d.usingDeathClip, postPlaying: d.postPlaying, postAn: d.postAnimatables,
      closedAt: d.closedAt, rows: d.rows,
    })),
  }))

  const analysed = out.deaths.map(d => {
    const s = d.rows.filter(r => r.h)
    const hs = s.map(r => r.h)
    let maxStill = 0, cur = 0
    for (let i = 1; i < hs.length; i++) {
      const a = hs[i], b = hs[i - 1]
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.002) { cur++; maxStill = Math.max(maxStill, cur) } else cur = 0
    }
    // bind-pose frames: hand at the rest height AND upright
    const bind = s.filter(r => Math.abs(r.h[1] - 0.8398) < 0.02).length
    const frames = s.map(r => r.mf).filter(x => x != null)
    return {
      id: d.id, nid: d.nid, ready: d.ready, clip: d.clip, using: d.using, postPlaying: d.postPlaying,
      n: s.length, renderFrames: s.length ? s[s.length - 1].f : 0, dur: s.length ? s[s.length - 1].t : 0,
      closedAt: d.closedAt,
      bindFrames: bind, maxStillMs: maxStill * 33,
      mf: frames.length ? [Math.min(...frames), Math.max(...frames)] : null,
      maxTip: Math.max(0, ...s.map(r => r.tip)),
      h0: hs[0], h1: hs[hs.length - 1],
      BAD: bind >= 5,
    }
  })
  fs.writeFileSync(`${SHOT_DIR}/raw.json`, JSON.stringify(out))
  console.log('FPS', out.fps, 'FRAMES', out.frames, 'RAWCALLS', out.raw, 'SEQ', out.seq, 'DEATHS', analysed.length)
  console.log(analysed.map(a => JSON.stringify(a)).join('\n'))
  console.log('BADCOUNT', analysed.filter(a => a.BAD).length, '/', analysed.length)
  console.log('PAGEERRORS', JSON.stringify(errors.slice(0, 5)))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
