// Verifies the mobile touch controls in an emulated phone (touch + coarse
// pointer). Requires a running dev server (or FRAG_URL pointing at prod).
//
// Checks:
//  - touch overlay is created on a touch device
//  - joystick drag moves the predicted player
//  - look drag rotates the camera
//  - fire button consumes ammo
//  - jump button leaves the ground
//
// Exit code 0 = all assertions passed, 1 = failure.
import puppeteer from 'puppeteer-core'
import os from 'os'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'

let CHROME = process.env.CHROME_BIN
if (!CHROME) {
  if (os.platform() === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ]
    CHROME = paths.find(p => fs.existsSync(p))
  } else {
    CHROME = '/usr/bin/google-chrome'
  }
}

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

const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

// drag a single touch from (x,y) by (dx,dy) over `steps` moves, optionally
// holding at the end before release
const touchDrag = async (page, x, y, dx, dy, steps = 10, holdMs = 400) => {
  const t = await page.touchscreen.touchStart(x, y)
  for (let i = 1; i <= steps; i++) {
    await t.move(x + (dx * i) / steps, y + (dy * i) / steps)
    await sleep(16)
  }
  await sleep(holdMs)
  await t.end()
}

const touchTap = async (page, x, y, holdMs = 120) => {
  const t = await page.touchscreen.touchStart(x, y)
  await sleep(holdMs)
  await t.end()
}

try {
  const page = await browser.newPage()
  // landscape phone: touch enabled, coarse pointer — TouchControls should mount
  await page.setViewport({ width: 812, height: 375, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && !!window.gameClient.simulator.myRawEntity',
    { timeout: 15000 }
  )
  await sleep(500)

  // 1. overlay mounted
  const overlay = await page.evaluate(() => ({
    controls: !!document.getElementById('touch-controls'),
    zones: !!document.getElementById('touch-move-zone') && !!document.getElementById('touch-look-zone'),
    buttons: !!document.getElementById('touch-fire') && !!document.getElementById('touch-jump'),
  }))
  check('touch overlay mounted on touch device', overlay.controls && overlay.zones && overlay.buttons,
    JSON.stringify(overlay))

  // 2. joystick drag moves the player (drag up-forward on the left half)
  const before = await page.evaluate(() => {
    const e = window.gameClient.simulator.myRawEntity
    return { x: e.x, z: e.z }
  })
  await touchDrag(page, 160, 280, 0, -80, 8, 900)
  await sleep(200)
  const after = await page.evaluate(() => {
    const e = window.gameClient.simulator.myRawEntity
    return { x: e.x, z: e.z }
  })
  const moved = Math.hypot(after.x - before.x, after.z - before.z)
  check('joystick moves the player', moved > 1, `moved=${moved.toFixed(2)}`)

  // 3. look drag rotates the camera (horizontal swipe on the right half)
  const rotBefore = await page.evaluate(() =>
    window.gameClient.simulator.renderer.camera.rotation.y)
  await touchDrag(page, 600, 180, 120, 0, 8, 100)
  const rotAfter = await page.evaluate(() =>
    window.gameClient.simulator.renderer.camera.rotation.y)
  const dRot = Math.abs(rotAfter - rotBefore)
  check('look drag rotates the camera', dRot > 0.05, `dRot=${dRot.toFixed(3)}`)

  // 4. fire button consumes ammo
  const ammoBefore = await page.evaluate(() => {
    const s = window.gameClient.simulator
    return s.myRawEntity.weaponsState[s.weaponIndex].magazineAmmo
  })
  const fireBox = await page.evaluate(() => {
    const r = document.getElementById('touch-fire').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await touchTap(page, fireBox.x, fireBox.y, 250)
  await sleep(300)
  const ammoAfter = await page.evaluate(() => {
    const s = window.gameClient.simulator
    return s.myRawEntity.weaponsState[s.weaponIndex].magazineAmmo
  })
  check('fire button consumes ammo', ammoAfter < ammoBefore, `${ammoBefore} -> ${ammoAfter}`)

  // 5. jump button leaves the ground
  const jumpBox = await page.evaluate(() => {
    const r = document.getElementById('touch-jump').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  let maxY = 0
  await touchTap(page, jumpBox.x, jumpBox.y, 150)
  for (let i = 0; i < 30; i++) {
    await sleep(33)
    const y = await page.evaluate(() => window.gameClient.simulator.myRawEntity.y)
    if (y > maxY) maxY = y
  }
  check('jump button leaves the ground', maxY > 0.3, `apexY=${maxY.toFixed(2)}`)

  // 6. no uncaught errors
  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (err) {
  check('verification harness ran to completion', false, err.message)
}

await browser.close()

console.log('\n=== mobile controls verification ===')
let failed = 0
for (const c of checks) {
  const status = c.pass ? 'PASS' : 'FAIL'
  if (!c.pass) failed++
  console.log(`${status}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
