// Reproduce HUMAN flag capture (the probe suite only ever tests a BOT capturing).
// A team-0 browser client spawns AT the enemy (BLUE/team-1) flag, grabs it, then
// autopilots down the Facing-Worlds bridge to the team-0 home stand. Watches the
// server [capdiag] logs + the FLAG_CAPTURED ObjectiveEvent. If it reaches the stand
// (own flag HOME) and never captures -> bug reproduced.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => { const s = net.createConnection({ port: +p, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
const SCALE = 0.65
// team-0 flag home (native -> world x,z); the target we drive toward
const T0 = { x: 123.599 * SCALE, z: 8.356 * SCALE }
const BLUE_FLAG_NATIVE = '-19.306,-37.508,-11.28' // spawn the team-0 client here to grab it
let serverLog = ''
const procs = []
const boot = (cmd, args, env, tag, cap) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { const s = d.toString(); if (cap) serverLog += s; if (/capdiag|objective|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  procs.push(p); return p
}
let browser = null
try {
  const t0 = Date.now(); while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '0', DEV_SPAWN_AT: BLUE_FLAG_NATIVE, CAPDIAG: "1" }, 'srv', true)
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 600 })
  const events = []
  await page.exposeFunction('__obj', e => events.push(e))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    sim.client.on('message::ObjectiveEvent', m => window.__obj({ kind: m.kind, team: m.team, nid: m.entityNid || m.nid }))
    sim.requestDeploy()
  })
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await sleep(1500)
  // grab check + autopilot toward the team-0 home stand
  const report = { grabbed: false, reachedStand: false, minDist: 999, captured: false, ownFlagStateAtStand: null }
  const DEADLINE = Date.now() + 40000
  while (Date.now() < DEADLINE) {
    const st = await page.evaluate(({ tx, tz }) => {
      const sim = window.gameClient.simulator
      const e = sim.myRawEntity
      if (!e) return null
      // autopilot: face the target, hold forward
      const yaw = Math.atan2(tx - e.x, tz - e.z)
      sim.renderer.camera.rotation.y = yaw
      sim.renderer.camera.rotation.x = 0
      if (sim.input && sim.input._currentState) { sim.input._currentState.forward = true; sim.input._currentState.jump = false }
      // read flag states
      let carrying = false, ownFlag = null, myTeam = e.teamId
      for (const f of sim._flags.values()) {
        if (f.carrierNid === (sim.mySmoothId) ) carrying = true
        if (f.team === myTeam) ownFlag = { state: f.state, x: f.x, z: f.z }
      }
      const dist = Math.hypot(e.x - tx, e.z - tz)
      return { x: e.x, z: e.z, myTeam, carrying, ownFlag, dist }
    }, { tx: T0.x, tz: T0.z })
    if (st) {
      if (st.carrying) report.grabbed = true
      if (st.dist < report.minDist) report.minDist = st.dist
      if (st.dist < 2.0) { report.reachedStand = true; report.ownFlagStateAtStand = st.ownFlag && st.ownFlag.state }
    }
    if (events.some(e => e.kind === 3)) { report.captured = true; break } // FLAG_CAPTURED
    await sleep(300)
  }
  report.minDist = +report.minDist.toFixed(2)
  report.events = events
  report.capdiagLines = (serverLog.match(/\[capdiag\][^\n]*/g) || []).slice(-12)
  console.log(JSON.stringify(report, null, 2))
} catch (e) { console.error('ERR', e.message) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(400)
}
