// One-off visual capture for the third-person body + held-weapon integration.
// Joins as a real client, finds the nearest bot, points the camera at it, and
// grabs screenshots after letting bots move/shoot/die for a bit.
import puppeteer from 'puppeteer-core'
import os from 'os'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
let CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 750 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 30000 }
  )
  // dismiss the entry overlay so the scene is visible (pointer lock won't engage
  // headless, but hiding the overlay + marking arena-entered reveals the canvas)
  await page.evaluate(() => {
    const ov = document.getElementById('entry-overlay')
    if (ov) ov.classList.remove('is-visible')
    document.body.classList.add('arena-entered')
    const s = document.getElementById('settings-menu')
    if (s) s.classList.add('settings-closed')
    document.body.classList.remove('menu-open')
  })

  // give models + weapons time to load and bots time to spread out
  await sleep(4000)

  // Aim our camera at the nearest other player each frame via a small injected loop.
  const framed = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const me = sim.myRawEntity
    const skip = new Set([sim.myRawId, sim.mySmoothId])
    let best = null, bestD = Infinity
    window.gameClient.client.entities.forEach((e) => {
      if (e.hitpoints === undefined || skip.has(e.nid)) return
      const d = Math.hypot(e.x - me.x, e.z - me.z)
      if (d < bestD) { bestD = d; best = e }
    })
    if (!best) return null
    // stand a fixed distance from the target and look at it
    const cam = sim.renderer.camera
    const ang = Math.atan2(best.x - me.x, best.z - me.z)
    const dist = 3.2
    me.x = best.x - Math.sin(ang) * dist
    me.z = best.z - Math.cos(ang) * dist
    cam.position.x = me.x; cam.position.z = me.z; cam.position.y = 0.4
    cam.rotation.y = ang
    cam.rotation.x = 0.05
    window.__target = best.nid
    return { nid: best.nid, tx: best.x, tz: best.z, weapon: best.currentWeaponIndex, dist: bestD }
  })
  console.log('framed target:', JSON.stringify(framed))

  // Neutralize everything that fights our spectator camera: dispose the FP
  // viewmodel (so it can't re-enable on respawn), and install a rAF keep-alive
  // that pins our HP/isAlive and clears the death cam every frame.
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    if (sim.viewmodel && sim.viewmodel.dispose) { try { sim.viewmodel.dispose() } catch (e) {} }
    sim.viewmodel = null
    sim._specLoop = () => {
      const me = sim.myRawEntity
      if (me) { me.isAlive = true; me.hitpoints = 100 }
      sim.fragLayer.onRespawned()
      document.body.classList.remove('player-dead')
      const cs = document.getElementById('combat-state')
      if (cs) cs.classList.add('combat-state-hidden')
      requestAnimationFrame(sim._specLoop)
    }
    requestAnimationFrame(sim._specLoop)
  })

  // PIN a target bot in place (freeze its position via rAF) so we get stable,
  // unoccluded framing. We choose a target near open space, then orbit our camera.
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const me = sim.myRawEntity
    const skip = new Set([sim.myRawId, sim.mySmoothId])
    let best = null, bestD = Infinity
    window.gameClient.client.entities.forEach((e) => {
      if (e.hitpoints === undefined || skip.has(e.nid)) return
      if (e.isAlive === false) return
      const d = Math.hypot(e.x - me.x, e.z - me.z)
      if (d < bestD) { bestD = d; best = e }
    })
    if (!best) return
    window.__target = best.nid
    // pin to a KNOWN-OPEN spot (arenaConfig has no obstacle near (0, 8)); the
    // nearest crate is at (-5,9), so the body stands clear for framing.
    window.__pin = { x: 0, y: 0, z: 8 }
    sim._pinLoop = () => {
      const t = window.gameClient.client.entities.get(window.__target)
      if (t && window.__pin) { t.x = window.__pin.x; t.y = window.__pin.y; t.z = window.__pin.z; t.isAlive = true }
      // keep the live FragLayer from stealing our pinned model for a real death
      if (!window.__allowCorpse && sim.fragLayer._corpses.has(window.__target)) {
        sim.fragLayer._corpses.delete(window.__target)
      }
      requestAnimationFrame(sim._pinLoop)
    }
    requestAnimationFrame(sim._pinLoop)
  })
  await sleep(500)

  // helper: park our camera at azimuth `az` (radians, around the target) at `dist`,
  // aimed at the target's body center, then render + screenshot.
  const orbitShot = async (az, dist, file, label) => {
    await page.evaluate(({ az, dist }) => {
      const sim = window.gameClient.simulator
      const me = sim.myRawEntity
      const p = window.__pin
      const cam = sim.renderer.camera
      cam.fov = 0.85
      me.x = p.x - Math.sin(az) * dist
      me.z = p.z - Math.cos(az) * dist
      me.y = 0.25
      cam.position.set(me.x, me.y, me.z)
      // aim at a FIXED chest height above the pin — stable across shoot/death poses
      // (dynamic bounding-box centers swing wildly when the body lies flat)
      const ty = 0.0
      const V = me.mesh.position.constructor
      if (cam.setTarget) cam.setTarget(new V(p.x, ty, p.z))
      cam.rotation.z = 0
      sim.renderer.scene.render()
    }, { az, dist })
    await sleep(60)
    await page.screenshot({ path: file })
    console.log(`${label}: ${file}`)
  }

  // locomotion/idle profile from several angles (target is pinned; its clip is
  // whatever locomotion it's on — usually Idle once frozen, sometimes Run residual)
  await orbitShot(0.6, 2.0, '/tmp/tp-integration-0.png', 'front-right')
  await orbitShot(Math.PI * 0.5, 2.0, '/tmp/tp-integration-1.png', 'right-side')
  await orbitShot(Math.PI + 0.4, 2.2, '/tmp/tp-integration-2.png', 'back')
  await orbitShot(-0.6, 2.0, '/tmp/tp-integration-3.png', 'front-left')

  // force a shoot one-shot and capture the recoil pose (retrigger a few times to
  // land mid-clip; use the same working front-right azimuth)
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => {
      const m = window.gameClient.simulator.characterModels.get(window.__target)
      if (m) m.playShoot()
    })
    await sleep(90)
  }
  await orbitShot(0.6, 2.0, '/tmp/tp-integration-shoot.png', 'shoot-pose')

  // death clip: setCorpse -> plays Death once, freezes on last frame. Allow the
  // pin loop to stop scrubbing corpse state, and force our own setCorpse.
  await page.evaluate(() => {
    window.__allowCorpse = true
    const m = window.gameClient.simulator.characterModels.get(window.__target)
    if (m) m.setCorpse(true)
  })
  await sleep(900)
  // lower, closer camera so a lying/collapsed corpse pose is in frame
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const me = sim.myRawEntity, p = window.__pin, cam = sim.renderer.camera
    cam.fov = 0.9
    const az = 0.6, dist = 2.2
    me.x = p.x - Math.sin(az) * dist; me.z = p.z - Math.cos(az) * dist; me.y = 0.15
    cam.position.set(me.x, me.y, me.z)
    const V = me.mesh.position.constructor
    cam.setTarget(new V(p.x, -0.35, p.z)) // aim at the floor where the corpse lies
    cam.rotation.z = 0
    sim.renderer.scene.render()
  })
  await sleep(60)
  await page.screenshot({ path: '/tmp/tp-integration-death.png' })
  console.log('death-clip: /tmp/tp-integration-death.png')
  const deathState = await page.evaluate(() => {
    const m = window.gameClient.simulator.characterModels.get(window.__target)
    return m ? { usingDeathClip: m._usingDeathClip, corpse: m._corpse } : null
  })
  console.log('death state (in corpse):', JSON.stringify(deathState))

  // leave corpse mode -> should cleanly reset to idle for respawn reuse
  const resetState = await page.evaluate(() => {
    window.__allowCorpse = false
    const m = window.gameClient.simulator.characterModels.get(window.__target)
    if (m) m.setCorpse(false)
    return m ? { usingDeathClip: m._usingDeathClip, corpse: m._corpse, current: m.current && m.current.name } : null
  })
  console.log('reset state:', JSON.stringify(resetState))
  await orbitShot(0.6, 2.0, '/tmp/tp-integration-respawn.png', 'post-respawn-reset')

  // report what we saw about the model + weapon in-scene
  const introspect = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const nid = window.__target
    const model = sim.characterModels.get(nid)
    if (!model) return { hasModel: false }
    const out = {
      hasModel: true,
      ready: model.ready,
      weaponIndex: model._weaponIndex,
      hasWeaponRoot: !!model._weaponRoot,
      handNode: model._handNode() ? model._handNode().name : null,
      groups: Object.keys(model.groups),
      current: model.current ? model.current.name : null,
    }
    if (model.holder) {
      const bb = model.holder.getHierarchyBoundingVectors()
      out.holderHeight = +(bb.max.y - bb.min.y).toFixed(3)
      out.holderYawDeg = +((model.holder.rotation.y * 180 / Math.PI) % 360).toFixed(1)
    }
    return out
  })
  console.log('model introspect:', JSON.stringify(introspect, null, 2))
  console.log('page errors:', errors.length ? errors.join(' | ') : 'none')
} catch (e) {
  console.error('CAPTURE FAILED:', e.message)
} finally {
  await browser.close()
}
