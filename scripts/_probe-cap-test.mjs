// Deterministic HUMAN capture test via DEV_CAP_TEST server cheat (grants the enemy flag
// + teleports the client to their own home stand). Watches for FLAG_CAPTURED + [capdiag].
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => { const s = net.createConnection({ port: +p, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
let serverLog = ''; const procs = []
const boot = (cmd, args, env, tag, cap) => { const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); p.stdout.on('data', d => { const s = d.toString(); if (cap) serverLog += s; if (/capdiag|captest|objective|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) }); p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`)); procs.push(p); return p }
let browser = null
try {
  const t0 = Date.now(); while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '0', DEV_CAP_TEST: '1', CAPDIAG: '1' }, 'srv', true)
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] })
  const page = await browser.newPage(); await page.setViewport({ width: 800, height: 600 })
  const events = []
  await page.exposeFunction('__obj', e => events.push(e))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => { const sim = window.gameClient.simulator; sim.client.on('message::ObjectiveEvent', m => window.__obj({ kind: m.kind, team: m.team })); sim.requestDeploy() })
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  // hold still and wait for the cheat + capture (up to ~12s)
  await sleep(12000)
  const capdiag = (serverLog.match(/\[capdiag\][^\n]*/g) || []).slice(-8)
  const captest = (serverLog.match(/\[captest\][^\n]*/g) || [])
  const captured = events.some(e => e.kind === 3)
  console.log(JSON.stringify({ captured, events, captest, capdiag, verdict: captured ? 'CAPTURE_OK' : 'CAPTURE_FAILED' }, null, 2))
} catch (e) { console.error('ERR', e.message) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(400)
}
