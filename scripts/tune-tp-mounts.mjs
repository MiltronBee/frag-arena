// Live tuning harness for third-person weapon mounts. Opens a photographer +
// subject client pair (stack must be running with BOTS=0), switches the subject
// to a weapon, optionally applies a candidate transform to the mounted prop
// IN-PLACE (no rebuild), and screenshots side/front/grip framings.
//
//   node scripts/tune-tp-mounts.mjs <weaponIndex> ['{"position":{...},"rotation":{...},"scale":0.018}']
//
// Without a transform arg it shoots whatever the manifest currently produces.
import puppeteer from 'puppeteer-core'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const weaponIndex = parseInt(process.argv[2] ?? '0', 10)
const override = process.argv[3] ? JSON.parse(process.argv[3]) : null
const names = ['rifle', 'smg', 'shotgun', 'pistol']
const name = names[weaponIndex] || `w${weaponIndex}`

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

const openClient = async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 750 })
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 30000 }
  )
  await page.evaluate(() => {
    const ov = document.getElementById('entry-overlay')
    if (ov) ov.classList.remove('is-visible')
    document.body.classList.add('arena-entered')
    const s = document.getElementById('settings-menu')
    if (s) s.classList.add('settings-closed')
    document.body.classList.remove('menu-open')
  })
  return page
}

try {
  // NOTE: open the SUBJECT first, then the PHOTOGRAPHER. There is a known
  // late-joiner invisibility bug where an earlier client never sees a later
  // joiner's entity. So the photographer must be the LAST to join for it to
  // see (and screenshot) the subject's character model.
  const subject = await openClient()
  const photographer = await openClient()

  // wait until the photographer actually SEES the subject's character model
  await photographer.waitForFunction(() => {
    const sim = window.gameClient.simulator
    for (const [nid, e] of window.gameClient.client.entities) {
      if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity) {
        const cm = sim.characterModels.get(nid)
        return !!(cm && cm.ready)
      }
    }
    return false
  }, { timeout: 30000 })

  await subject.evaluate((i) => window.gameClient.simulator.switchWeapon(i), weaponIndex)

  // NOTE: a separate open bug prevents currentWeaponIndex from replicating to
  // remote observers (the photographer perpetually sees weapon 0 on the subject).
  // For mount tuning we only need the correct PROP mounted on the photographer's
  // view of the subject, so drive the subject's CharacterModel.setWeapon() on the
  // photographer directly instead of waiting on the broken replication.
  await photographer.evaluate((idx) => {
    const sim = window.gameClient.simulator
    for (const [nid, e] of window.gameClient.client.entities) {
      if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity) {
        const cm = sim.characterModels.get(nid)
        if (cm) cm.setWeapon(idx)
      }
    }
  }, weaponIndex)

  // wait for the prop clone to land on the model
  await photographer.waitForFunction((idx) => {
    const sim = window.gameClient.simulator
    for (const [nid, e] of window.gameClient.client.entities) {
      if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity) {
        const cm = sim.characterModels.get(nid)
        return cm?._weaponIndex === idx && !!cm?._weaponRoot
      }
    }
    return false
  }, { timeout: 20000 }, weaponIndex)
  await sleep(500) // let textures settle

  if (override) {
    await photographer.evaluate((o) => {
      const sim = window.gameClient.simulator
      for (const [nid, e] of window.gameClient.client.entities) {
        if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity) {
          const w = sim.characterModels.get(nid)._weaponRoot
          if (o.scale != null) w.scaling.setAll(o.scale)
          if (o.position) w.position.set(o.position.x, o.position.y, o.position.z)
          if (o.rotation) { w.rotationQuaternion = null; w.rotation.set(o.rotation.x, o.rotation.y, o.rotation.z) }
        }
      }
    }, override)
    console.log(`override applied: ${JSON.stringify(override)}`)
  }

  const shot = async (az, dist, targetY, file, label) => {
    const info = await photographer.evaluate(({ az, dist, targetY }) => {
      const sim = window.gameClient.simulator
      const cam = sim.renderer.camera
      if (sim.viewmodel && !window.__vmGone) { sim.viewmodel.dispose?.(); window.__vmGone = true }
      let target = null
      for (const [nid, e] of window.gameClient.client.entities) {
        if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity && e.mesh) target = e
      }
      if (!target) return 'NO TARGET'
      const me = sim.myRawEntity
      me.x = target.x - Math.sin(az) * dist
      me.z = target.z - Math.cos(az) * dist
      me.y = targetY
      cam.fov = 0.85
      cam.position.set(me.x, me.y, me.z)
      const V = target.mesh.position.constructor
      cam.setTarget(new V(target.x, targetY, target.z))
      cam.rotation.z = 0
      sim.renderer.scene.render()
      return 'ok'
    }, { az, dist, targetY })
    await sleep(120)
    await photographer.screenshot({ path: file })
    console.log(`${label}: ${file} (${info})`)
  }

  // subject faces +Z-ish at spawn; side = from +X, front-quarter, and a tight grip shot
  await shot(Math.PI * 0.5, 1.5, 0.55, `/tmp/tune-${name}-side.png`, `${name} side`)
  await shot(Math.PI * 0.25, 1.5, 0.55, `/tmp/tune-${name}-quarter.png`, `${name} quarter`)
  await shot(Math.PI * 0.5, 0.8, 0.6, `/tmp/tune-${name}-grip.png`, `${name} grip`)
} finally {
  await browser.close()
}
