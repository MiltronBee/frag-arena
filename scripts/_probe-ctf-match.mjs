// REAL-MATCH CTF observation: run CTF-Visage with a full bot roster and a single
// spectating human, and measure the thing a player actually feels —
//   "how often is MY OWN flag HOME?"  (you cannot score while it is out)
//   "does a carried flag ever get stuck on a bot forever?"
// A carrier that never scores and never dies pins the other team's flag out of play
// permanently, which reads exactly as "I can never capture".
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const RUN_MS = parseInt(process.env.RUN_MS || '180000', 10)
const BOTS = process.env.BOTS || '6'

let serverLog = ''
const procs = []
const boot = (cmd, args, env, tag, cap) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { const s = d.toString(); if (cap) serverLog += s })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  procs.push(p); return p
}

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS, MATCH_SECONDS: '3000' }, 'srv', true)
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  const events = []
  await page.exposeFunction('__obj', e => events.push({ ...e, t: Date.now() }))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    sim.client.on('message::ObjectiveEvent', m => window.__obj({ kind: m.kind, team: m.team }))
    sim.requestDeploy()
  })
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await sleep(3000)

  // sample flag state every 500ms
  const samples = []           // {t, s0, s1, c0, c1}
  const END = Date.now() + RUN_MS
  while (Date.now() < END) {
    const st = await page.evaluate(() => {
      const sim = window.gameClient.simulator
      const out = {}
      for (const f of sim._flags.values()) out['t' + f.team] = { state: f.state, carrier: f.carrierNid }
      return out
    })
    if (st.t0 && st.t1) samples.push({ t: Date.now(), s0: st.t0.state, c0: st.t0.carrier, s1: st.t1.state, c1: st.t1.carrier })
    await sleep(500)
  }

  const n = samples.length || 1
  const pct = (arr, v) => ((arr.filter(x => x === v).length / n) * 100).toFixed(1) + '%'
  const s0 = samples.map(s => s.s0), s1 = samples.map(s => s.s1)

  // longest unbroken CARRIED streak per flag (state 1), in seconds
  const longestCarry = (arr) => {
    let best = 0, cur = 0
    for (const v of arr) { if (v === 1) { cur++; best = Math.max(best, cur) } else cur = 0 }
    return (best * 0.5).toFixed(1) + 's'
  }
  const kinds = ['TAKEN', 'DROPPED', 'RETURNED', 'CAPTURED', 'DOM']
  const evCount = {}
  for (const e of events) { const k = kinds[e.kind] + '_team' + e.team; evCount[k] = (evCount[k] || 0) + 1 }

  console.log(JSON.stringify({
    runSeconds: RUN_MS / 1000, bots: BOTS, samples: n,
    flag0_RED_BONK: { home: pct(s0, 0), carried: pct(s0, 1), dropped: pct(s0, 2), longestCarry: longestCarry(s0) },
    flag1_BLUE_WIF: { home: pct(s1, 0), carried: pct(s1, 1), dropped: pct(s1, 2), longestCarry: longestCarry(s1) },
    events: evCount,
    totalCaptures: events.filter(e => e.kind === 3).length,
  }, null, 2))
} catch (e) {
  console.error('ERR', e.message, e.stack)
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
