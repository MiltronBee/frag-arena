// REAL-GAME visual proof: floor weapon pickups + a running bot, screenshotted.
// The simulator rebases the camera POSITION every frame inside the render loop, so
// framing by moving the camera is hopeless — but mouse-look writes camera.rotation.y
// directly (see Simulator: "the camera owns look yaw"), so aiming the LOCAL PLAYER'S
// HEAD at a target and holding it there with a timer works and survives the rebase.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const OUT = '/tmp/game'
const MAP = process.env.MAP || 'visage'
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
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP, BOTS: '4', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 10000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 750 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(7000) // async helmet/weapon/pickup mounts

  // the splash card stack sits OVER the canvas and would be the whole screenshot
  const nuke = () => page.evaluate(() => {
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
    document.querySelectorAll('#splash, .splash-card, #splash-overlay').forEach(e => e.remove())
  })
  await nuke()

  // hold the look direction on a world point until told otherwise
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    window.__aim = null
    window.__aimTimer = setInterval(() => {
      const t = window.__aim; if (!t) return
      const cam = sim.renderer.camera
      const dx = t.x - cam.position.x, dy = t.y - cam.position.y, dz = t.z - cam.position.z
      const len = Math.hypot(dx, dy, dz) || 1
      cam.rotation.y = Math.atan2(dx, dz)
      cam.rotation.x = -Math.asin(dy / len)
    }, 16)
  })

  const survey = () => page.evaluate(() => {
    const sim = window.gameClient.simulator
    const cam = sim.renderer.camera
    const cp = { x: cam.position.x, y: cam.position.y, z: cam.position.z }
    const d = (p) => Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z)
    const pickups = []
    const src = sim._pickups || sim.pickups
    if (src) for (const p of src.values()) {
      const m = p._pickupModel || p.model || p.mesh
      if (!m) continue
      const a = m.getAbsolutePosition()
      pickups.push({ p: { x: a.x, y: a.y, z: a.z }, dist: +d(a).toFixed(1), kind: p.kind || p.type || m.name })
    }
    const bots = []
    for (const [id, m] of sim.characterModels) {
      if (!m.holder) continue
      const a = m.holder.getAbsolutePosition()
      bots.push({ id: String(id), p: { x: a.x, y: a.y + 1.0, z: a.z }, dist: +d(a).toFixed(1), clip: m.current ? m.current.name : null, gun: !!m._weaponRoot })
    }
    pickups.sort((a, b) => a.dist - b.dist); bots.sort((a, b) => a.dist - b.dist)
    return { cam: cp, pickups, bots }
  })

  const aim = (p) => page.evaluate((p) => { window.__aim = p }, p)
  const shot = async (n) => { await page.screenshot({ path: `${OUT}_${n}.png` }) }

  let s = await survey()
  const log = { map: MAP, cam: s.cam, pickupCount: s.pickups.length, nearestPickups: s.pickups.slice(0, 5), bots: s.bots.slice(0, 5) }

  // ---- MISSION 3: floor weapon pickups
  const wantWeapon = s.pickups.filter(p => /gun|rifle|smg|shot|pistol|weapon/i.test(String(p.kind)))
  const targets = (wantWeapon.length ? wantWeapon : s.pickups).slice(0, 3)
  log.pickupShots = []
  for (let i = 0; i < targets.length; i++) {
    await aim(targets[i].p); await sleep(900)
    await shot(`pickup_${i}`)
    log.pickupShots.push(targets[i])
  }
  // walk toward the nearest one for a genuine closeup
  if (targets[0]) {
    await aim(targets[0].p)
    await page.evaluate(() => { const st = window.gameClient.simulator.input?._currentState; if (st) st.forwards = true })
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      s = await survey()
      const near = s.pickups.length ? s.pickups[0] : null
      if (near) await aim(near.p)
      if (near && near.dist < 3.0) break
    }
    await page.evaluate(() => { const st = window.gameClient.simulator.input?._currentState; if (st) st.forwards = false })
    await sleep(700)
    s = await survey()
    if (s.pickups[0]) await aim(s.pickups[0].p)
    await sleep(800)
    await shot('pickup_close')
    log.closest = s.pickups.slice(0, 3)
  }

  // ---- MISSION 4: a running bot, 3 frames ~1s apart
  log.botShots = []
  for (let attempt = 0; attempt < 12; attempt++) {
    s = await survey()
    const b = s.bots.find(x => x.dist > 3 && x.dist < 40)
    if (!b) { await sleep(1500); continue }
    await aim(b.p); await sleep(700)
    const track = async (n) => {
      const cur = await survey()
      const me = cur.bots.find(x => x.id === b.id)
      if (me) await aim(me.p)
      await sleep(250)
      await shot(n)
      return me
    }
    const a1 = await track('bot_1'); await sleep(800)
    const a2 = await track('bot_2'); await sleep(800)
    const a3 = await track('bot_3')
    log.botShots = [a1, a2, a3]
    break
  }
  log.errors = errors.slice(0, 6)
  console.log(JSON.stringify(log, null, 1))
} catch (e) { console.error('ERR', e.message, e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
