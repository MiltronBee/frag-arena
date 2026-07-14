// End-to-end 1v1 verification: two real clients battle it out.
//
// Requires the local stack (npm start). Asserts the full frag loop works:
//   * canonical damage: one rifle shot removes EXACTLY config.damage hp (the
//     raw+smooth dedupe — before it, one pellet crossing both of the victim's
//     lag-compensated entities double-damaged)
//   * death: victim's isAlive flips false, death overlay shows, movement input
//     is ignored while dead (applyCommand isAlive gate, both sides)
//   * respawn (~2.5s): back to 100hp, alive, teleported to a fresh spawn point,
//     every magazine refilled (client mirrors the server's ammo reset)
//   * score: killer's kills=1, victim's deaths=1, HUD frag counter updates
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
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    ]
    CHROME = paths.find((path) => fs.existsSync(path))
  } else {
    CHROME = '/usr/bin/google-chrome'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

// one browser PER client: even with the throttling flags, only the foreground
// tab of a browser runs requestAnimationFrame at full rate, and this test needs
// BOTH game loops live at once (the shooter firing while the victim observes
// its own death + respawn). Two browsers = two foreground tabs.
const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]
const browsers = []

async function openClient() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: LAUNCH_ARGS,
  })
  browsers.push(browser)
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && ' +
    'window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready',
    { timeout: 30000 }
  )
  return page
}

const setInput = (page, fields) => page.evaluate((f) => {
  Object.assign(window.gameClient.simulator.input._currentState, f)
}, fields)

const snapshot = (page) => page.evaluate(() => {
  const simulator = window.gameClient.simulator
  const e = simulator.myRawEntity
  return {
    x: e.x, y: e.y, z: e.z,
    hp: e.hitpoints, alive: e.isAlive !== false,
    kills: e.kills || 0, deaths: e.deaths || 0,
    mag: e.weaponsState[0].magazineAmmo,
    deadClass: document.body.classList.contains('player-dead'),
    fragHud: (document.getElementById('frag-count') || {}).textContent || '',
  }
})

// point page's camera at a world position (the MoveCommand stream carries the
// camRay to the server, which orients the entity — same path a mouse uses)
const aimAt = (page, target) => page.evaluate((t) => {
  const cam = window.gameClient.simulator.renderer.camera
  const dx = t.x - cam.position.x
  const dy = t.y - cam.position.y
  const dz = t.z - cam.position.z
  cam.rotation.y = Math.atan2(dx, dz)
  cam.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz))
}, target)

try {
  const p1 = await openClient() // the shooter
  const p2 = await openClient() // the victim
  await sleep(1000) // let both fully replicate

  const p2Start = await snapshot(p2)
  check('both clients spawned alive at 100hp',
    p2Start.alive && p2Start.hp === 100 && (await snapshot(p1)).alive, JSON.stringify(p2Start))

  // ---- A) single rifle shot = exactly 15 damage (dedupe + canonical hp) ----
  await aimAt(p1, p2Start)
  await sleep(500) // several MoveCommands so the server entity is oriented (WAN-safe)
  await setInput(p1, { mouseDown: true })
  await sleep(100) // < rifle 150ms cooldown → exactly one shot
  await setInput(p1, { mouseDown: false })
  await sleep(1000) // round trip (works over real internet, not just localhost)

  const afterOne = await snapshot(p2)
  check('one rifle shot removes exactly 15hp (no raw/smooth double damage)',
    afterOne.hp === 85, `hp ${p2Start.hp} -> ${afterOne.hp} (want 85)`)

  // ---- B) sustained fire kills ----
  await aimAt(p1, afterOne)
  await setInput(p1, { mouseDown: true })
  await p2.waitForFunction('window.gameClient.simulator.myRawEntity.isAlive === false', { timeout: 8000 })
  await setInput(p1, { mouseDown: false })
  await sleep(200)

  const dead = await snapshot(p2)
  check('victim died (isAlive false, hp 0, death overlay up)',
    !dead.alive && dead.hp === 0 && dead.deadClass, JSON.stringify(dead))

  // ---- C) dead players can't move ----
  await setInput(p2, { forwards: true })
  await sleep(500)
  await setInput(p2, { forwards: false })
  const stillDead = await snapshot(p2)
  const moved = Math.hypot(stillDead.x - dead.x, stillDead.z - dead.z)
  check('movement input ignored while dead', moved < 0.05, `moved ${moved.toFixed(3)}m`)

  // ---- D) respawn: alive, 100hp, fresh ammo, new spawn point ----
  await p2.waitForFunction('window.gameClient.simulator.myRawEntity.isAlive === true', { timeout: 6000 })
  await sleep(300) // let the client-side ammo mirror + HUD run
  const respawned = await snapshot(p2)
  const teleported = Math.hypot(respawned.x - dead.x, respawned.z - dead.z)
  check('respawned at 100hp with overlay cleared',
    respawned.alive && respawned.hp === 100 && !respawned.deadClass, JSON.stringify(respawned))
  check('respawn teleported to a fresh spawn point', teleported > 0.5, `moved ${teleported.toFixed(2)}m`)
  check('magazine refilled on respawn (client mirror)', respawned.mag === 30, `mag ${respawned.mag}`)

  // ---- E) score ----
  const shooter = await snapshot(p1)
  check('killer credited a frag', shooter.kills === 1, `kills=${shooter.kills}`)
  check('victim credited a death', respawned.deaths === 1, `deaths=${respawned.deaths}`)
  check('frag HUD updated on both clients',
    shooter.fragHud.startsWith('1 FRAG') && respawned.fragHud.includes('1 DEATH'),
    `p1 "${shooter.fragHud}" p2 "${respawned.fragHud}"`)

  // ---- F) the respawned player can fight back ----
  const p1Pos = await snapshot(p1)
  await aimAt(p2, p1Pos)
  await sleep(500)
  await setInput(p2, { mouseDown: true })
  await sleep(100)
  await setInput(p2, { mouseDown: false })
  await sleep(1000)
  const p1Hit = await snapshot(p1)
  check('respawned player shoots back and lands damage', p1Hit.hp === 85, `p1 hp ${p1Hit.hp} (want 85)`)

  check('no uncaught client errors', p1.errors.length === 0 && p2.errors.length === 0,
    [...p1.errors, ...p2.errors].join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await Promise.all(browsers.map((b) => b.close()))
}

console.log('\n=== 1v1 frag loop verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
