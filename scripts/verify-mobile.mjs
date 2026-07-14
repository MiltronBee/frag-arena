// Verifies the mobile touch controls in an emulated phone (touch + coarse
// pointer). Requires a running dev server (or FRAG_URL pointing at prod).
//
// Checks (see MOBILE_FPS_CONTROLS_RESEARCH.md §7):
//  - touch overlay is created on a touch device
//  - joystick drag moves the predicted player
//  - look drag rotates the camera
//  - fire button consumes ammo
//  - jump button leaves the ground
//  - fire + drag: the SAME finger holding fire can drag to aim — both ammo is
//    consumed AND the camera yaws (fire button doubles as a look surface)
//  - look calibration: a 400px swipe yaws ~88 deg at default touch sensitivity
//  - touch sensitivity scales look and is decoupled from desktop sensitivity
//  - invert-Y flips the pitch direction
//  - touch sensitivity persists across a reload
//  - portrait smoke: overlay mounts and look works at a portrait viewport
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

// wait for the client + our own entity, then enter the arena
const enterArena = async (page) => {
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && !!window.gameClient.simulator.myRawEntity',
    { timeout: 15000 }
  )
  await page.waitForFunction(
    '!document.getElementById("enter-arena").disabled',
    { timeout: 15000 }
  )
  await page.click('#enter-arena')
  await page.waitForFunction('document.body.classList.contains("arena-entered")')
  await sleep(500)
}

const boxCenter = (page, id) => page.evaluate((id) => {
  const r = document.getElementById(id).getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}, id)

const camYaw = (page) => page.evaluate(() => window.gameClient.simulator.renderer.camera.rotation.y)
const camPitch = (page) => page.evaluate(() => window.gameClient.simulator.renderer.camera.rotation.x)
const magAmmo = (page) => page.evaluate(() => {
  const s = window.gameClient.simulator
  return s.myRawEntity.weaponsState[s.weaponIndex].magazineAmmo
})

try {
  const page = await browser.newPage()
  // landscape phone: touch enabled, coarse pointer — TouchControls should mount
  await page.setViewport({ width: 812, height: 375, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await enterArena(page)

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
  const rotBefore = await camYaw(page)
  await touchDrag(page, 600, 180, 120, 0, 8, 100)
  const rotAfter = await camYaw(page)
  const dRot = Math.abs(rotAfter - rotBefore)
  check('look drag rotates the camera', dRot > 0.05, `dRot=${dRot.toFixed(3)}`)

  // 4. fire button consumes ammo
  const ammoBefore = await magAmmo(page)
  const fireBox = await boxCenter(page, 'touch-fire')
  await touchTap(page, fireBox.x, fireBox.y, 250)
  await sleep(300)
  const ammoAfter = await magAmmo(page)
  check('fire button consumes ammo', ammoAfter < ammoBefore, `${ammoBefore} -> ${ammoAfter}`)

  // 5. jump button leaves the ground
  const jumpBox = await boxCenter(page, 'touch-jump')
  let maxY = 0
  await touchTap(page, jumpBox.x, jumpBox.y, 150)
  for (let i = 0; i < 30; i++) {
    await sleep(33)
    const y = await page.evaluate(() => window.gameClient.simulator.myRawEntity.y)
    if (y > maxY) maxY = y
  }
  check('jump button leaves the ground', maxY > 0.3, `apexY=${maxY.toFixed(2)}`)

  // 6. fire + drag: the fire thumb latches the shot AND keeps aiming. Start the
  //    touch ON the fire button, then drag it — Touch Events keep targeting the
  //    button, so its moves feed the look pipeline while fire stays held.
  await page.evaluate(() => { window.gameClient.simulator.touchSensitivity = 1.0 })
  const fdAmmoBefore = await magAmmo(page)
  const fdYawBefore = await camYaw(page)
  await touchDrag(page, fireBox.x, fireBox.y, 140, 0, 8, 150)
  await sleep(150)
  const fdAmmoAfter = await magAmmo(page)
  const fdYawAfter = await camYaw(page)
  const fdYaw = Math.abs(fdYawAfter - fdYawBefore)
  check('fire + drag: ammo down AND camera yaws',
    fdAmmoAfter < fdAmmoBefore && fdYaw > 0.2,
    `ammo ${fdAmmoBefore}->${fdAmmoAfter}, dYaw=${fdYaw.toFixed(3)}`)

  // 7. look calibration: a 400px horizontal swipe yaws ~88 deg at touchSens 1.0
  //    (yaw gain 0.22 deg/px). The touch starts in the look zone, so overlap
  //    with any button mid-drag is irrelevant.
  const calBefore = await camYaw(page)
  await touchDrag(page, 410, 140, 400, 0, 16, 40)
  const calAfter = await camYaw(page)
  const calDeg = Math.abs(calAfter - calBefore) * 180 / Math.PI
  check('400px swipe yaws ~88 deg (default touch sensitivity)',
    Math.abs(calDeg - 88) <= 88 * 0.08, `${calDeg.toFixed(2)} deg`)

  // 8. touch sensitivity scales the look, and desktop sensitivity does NOT.
  const swipeYaw = async () => {
    const b = await camYaw(page)
    await touchDrag(page, 410, 150, 200, 0, 10, 30)
    const a = await camYaw(page)
    return Math.abs(a - b)
  }
  await page.evaluate(() => {
    window.gameClient.simulator.touchSensitivity = 1.0
    window.gameClient.simulator.sensitivity = 1.0
  })
  const yTouch1 = await swipeYaw()
  await page.evaluate(() => { window.gameClient.simulator.touchSensitivity = 2.0 })
  const yTouch2 = await swipeYaw()
  await page.evaluate(() => {
    window.gameClient.simulator.touchSensitivity = 1.0
    window.gameClient.simulator.sensitivity = 5.0   // desktop sens cranked up
  })
  const yTouch3 = await swipeYaw()
  check('touch sensitivity 2x ~doubles the look',
    Math.abs(yTouch2 - 2 * yTouch1) <= 0.15 * (2 * yTouch1),
    `1x=${yTouch1.toFixed(3)} 2x=${yTouch2.toFixed(3)}`)
  check('desktop sensitivity does not affect touch look',
    Math.abs(yTouch3 - yTouch1) <= 0.05 * yTouch1 + 1e-4,
    `touchSens1=${yTouch1.toFixed(3)} (desktopSens=5)=${yTouch3.toFixed(3)}`)

  // 9. invert-Y flips the pitch direction for the same vertical drag
  await page.evaluate(() => {
    window.gameClient.simulator.touchInvertY = false
    window.gameClient.simulator.renderer.camera.rotation.x = 0
  })
  await touchDrag(page, 500, 120, 0, 80, 8, 30)
  const pitchOff = await camPitch(page)
  await page.evaluate(() => {
    window.gameClient.simulator.touchInvertY = true
    window.gameClient.simulator.renderer.camera.rotation.x = 0
  })
  await touchDrag(page, 500, 120, 0, 80, 8, 30)
  const pitchOn = await camPitch(page)
  check('invert-Y flips the pitch direction',
    pitchOff !== 0 && Math.sign(pitchOn) === -Math.sign(pitchOff) &&
    Math.abs(Math.abs(pitchOn) - Math.abs(pitchOff)) <= 0.02,
    `off=${pitchOff.toFixed(3)} on=${pitchOn.toFixed(3)}`)

  // 10. no uncaught errors (landscape session)
  check('no uncaught client errors (landscape)', errors.length === 0, errors.join(' | '))

  // 11. touch sensitivity persists across a reload (independent localStorage key)
  await page.evaluate(() => localStorage.setItem('touchSens', '2.35'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 15000 })
  const persisted = await page.evaluate(() => window.gameClient.simulator.touchSensitivity)
  check('touch sensitivity persists across reload', Math.abs(persisted - 2.35) < 1e-6,
    `touchSensitivity=${persisted}`)
  await page.evaluate(() => localStorage.removeItem('touchSens'))
  await page.close()

  // 12. portrait smoke: never force orientation — overlay must mount and look
  //     must work at a portrait viewport (right-half look zone).
  const pp = await browser.newPage()
  await pp.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  const pErrors = []
  pp.on('pageerror', (e) => pErrors.push(e.message))
  await pp.goto(URL, { waitUntil: 'domcontentloaded' })
  await enterArena(pp)
  const pMounted = await pp.evaluate(() =>
    !!document.getElementById('touch-controls') && !!document.getElementById('touch-look-zone'))
  const pYawBefore = await camYaw(pp)
  await touchDrag(pp, 250, 400, 110, 0, 8, 40)   // horizontal swipe in the right-half zone
  const pYawAfter = await camYaw(pp)
  const pYaw = Math.abs(pYawAfter - pYawBefore)
  check('portrait: overlay mounts and look rotates',
    pMounted && pYaw > 0.05 && pErrors.length === 0,
    `mounted=${pMounted} dYaw=${pYaw.toFixed(3)} errs=${pErrors.length ? pErrors.join(' | ') : 0}`)
  await pp.close()
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
