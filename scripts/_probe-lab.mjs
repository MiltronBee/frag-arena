// CORPSE PATH LAB: drive setCorpse directly on a live model and watch the skeleton.
// Answers: does current.stop() snap the rig to bind pose? does the death clip evaluate?
// does the freeze-on-last-frame handler survive stop()'s synchronous end-observable?
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
const OUT = process.env.SHOT_DIR || '/tmp/death-lab'
fs.mkdirSync(OUT, { recursive: true })

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '3', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 300000,
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

  const log = await page.evaluate(async () => {
    const sim = window.gameClient.simulator
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    const m = [...sim.characterModels.values()].find(x => x.ready && x.deathClip)
    const out = { phases: [], meta: {} }
    const hand = () => {
      const n = m._handNode(); if (!n) return null
      n.computeWorldMatrix(true); m.holder.computeWorldMatrix(true)
      const a = n.absolutePosition, b = m.holder.absolutePosition
      return [+(a.x - b.x).toFixed(3), +(a.y - b.y).toFixed(3), +(a.z - b.z).toFixed(3)]
    }
    const frame = () => new Promise(r => sim.renderer.scene.onAfterRenderObservable.addOnce(() => r()))
    const sample = async (label, frames) => {
      const rows = []
      for (let i = 0; i < frames; i++) {
        await frame()
        const dc = m.deathClip
        rows.push({ h: hand(), pl: dc.isPlaying ? 1 : 0, mf: dc.animatables?.[0] ? +dc.animatables[0].masterFrame.toFixed(1) : null })
      }
      out.phases.push({ label, rows })
    }
    out.meta.deathFrom = m.deathClip.from
    out.meta.deathTo = m.deathClip.to
    out.meta.targets = m.deathClip.targetedAnimations.length
    out.meta.idleStarted = !!m.idle._isStarted

    // --- A: baseline (locomotion/idle running)
    await sample('A-baseline', 6)

    // --- B: stop the current locomotion clip only. Does the rig snap to bind pose?
    const cur = m.current
    if (cur) cur.stop()
    await sample('B-after-current-stop', 6)

    // --- C: does AnimationGroup.stop() fire the end observable synchronously?
    let endFires = 0
    m.deathClip.onAnimationGroupEndObservable.clear()
    m.deathClip.onAnimationGroupEndObservable.add(() => endFires++)
    m.deathClip.stop()
    out.meta.endFiresOnStopWhileStopped = endFires
    m.deathClip.start(false, 1.0)
    endFires = 0
    m.deathClip.stop()
    out.meta.endFiresOnStopWhileRunning = endFires
    m.deathClip.onAnimationGroupEndObservable.clear()

    // --- D: the real path
    let freezeFired = 0
    const origApply = m._applyDeathClip.bind(m)
    m._applyDeathClip = function () {
      const r = origApply()
      // re-add a spy AFTER the real handler registration so we can see if the real one is gone
      out.meta.observersAfterApply = m.deathClip.onAnimationGroupEndObservable.observers.length
      m.deathClip.onAnimationGroupEndObservable.add(() => freezeFired++)
      return r
    }
    if (m.idle) { m.idle.start(true, 1.0); m.current = m.idle }
    await frame()
    m.setCorpse(true)
    out.meta.postCorpse = { playing: m.deathClip.isPlaying, an: (m.deathClip.animatables || []).length, using: m._usingDeathClip }
    await sample('D-corpse', 100)
    out.meta.freezeObsFiredDuringCorpse = freezeFired
    out.meta.endFrameAfterClip = m.deathClip.animatables?.[0] ? +m.deathClip.animatables[0].masterFrame.toFixed(1) : null
    out.meta.playingAtEnd = m.deathClip.isPlaying

    // --- E: leave corpse mode (respawn reuse)
    m.setCorpse(false)
    await sample('E-after-uncorpse', 8)
    out.meta.currentAfterUncorpse = m.current ? m.current.name : null
    out.meta.idleStartedAfter = !!m.idle._isStarted

    // --- F: second corpse cycle on the same model (state leakage?)
    await new Promise(r => setTimeout(r, 300))
    m.setCorpse(true)
    await sample('F-corpse2', 60)
    out.meta.cycle2 = { playing: m.deathClip.isPlaying, mf: m.deathClip.animatables?.[0]?.masterFrame }
    m.setCorpse(false)

    // --- G: the NOT-READY race — setCorpse before _load finished
    m.ready = false
    m.setCorpse(true)
    out.meta.notReady_corpseFlag = m._corpse
    out.meta.notReady_using = m._usingDeathClip
    out.meta.notReady_playing = m.deathClip.isPlaying
    out.meta.notReady_currentStillRunning = m.current ? m.current.isPlaying : null
    m.ready = true
    await sample('G-notready-corpse', 40)
    m.setCorpse(false)
    m.ready = true
    return out
  })

  console.log('META', JSON.stringify(log.meta, null, 1))
  for (const p of log.phases) {
    const hs = p.rows.map(r => r.h)
    let moves = 0
    for (let i = 1; i < hs.length; i++) if (hs[i] && hs[i - 1] && Math.hypot(hs[i][0] - hs[i - 1][0], hs[i][1] - hs[i - 1][1], hs[i][2] - hs[i - 1][2]) > 0.002) moves++
    console.log(`--- ${p.label}: ${p.rows.length} frames, ${moves} moved`)
    console.log(p.rows.slice(0, 12).map(r => `h${JSON.stringify(r.h)} pl${r.pl} mf${r.mf}`).join(' | '))
    if (p.rows.length > 12) console.log('  ...last:', p.rows.slice(-4).map(r => `h${JSON.stringify(r.h)} pl${r.pl} mf${r.mf}`).join(' | '))
  }
  fs.writeFileSync(`${OUT}/lab.json`, JSON.stringify(log))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
