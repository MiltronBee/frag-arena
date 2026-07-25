// How often does a live bot sit with NO animation group playing? A model with
// current === null is frozen at BIND POSE (the T-pose statue seen in a wide screenshot),
// so this measures whether that state is a sub-second transient or a stuck state.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const procs = []
const boot = (cmd, args, env) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: 'ignore', detached: true })
  procs.push(p); return p
}
let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '4', MATCH_SECONDS: '3000' })
  if (!(await portBusy(8080))) boot('npx', ['vite', '--port', '8080', '--strictPort'], {})
  await sleep(9000)
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const page = await browser.newPage()
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(5000)
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    window.__s = { samples: 0, nullClip: 0, notPlaying: 0, corpse: 0, runs: [], cur: {} }
    window.__t = setInterval(() => {
      const s = window.__s
      for (const [id, m] of sim.characterModels) {
        if (!m.ready) continue
        s.samples++
        const bad = !m.current || !m.current.isPlaying
        if (!m.current) s.nullClip++
        else if (!m.current.isPlaying) s.notPlaying++
        if (m._corpse) s.corpse++
        const k = 'r' + id
        if (bad) s.cur[k] = (s.cur[k] || 0) + 1
        else if (s.cur[k]) { s.runs.push(s.cur[k] * 33); s.cur[k] = 0 }
      }
    }, 33)
  })
  await sleep(30000)
  const r = await page.evaluate(() => { clearInterval(window.__t); const s = window.__s; return {
    samples: s.samples, nullClip: s.nullClip, notPlaying: s.notPlaying, corpse: s.corpse,
    bindPosePct: +((100 * (s.nullClip + s.notPlaying)) / Math.max(s.samples, 1)).toFixed(2),
    stallRunsMs: s.runs.sort((a, b) => b - a).slice(0, 10), ongoing: s.cur } })
  console.log(JSON.stringify(r, null, 1))
} catch (e) { console.error('ERR', e.message) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
