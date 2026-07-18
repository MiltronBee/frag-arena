// HUD capture for the Overwatch-vet consult. Joins as a real client, spawns bots,
// frames a target, then forces the HUD into its BUSY state (low HP, killfeed,
// damage numbers, weapon selector) so the designer sees overlap/positioning
// the way a player does mid-fight. Captures desktop + mobile viewports.
//
// Usage: node scripts/shot-hud.mjs
// Outputs: _work/hud-desktop.png, _work/hud-desktop-lowhp.png, _work/hud-mobile.png
import puppeteer from 'puppeteer-core'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const OUT = '_work'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(OUT, { recursive: true })

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

const enterArena = async (page) => {
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
}

// Frame the nearest bot so the scene isn't empty behind the HUD.
const frameTarget = (page) => page.evaluate(() => {
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
  const cam = sim.renderer.camera
  const ang = Math.atan2(best.x - me.x, best.z - me.z)
  const dist = 4.0
  me.x = best.x - Math.sin(ang) * dist
  me.z = best.z - Math.cos(ang) * dist
  cam.position.x = me.x; cam.position.z = me.z; cam.position.y = 0.4
  cam.rotation.y = ang; cam.rotation.x = 0.04
  return { nid: best.nid, dist: bestD }
})

try {
  // ---- DESKTOP: healthy state ----
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await enterArena(page)
  await sleep(4000)
  console.log('framed(desktop):', JSON.stringify(await frameTarget(page)))
  await sleep(500)
  await page.screenshot({ path: `${OUT}/hud-desktop.png` })
  console.log('wrote hud-desktop.png')

  // ---- DESKTOP: busy/low-HP state (force the danger cues + weapon selector) ----
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const me = sim.myRawEntity
    // low HP to trip whatever critical-state HUD exists
    if (me.hitpoints !== undefined) me.hitpoints = 18
    if (me.health !== undefined) me.health = 18
    // try to surface the weapon selector / inventory if there's an API for it
    try { window.gameClient.hud?.showWeaponWheel?.() } catch {}
    try { document.body.classList.add('weapon-switching') } catch {}
    // synthesize a couple killfeed lines if the client exposes it
    try {
      const kf = window.gameClient.killFeed || window.gameClient.hud?.killFeed
      kf?.add?.({ killer: 'ENEMY_07', victim: 'You', weapon: 'flak' })
      kf?.add?.({ killer: 'You', victim: 'ENEMY_03', weapon: 'rifle' })
    } catch {}
  })
  await sleep(700)
  await page.screenshot({ path: `${OUT}/hud-desktop-lowhp.png` })
  console.log('wrote hud-desktop-lowhp.png')

  // ---- MOBILE: touch controls + HUD ----
  const m = await browser.newPage()
  await m.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1')
  await m.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await enterArena(m)
  await sleep(4000)
  console.log('framed(mobile):', JSON.stringify(await frameTarget(m)))
  // nudge the touch layer to show by dispatching a touchstart on the canvas
  await m.evaluate(() => {
    document.body.classList.add('is-touch', 'touch-active')
    const c = document.querySelector('canvas')
    if (c) c.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }))
  })
  await sleep(600)
  await m.screenshot({ path: `${OUT}/hud-mobile.png` })
  console.log('wrote hud-mobile.png')

  if (errors.length) console.log('pageerrors:', errors.slice(0, 5))
} finally {
  await browser.close()
}
