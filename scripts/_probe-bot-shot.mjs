// Frame a remote player (bot) in the REAL game and screenshot it, so the third-person
// look can actually be EYEBALLED — helmet skin, held gun, uniform, and (when enabled)
// the armour fit. Freezes sim.update first: the simulator rebases the camera off the
// local player every frame and would otherwise stomp any framing we set.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const OUT = process.env.SHOT_OUT || '/tmp/bot_shot.png'
const MAP = process.env.MAP || 'grove'

const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  procs.push(p); return p
}

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP, BOTS: '1', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 820, height: 980 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => {
    const sp = document.getElementById('splash'); if (sp) sp.remove()
    const ov = document.getElementById('entry-overlay'); if (ov) ov.style.display = 'none'
    window.gameClient.simulator.requestDeploy()
  })
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await page.waitForFunction(() => {
    for (const m of window.gameClient.simulator.characterModels.values()) if (m.ready && m.host) return true
    return false
  }, { timeout: 45000 })
  await sleep(5000) // helmet / weapon / armour finish their async mounts

  // Framing, the way that actually holds: do NOT fight the simulator for its own camera
  // (it rebases that one off the local player every frame, and the viewmodel is parented
  // to it). Instead stand up a SECOND camera and make it the scene's active one — the sim
  // can keep driving its camera into the void for all we care. scene.activeCameras (the
  // plural multi-pass list) has to be cleared too or Babylon renders that list instead.
  // Framing, take three. Fighting the simulator for its camera does not work: it owns
  // scene.activeCamera and rebases it from the local player inside the RENDER loop, not
  // sim.update, so both set the camera and swap in my own camera get overwritten
  // before the next frame is drawn. So do the opposite — freeze sim.update (which also
  // freezes CharacterModel.update, so the model stops being driven from its host) and
  // then simply PUT THE BOT in front of the camera that already exists. The viewmodel is
  // parented to that camera, so it is disabled outright or it fills the frame.
  const frame = (dist) => page.evaluate((d) => {
    const sim = window.gameClient.simulator
    let model = null
    for (const m of sim.characterModels.values()) { if (m.ready && m.host) { model = m; break } }
    if (!model || !model.holder) return { err: 'no model' }
    sim.update = () => {}
    if (sim.viewmodel && sim.viewmodel.holder) sim.viewmodel.holder.setEnabled(false)
    const cam = sim.renderer.camera
    const fwd = cam.getDirection(new BABYLON.Vector3(0, 0, 1))
    // stand the body d metres down the camera's view axis, dropped so the torso is centred
    model.holder.position.set(
      cam.position.x + fwd.x * d,
      cam.position.y + fwd.y * d - 1.0,
      cam.position.z + fwd.z * d)
    model.holder.rotation.y = Math.atan2(-fwd.x, -fwd.z)   // face the camera
    if (model._nameTag) model._nameTag.style.display = 'none'
    for (const id of ['hud', 'crosshair', 'touch-controls', 'objective-hud', 'splash', 'entry-overlay']) {
      const el = document.getElementById(id); if (el) el.style.display = 'none'
    }
    return { camAt: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
             botAt: [+model.holder.position.x.toFixed(2), +model.holder.position.y.toFixed(2), +model.holder.position.z.toFixed(2)] }
  }, dist)

  const info = await page.evaluate((dist) => {
    const sim = window.gameClient.simulator
    let model = null
    for (const m of sim.characterModels.values()) { if (m.ready && m.host) { model = m; break } }
    const mats = []
    const push = (label, root) => {
      if (!root) return
      for (const m of [root, ...root.getChildMeshes()]) {
        if (!m.material) continue
        const mt = m.material
        mats.push({
          part: label, mat: mt.name,
          metallic: typeof mt.metallic === 'number' ? +mt.metallic.toFixed(2) : null,
          roughness: typeof mt.roughness === 'number' ? +mt.roughness.toFixed(2) : null,
          hasAlbedo: !!(mt.albedoTexture || mt.diffuseTexture),
          hasEmissiveTex: !!mt.emissiveTexture,
          emissive: mt.emissiveColor ? [+mt.emissiveColor.r.toFixed(2), +mt.emissiveColor.g.toFixed(2), +mt.emissiveColor.b.toFixed(2)] : null,
          metallicTex: !!mt.metallicTexture,
        })
      }
    }
    push('helmet', model._helmetRoot)
    push('weapon', model._weaponRoot)
    ;(model._armorRoots || []).forEach((r, i) => push('armor' + i, r))
    return { armorCount: (model._armorRoots || []).length, mats }
  }, parseFloat(process.env.SHOT_DIST || '2.3'))

  // re-assert the framing immediately before the shot: the bot keeps roaming, and the
  // renderer may have re-claimed scene.activeCamera in the meantime.
  const framed = await frame(parseFloat(process.env.SHOT_DIST || '2.3'))
  await sleep(700)
  await frame(parseFloat(process.env.SHOT_DIST || '2.3'))
  await sleep(250)
  await page.screenshot({ path: OUT })
  info.framed = framed
  console.log(JSON.stringify({ ...info, out: OUT, errors: errors.slice(0, 5) }, null, 2))
} catch (e) {
  console.error('ERR', e.message, e.stack)
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
