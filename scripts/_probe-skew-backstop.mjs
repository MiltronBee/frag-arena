// RESPAWN-SKEW BACKSTOP probe (2026-07-24). Directly constructs the leak state the
// intermittent CCW skew leaves behind — death-cam ACTIVE while the player is ALIVE
// with BOTH reset edges already missed — and asserts the new level-triggered backstop
// in Simulator.update (isAlive && deathCam.active && age>1s -> onRespawned) clears the
// roll. This is deterministic: it does NOT rely on a bot landing a kill (the reason the
// old _probe-respawn-skew sat at hp 100 and observed 0 respawns).
//
// The stuck state is built exactly as the real miss produces it:
//   - _startDeathCam() with a backdated t0 (a real stuck cam has an OLD t0 — the player
//     was dead through the full respawn delay), so the age gate is satisfied.
//   - _wasDead=false while myRawEntity.isAlive stays true, so the isAlive edge in
//     _updateHud can NOT fire (dead === _wasDead === false). No Respawned message is
//     injected either. So ONLY the new backstop can clear the roll.
// PASS = within ~0.5s the roll returns to ~0 AND _deathCam.active is false, with no
// console errors.
import { spawn } from 'child_process'
import { execSync } from 'child_process'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => { try { execSync(`ss -ltn | grep -q ':${p} '`); return true } catch { return false } }
const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  procs.push(p); return p
}

let failed = false, browser = null
try {
  const t0 = Date.now()
  while ((portBusy(8078) || portBusy(8079)) && Date.now() - t0 < 120000) { await sleep(5000) }
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'grove', BOTS: '0' }, 'server')
  const ownVite = !portBusy(8080)
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await sleep(1500)

  // A/B within one run. Both phases build the SAME illegal state (death-cam active while
  // alive, both reset edges disarmed). They differ only in the death-cam AGE:
  //   Phase A: fresh t0 -> age gate NOT met -> backstop must NOT fire (mimics old code) ->
  //            the roll PERSISTS. Proves the leak is real AND the sampler captures it.
  //   Phase B: backdated t0 -> age gate met -> backstop fires -> the roll CLEARS. Proves the fix.
  const result = await page.evaluate(async () => {
    const sim = window.gameClient.simulator
    const cam = sim.renderer.camera
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    async function runPhase(backdateMs) {
      sim.fragLayer.onRespawned()          // clean slate
      sim._wasDead = false                 // disarm the isAlive edge exactly as a miss leaves it
      sim.myRawEntity.isAlive = true
      sim.fragLayer._startDeathCam(sim.myRawId || 0)
      if (backdateMs) sim.fragLayer._deathCam.t0 = performance.now() - backdateMs
      await sleep(400)                     // let the ease ramp + the update loop run its backstop
      return { z: cam.rotation.z, active: sim.fragLayer._deathCam.active }
    }

    const stuck = await runPhase(0)        // age gate NOT satisfied -> should stay rolled
    const fixed = await runPhase(3000)     // age gate satisfied -> backstop clears it
    sim.fragLayer.onRespawned()            // leave the client level
    return { stuck, fixed }
  })

  const leakReproduced = Math.abs(result.stuck.z) > 0.1 && result.stuck.active === true
  const leakClosed = Math.abs(result.fixed.z) < 0.02 && result.fixed.active === false
  const ok = leakReproduced && leakClosed && errors.length === 0
  console.log(JSON.stringify({
    ...result, leakReproduced, leakClosed, pageErrors: errors.slice(0, 3),
    verdict: ok ? 'PASS' : 'FAIL',
  }, null, 2))
  failed = !ok
} catch (e) {
  console.error('PROBE ERROR:', e.message); failed = true
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
  await sleep(400)
  spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
  await sleep(400)
}
process.exit(failed ? 1 : 0)
