// Deterministic close-up capture of the third-person body + held weapon.
// Run the stack with BOTS=0 first. Opens TWO real clients: page B stands at
// spawn as the photo subject (switching weapons 1-4), page A parks its camera
// a body-length away and screenshots each weapon from the side and front.
import puppeteer from 'puppeteer-core'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
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
  const photographer = await openClient()
  const subject = await openClient()
  await sleep(4000) // models/props load

  const shot = async (az, dist, file, label) => {
    await photographer.evaluate(({ az, dist }) => {
      const sim = window.gameClient.simulator
      const cam = sim.renderer.camera
      if (sim.viewmodel && !window.__vmGone) { sim.viewmodel.dispose?.(); window.__vmGone = true }
      let target = null
      for (const [nid, e] of window.gameClient.client.entities) {
        if (e !== sim.myRawEntity && e !== sim.mySmoothEntity && e.mesh) { target = e }
      }
      if (!target) return 'NO TARGET'
      const me = sim.myRawEntity
      me.x = target.x - Math.sin(az) * dist
      me.z = target.z - Math.cos(az) * dist
      me.y = 0.15
      cam.fov = 0.85
      cam.position.set(me.x, me.y, me.z)
      const V = target.mesh.position.constructor
      cam.setTarget(new V(target.x, 0, target.z))
      cam.rotation.z = 0
      sim.renderer.scene.render()
    }, { az, dist })
    await sleep(80)
    await photographer.screenshot({ path: file })
    console.log(`${label}: ${file}`)
  }

  // key events are pointer-lock gated headless; drive the switch API directly
  const weaponOrder = ['rifle', 'smg', 'shotgun', 'pistol']
  for (const [index, name] of weaponOrder.entries()) {
    await subject.evaluate((i) => window.gameClient.simulator.switchWeapon(i), index)
    await sleep(1500) // swap + prop load/clone
    const state = await photographer.evaluate(() => {
      const sim = window.gameClient.simulator
      for (const [nid, e] of window.gameClient.client.entities) {
        if (e.protocol?.name === 'PlayerCharacter' && e !== sim.myRawEntity && e !== sim.mySmoothEntity) {
          const cm = sim.characterModels.get(nid)
          return { nid, replicatedWeap: e.currentWeaponIndex, modelWeap: cm?._weaponIndex,
                   prop: cm?._weaponProp?.name ?? '(no prop field)' }
        }
      }
      return 'subject not visible'
    })
    console.log(`switch->${index} (${name}):`, JSON.stringify(state))
    await shot(Math.PI * 0.5, 1.4, `/tmp/closeup-${name}-side.png`, `${name} side`)
    await shot(0.5, 1.4, `/tmp/closeup-${name}-front.png`, `${name} front`)
  }
} finally {
  await browser.close()
}
