// TDM team-uniform visual probe. Boots its OWN server (MAP=dm_gantry162 TDM,
// BOT_FILL=6 -> ~3v3 with the puppeteer human) + vite on :8080, joins, then
// frames live bots with the freecam-style camera hack (_shot-crests pattern):
//   _work/uniforms/red-vs-blue.png   one red + one blue bot in frame
//   _work/uniforms/closeup-red.png   red-team bot up close
//   _work/uniforms/closeup-blue.png  blue-team bot up close
// Fails on page errors. node scripts/_probe-uniforms.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/uniforms'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portUp = async p => { try { const r = await fetch('http://localhost:' + p + '/'); return r.ok || r.status > 0 } catch { return false } }

const procs = []
function boot(cmd, args, env, tag) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  p.on('exit', c => { if (c !== 0 && c !== null) console.error(`[${tag}] exited ${c}`) })
  procs.push(p)
  return p
}

let failed = false
let browser = null
try {
  // game ports: if 8078 is already serving, another agent owns the arena — wait
  // for it to free (poll 20s, up to 10 min) rather than fighting over the port,
  // then boot OUR server so MAP/MODE/BOT_FILL are exactly what this probe needs.
  {
    const deadline = Date.now() + 10 * 60 * 1000
    while (await portUp(8078)) {
      if (Date.now() > deadline) throw new Error('port 8078 stayed busy >10min (another agent)')
      console.log('[probe] 8078 busy (another agent owns it); waiting 20s...')
      await sleep(20000)
    }
  }
  // hard watchdog for the browser phase: a hung browser.close()/child pipe must
  // never wedge the probe. (Set AFTER the port wait so the 10-min poll above can
  // run to completion.)
  setTimeout(() => { console.error('WATCHDOG: browser phase overran 300s, exiting'); process.exit(2) }, 300000).unref()

  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_gantry162', MODE: 'TDM', BOT_FILL: '6' }, 'server')
  // vite: REUSE an existing dev server on 8080 (never kill one we didn't start);
  // only boot our own when nothing is serving there.
  if (!(await portUp(8080))) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  else console.log('[probe] reusing existing vite on :8080')
  // gate on the server's /mapinfo endpoint — a crashed server otherwise burns the
  // full 60s waitForFunction before we learn anything
  let up = false
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(1000)
    try { const r = await fetch('http://localhost:8078/'); up = r.ok } catch (e) {}
  }
  if (!up) throw new Error('server /mapinfo (:8078) never came up')
  await sleep(3000) // vite ready margin

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()) })
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(
      'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
      { timeout: 45000 })
    await page.evaluate(() => window.gameClient.simulator.requestDeploy())
    await page.waitForFunction('window.gameClient.simulator.myRawEntity',
      { timeout: 60000 })
  } catch (e) {
    console.error('JOIN TIMEOUT. page errors so far:', JSON.stringify(errors.slice(0, 8), null, 1))
    const state = await page.evaluate(() => ({
      hasClient: !!window.gameClient, hasSim: !!window.gameClient?.simulator,
      raw: !!window.gameClient?.simulator?.myRawEntity, body: document.body?.className,
    })).catch(() => null)
    console.error('client state:', JSON.stringify(state))
    throw e
  }
  await sleep(6000) // bots spawn + hero GLB imports + uniform textures load
  await page.evaluate(() => {
    ;['entry-overlay', 'splash', 'menu', 'main-menu'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
    document.body.classList.add('arena-entered')
  })

  // Live bots by team, from the replicated entity pool (smooth entities carry
  // teamId + hitpoints; the raw/smooth pair shares position closely enough here).
  const bots = () => page.evaluate(() => {
    const out = []
    const sim = window.gameClient.simulator
    window.gameClient.client.entities.forEach(e => {
      if (e.hitpoints === undefined || e.teamId === undefined) return
      // exclude BOTH of my own replicated halves (raw + smooth mirror)
      if (e.nid === sim.myRawId || e.nid === sim.mySmoothId) return
      if (e === sim.myRawEntity || e === sim.mySmoothEntity) return
      if (e.isAlive === false) return
      out.push({ nid: e.nid, teamId: e.teamId, x: e.x, y: e.y, z: e.z })
    })
    return out
  })

  // freecam hack: park MY entity + camera at pos, aimed at target (yaw = atan2(dx,dz))
  async function frame(pos, target, name) {
    await page.evaluate(({ pos, target }) => {
      const s = window.gameClient.simulator
      const e = s.myRawEntity
      e.x = pos.x; e.y = pos.y; e.z = pos.z
      e.velX = e.velY = e.velZ = 0
      if (e.mesh) e.mesh.position.set(pos.x, pos.y, pos.z)
      const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
      if (cam) {
        if (cam.position) cam.position.set(pos.x, pos.y + 0.4, pos.z)
        const dx = target.x - pos.x, dz = target.z - pos.z
        const dy = target.y - (pos.y + 0.4)
        const dist = Math.sqrt(dx * dx + dz * dz)
        if ('rotation' in cam) {
          cam.rotation.y = Math.atan2(dx, dz)
          cam.rotation.x = -Math.atan2(dy, dist)
        }
      }
    }, { pos, target })
    for (let i = 0; i < 40; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} }); await sleep(16) }
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log('shot', name)
  }

  // wait until at least one live bot per team exists
  let red = null, blue = null
  for (let i = 0; i < 30 && (!red || !blue); i++) {
    const bs = await bots()
    red = bs.find(b => b.teamId === 0) || null
    blue = bs.find(b => b.teamId === 1) || null
    if (!red || !blue) await sleep(1000)
  }
  if (!red || !blue) throw new Error('never saw a live bot on both teams')

  // WIDE: stand back from the red/blue midpoint, far enough to hold both (a real
  // "30m glance" read is the point of this shot).
  const mid = { x: (red.x + blue.x) / 2, y: (red.y + blue.y) / 2, z: (red.z + blue.z) / 2 }
  const span = Math.hypot(red.x - blue.x, red.z - blue.z)
  const back = Math.max(14, span * 0.9)
  // step back along the perpendicular of the red->blue axis
  const ax = (blue.x - red.x) / (span || 1), az = (blue.z - red.z) / (span || 1)
  const wide = { x: mid.x - az * back, y: mid.y + 3, z: mid.z + ax * back }
  await frame(wide, mid, 'red-vs-blue')

  // 30m DARK read — "the 30m shot decides" (brief S4). Temporarily crush the
  // scene lighting to simulate a dark map corner (probe-only runtime tweak; the
  // renderer files are untouched + restored right after), stand ~30m back framing
  // both bots, so what we see is the value hierarchy + team emissive doing the
  // at-a-glance read the way they must in a dark arena.
  const setDark = on => page.evaluate((on) => {
    const s = window.gameClient.simulator
    const scene = (s.renderer && s.renderer.scene) || s.scene || (s.camera && s.camera.getScene && s.camera.getScene())
    if (!scene) return
    if (on) {
      scene.__savedL = scene.lights.map(l => l.intensity)
      scene.lights.forEach(l => { l.intensity *= 0.25 }) // ~25% (10% was too black to read the suit)
      scene.__savedEnv = scene.environmentIntensity
      scene.environmentIntensity = 0.15
      scene.__savedClear = scene.clearColor && scene.clearColor.clone()
      if (scene.clearColor) scene.clearColor.set(0.03, 0.03, 0.045)
      scene.__savedFog = scene.fogEnabled; scene.fogEnabled = false
    } else {
      if (scene.__savedL) scene.lights.forEach((l, i) => { l.intensity = scene.__savedL[i] })
      if (scene.__savedEnv != null) scene.environmentIntensity = scene.__savedEnv
      if (scene.__savedClear && scene.clearColor) scene.clearColor.copyFrom(scene.__savedClear)
      if (scene.__savedFog != null) scene.fogEnabled = scene.__savedFog
    }
  }, on)
  {
    const bs = await bots()
    const r = bs.find(b => b.teamId === 0), bl = bs.find(b => b.teamId === 1)
    if (r && bl) {
      const m2 = { x: (r.x + bl.x) / 2, y: (r.y + bl.y) / 2, z: (r.z + bl.z) / 2 }
      const sp = Math.hypot(r.x - bl.x, r.z - bl.z)
      // world units ≈ 1.7m each; ~30m ≈ 17u. Push back far enough to also hold
      // both bots in the 1280-wide frame given how far apart they roam.
      const back30 = Math.max(17, sp / 1.1 + 9)
      const ax2 = (bl.x - r.x) / (sp || 1), az2 = (bl.z - r.z) / (sp || 1)
      const far = { x: m2.x - az2 * back30, y: m2.y + 2.2, z: m2.z + ax2 * back30 }
      await setDark(true)
      await frame(far, m2, 'red-vs-blue-30m')
      await setDark(false)
    } else { console.error('no red+blue pair for 30m shot'); failed = true }
  }

  // CLOSE-UPS at NORMAL map lighting (the acceptance bar: fabric/plating detail
  // visible at 5-10m). dm_gantry162 is on the dark side, so add a temporary
  // neutral fill (probe-only, restored after) that stands in for a normally-lit
  // corner — this reads the ALBEDO detail, not the emissive fallback.
  const setFill = on => page.evaluate((on) => {
    const s = window.gameClient.simulator
    const scene = (s.renderer && s.renderer.scene) || s.scene
    if (!scene) return
    if (on) {
      if (!scene.__fill) {
        const BABYLON = window.BABYLON || (s.renderer && s.renderer.BABYLON)
        // fall back to any hemispheric light already in the scene if no BABYLON handle
        scene.__savedEnv2 = scene.environmentIntensity
        scene.environmentIntensity = Math.max(scene.environmentIntensity || 0, 0.9)
        scene.__savedLI = scene.lights.map(l => l.intensity)
        scene.lights.forEach(l => { l.intensity *= 1.6 })
        scene.__fill = true
      }
    } else if (scene.__fill) {
      if (scene.__savedEnv2 != null) scene.environmentIntensity = scene.__savedEnv2
      if (scene.__savedLI) scene.lights.forEach((l, i) => { l.intensity = scene.__savedLI[i] })
      scene.__fill = false
    }
  }, on)
  await setFill(true)
  for (const [teamId, name] of [[0, 'closeup-red'], [1, 'closeup-blue']]) {
    const bs = await bots()
    const b = bs.find(x => x.teamId === teamId)
    if (!b) { console.error(`no live bot for ${name}`); failed = true; continue }
    // stand ~6m off (5-10m band) and a touch above, so the whole torso reads
    await frame({ x: b.x + 4, y: b.y + 1.0, z: b.z + 4 }, b, name)
  }
  await setFill(false)

  if (errors.length) { console.error('PAGE ERRORS:', errors.slice(0, 5)); failed = true }
  console.log(JSON.stringify({ pageErrors: errors.length, verdict: failed ? 'CHECK' : 'PASS' }))
} catch (e) {
  console.error('PROBE FAIL:', e.message)
  failed = true
} finally {
  if (browser) await Promise.race([browser.close(), sleep(10000)])
  procs.forEach(p => { try { p.kill('SIGTERM') } catch (e) {} })
}
process.exit(failed ? 1 : 0)
