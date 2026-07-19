// Join the running dev game (:8080) and screenshot the arena from a few yaws so we
// can eyeball the Facing Worlds layout (towers, pads, cover). Requires `npm start`.
import puppeteer from 'puppeteer-core'
import fs from 'fs'
const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const OUT = process.env.HOME + '/unreal/_work/map-shots'
fs.mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio','--window-size=1280,720',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errs = []
  page.on('pageerror', e => errs.push(String(e).slice(0,200)))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  // click through splash + main menu (Enter dismisses splash, PLAY enters the arena)
  await sleep(2500)
  await page.keyboard.press('Enter').catch(()=>{})
  await sleep(1200)
  await page.click('#enter-arena').catch(()=>{})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity', { timeout: 30000 })
  await sleep(1500) // settle onto floor + replicate obstacles

  // hide menu/splash overlays so the 3D view is visible
  await page.evaluate(() => ['entry-overlay','splash','menu','main-menu'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none' }))

  // lift the player onto a vantage point and look around by driving rawEntity yaw.
  // (client camera follows the controlled entity's transform.)
  const shots = []
  const views = [
    { name: 'natural-spawn', natural: true },
    { name: 'map-overview',  x: 4, z: -4, y: 32, yaw: 0, pitch: -1.1 },
    { name: 'map-eye',       x: -3.4, z: -3.6, y: 12.6, yaw: Math.PI/2, pitch: 0 },
    { name: 'map-eye2',      x: 4.4, z: 12.5, y: 10.6, yaw: Math.PI, pitch: 0 },
    { name: 'grotto',        x: -8.2, z: -10.5, y: 5.2, yaw: -Math.PI/2, pitch: -0.4 },
    { name: 'torch-hall',    x: 0.1, z: 22.3, y: -0.2, yaw: 0, pitch: -0.35 },
  ]
  for (const v of views) {
    await page.evaluate((v) => {
      if (v.natural) return // leave the player where the server spawned them
      const s = window.gameClient.simulator
      const e = s.myRawEntity
      e.x = v.x; e.z = v.z; e.y = v.y
      e.velX = e.velY = e.velZ = 0
      if (e.mesh) { e.mesh.position.set(v.x, v.y, v.z); e.mesh.rotation.y = v.yaw }
      // nudge the camera too if the sim exposes one
      const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
      if (cam) {
        if (cam.position) cam.position.set(v.x, v.y + 1.6, v.z)
        if (typeof v.pitch === 'number' && 'rotation' in cam) cam.rotation.x = -v.pitch
        if ('rotation' in cam) cam.rotation.y = v.yaw
      }
    }, v)
    // pump render frames
    for (let i = 0; i < 40; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch(e){} }); await sleep(16) }
    const f = `${OUT}/${v.name}.png`
    await page.screenshot({ path: f })
    shots.push(f)
    console.log('shot', f)
  }
  console.log('ERRORS:', errs.slice(0,5).join(' | ') || 'none')
} finally { await browser.close() }
