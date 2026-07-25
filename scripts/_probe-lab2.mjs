// AnimationGroup state forensics around _applyDeathClip: capture _isStarted / _isPaused /
// _animatables.length at every step, over a high-N stress of corpse cycles + real deaths.
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
  await page.setViewport({ width: 900, height: 620 })
  page.on('pageerror', e => console.error('PAGEERR', e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(7000)

  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const m = [...sim.characterModels.values()].find(x => x.ready && x.deathClip)
    window.__m = m
    window.__snap = (g) => ({ st: !!g._isStarted, pa: !!g._isPaused, an: g._animatables.length, ta: g._targetedAnimations.length, na: g._numActiveAnimatables, obs: g.onAnimationGroupEndObservable.observers.length })
    window.__frame = () => new Promise(r => sim.renderer.scene.onAfterRenderObservable.addOnce(() => r()))
    window.__trials = []
    window.__chunk = async (base, n) => {
      const m = window.__m, dc = m.deathClip, snap = window.__snap, frame = window.__frame
      for (let j = 0; j < n; j++) {
        const i = base + j
        const gapIn = i % 6
        const gapOut = 1 + (i % 9) * 5
        for (let k = 0; k < gapIn; k++) await frame()
        const pre = snap(dc)
        m.setCorpse(true)
        const post = snap(dc)
        for (let k = 0; k < gapOut; k++) await frame()
        const mid = snap(dc)
        const midFrame = dc.animatables[0] ? +dc.animatables[0].masterFrame.toFixed(1) : null
        m.setCorpse(false)
        window.__trials.push({ i, gapIn, gapOut, pre, post, mid, midFrame, bad: post.an === 0 })
      }
    }
    window.__natural = async () => {
      const m = window.__m, dc = m.deathClip, snap = window.__snap, frame = window.__frame
      m.setCorpse(true)
      const startedSnap = snap(dc)
      for (let k = 0; k < 130; k++) await frame()
      const endSnap = snap(dc)
      const endFrame = dc.animatables[0] ? +dc.animatables[0].masterFrame.toFixed(1) : null
      m.setCorpse(false)
      await frame()
      m.setCorpse(true)
      const afterNaturalEnd = snap(dc)
      const afterFrames = []
      for (let k = 0; k < 20; k++) { await frame(); afterFrames.push(dc.animatables[0] ? +dc.animatables[0].masterFrame.toFixed(1) : null) }
      m.setCorpse(false)
      return { startedSnap, endSnap, endFrame, afterNaturalEnd, afterFrames }
    }
  })
  for (let b = 0; b < 60; b += 10) await page.evaluate((b) => window.__chunk(b, 10), b)
  const natural = await page.evaluate(() => window.__natural())
  const res = await page.evaluate(() => window.__trials)
  res.trials = res; Object.assign(res, natural)

  const bad = res.trials.filter(t => t.bad)
  console.log('TRIALS', res.trials.length, 'BAD(an===0 right after setCorpse)', bad.length)
  console.log('first 8 trials:'); res.trials.slice(0, 8).forEach(t => console.log(JSON.stringify(t)))
  if (bad.length) { console.log('BAD samples:'); bad.slice(0, 8).forEach(t => console.log(JSON.stringify(t))) }
  console.log('NATURAL-END started', JSON.stringify(res.startedSnap))
  console.log('NATURAL-END after  ', JSON.stringify(res.endSnap), 'frame', res.endFrame)
  console.log('AFTER-NATURAL-END re-corpse', JSON.stringify(res.afterNaturalEnd))
  fs.writeFileSync('/tmp/lab2.json', JSON.stringify(res))
} catch (e) { console.error('ERR', e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
