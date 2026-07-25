// Verify both stuck-match fixes end-to-end (the 2026-07-24 lag incident):
//   PHASE A (ceiling, FIX 1a): CTF, BOTS=0, one idle human. 0-0 at the tie check ->
//     SUDDEN_DEATH with no possible frag or capture -> the 3:00 ceiling MUST end the
//     match (this exact state hung prod for 7+ hours).
//   PHASE B (overtime tie-break, FIX 1b): CTF, BOTS=2 (one per team). Frags are
//     scoreless in regulation -> 0-0 tie -> SUDDEN_DEATH -> the next enemy frag now
//     moves the score -> match ends organically, well before the ceiling.
// Run with MATCH_SECONDS=20 so regulation is 20s (tie check at 16s).
//
// NOTE: the match machine only runs once a human has connected (phase A idles one
// headless client in the arena for the full overtime window).
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']

async function runPhase(tag, bots, watchForMs, expect) {
  let log = ''
  const procs = []
  const boot = (cmd, args, env) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    p.stdout.on('data', d => { const s = d.toString(); log += s; if (/\[match\]/.test(s)) process.stdout.write(`[${tag}] ${s}`) })
    p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
    procs.push(p); return p
  }
  let browser = null
  try {
    const t0 = Date.now()
    while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(3000)
    boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: String(bots), MATCH_SECONDS: '20' })
    const ownVite = !(await portBusy(8080))
    if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {})
    await sleep(ownVite ? 9000 : 6000)

    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: CHROME_ARGS })
    const page = await browser.newPage()
    await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
    await page.evaluate(() => window.gameClient.simulator.requestDeploy())
    await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })

    const DEADLINE = Date.now() + watchForMs
    while (Date.now() < DEADLINE) {
      if (expect.every(e => log.includes(e))) break
      await sleep(1000)
    }
    const seen = expect.map(e => [e, log.includes(e)])
    const pass = seen.every(([, ok]) => ok)
    console.log(JSON.stringify({ phase: tag, pass, seen }, null, 1))
    return pass
  } finally {
    if (browser) await browser.close().catch(() => {})
    for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
    await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(1500)
  }
}

// PHASE A: tie-check ~16s in + 3:00 ceiling => give it 4:40 total.
const a = await runPhase('A-ceiling', 0, 280000,
  ['SUDDEN_DEATH — next frag wins', 'SUDDEN_DEATH ceiling reached', 'MATCH_END'])
// PHASE B: sudden death ~16s in, bots frag within a couple of engagements => 2:30 cap.
const b = await runPhase('B-tiebreak', 2, 150000,
  ['SUDDEN_DEATH — next frag wins', 'MATCH_END'])
// B must NOT have needed the ceiling — but a slow bot duel can legitimately take
// minutes, so only report (the hard assert is that the match ENDED).
console.log(JSON.stringify({ verdict: a && b ? 'PASS' : 'FAIL', A_ceiling: a, B_tiebreak: b }))
process.exit(a && b ? 0 : 1)
