// REAL-GAME animation smoke check: find a bot that is actually VISIBLE (in range and
// not behind map geometry — a raycast decides, because "aim at the nearest bot" kept
// landing on one two rooms away), hold the look on it, and take 4 screenshots ~0.8s
// apart. Also samples a hand/foot bone's world offset per shot so "the pose moved" is
// a number as well as a picture.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const OUT = '/tmp/anim'
const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${String(d).slice(0, 160)}`))
  procs.push(p); return p
}

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: process.env.MAP || 'visage', BOTS: '4', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 10000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 120000,
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
  await sleep(7000)
  await page.evaluate(() => {
    for (const id of ['splash', 'entry-overlay']) { const el = document.getElementById(id); if (el) el.remove() }
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
    // ON-SCREEN test. The raycast LOS check was worthless: the map meshes are not
    // Babylon-pickable (collision lives in the sim, not the scene graph), so the only
    // thing a ray ever hit was the local player's own collider. So: project the bot's
    // chest to screen space and require it near the middle of the viewport at short
    // range, then just take a BURST and keep the frames where a body actually landed.
    window.__visibleBotsRaw = () => {
      const cam = sim.renderer.camera, scene = sim.renderer.scene
      const eng = scene.getEngine()
      const W = eng.getRenderWidth(), H = eng.getRenderHeight()
      const xf = scene.getTransformMatrix()
      const vp = cam.viewport.toGlobal(W, H)
      const out = []
      for (const [id, m] of sim.characterModels) {
        if (!m.ready || !m.holder) continue
        const a = m.holder.getAbsolutePosition()
        const chest = new BABYLON.Vector3(a.x, a.y + 1.1, a.z)
        const dist = BABYLON.Vector3.Distance(chest, cam.position)
        if (dist < 5.0 || dist > 45) continue
        const sp = BABYLON.Vector3.Project(chest, BABYLON.Matrix.Identity(), xf, vp)
        const onScreen = sp.z > 0 && sp.z < 1 && sp.x > W * 0.06 && sp.x < W * 0.94 && sp.y > H * 0.05 && sp.y < H * 0.95
        out.push({ id: String(id), p: { x: chest.x, y: chest.y, z: chest.z }, dist: +dist.toFixed(1),
          sx: Math.round(sp.x), sy: Math.round(sp.y), onScreen,
          blockedBy: onScreen ? null : 'offscreen',
          clip: m.current ? m.current.name : null })
      }
      out.sort((a, b) => a.dist - b.dist)
      return out
    }
    // per-bot pose fingerprint: hand + foot bone offsets relative to the root
    window.__pose = (id) => {
      const m = sim.characterModels.get(Number(id)) || sim.characterModels.get(id)
      if (!m || !m.skeleton) return null
      const root = m.holder.getAbsolutePosition()
      const pick = (re) => {
        const b = m.skeleton.bones.find(x => re.test(x.name))
        if (!b) return null
        const n = (b.getTransformNode && b.getTransformNode()) || b._linkedTransformNode
        if (!n) return null
        const w = n.getAbsolutePosition()
        return [+(w.x - root.x).toFixed(3), +(w.y - root.y).toFixed(3), +(w.z - root.z).toFixed(3)]
      }
      return { clip: m.current ? m.current.name : null,
        frame: m.current && m.current.animatables[0] ? +m.current.animatables[0].masterFrame.toFixed(1) : null,
        hand: pick(/hand_r|righthand|hand\.r/i), foot: pick(/foot_r|rightfoot|foot\.r/i) }
    }
  })

  // Burst: shoot EVERY tick a bot is on screen and record which bot it was, then pick
  // the frames that share an id. Locking onto one subject up front kept starving —
  // bots leave the sightline within a second and the run would end with nothing.
  const shots = []
  let n = 0
  for (let tick = 0; tick < 220 && n < 18; tick++) {
    const all = await page.evaluate(() => {
      const v = window.__visibleBotsRaw()
      if (v.length) window.__aim = v[0].p
      return v
    })
    const t = all[0]
    if (!t || !t.onScreen) { await sleep(300); continue }
    await sleep(120)
    n++
    await page.screenshot({ path: `${OUT}_bot_${String(n).padStart(2, '0')}.png` })
    shots.push({ n, id: t.id, dist: t.dist, pose: await page.evaluate(id => window.__pose(id), t.id) })
    await sleep(900)
  }
  console.log(JSON.stringify({ taken: n, shots, errors: errors.slice(0, 5) }, null, 1))
} catch (e) { console.error('ERR', e.message, e.stack) } finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
