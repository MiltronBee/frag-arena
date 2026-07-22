// Verification: AI players (server/BotController.js + GameInstance bots).
//
// Requires the local stack (npm start). One real client joins and observes:
//   * at least BOTS (default 4) other PlayerCharacter entities replicate
//   * bots move around the arena (real applyCommand physics, not statues)
//   * bots fire (WeaponFired messages arrive from non-self sources)
//   * bots hurt an idle player (our hp drops — they aim, we're a sitting duck)
//   * no uncaught client errors while rendering bot characters + their FX
import puppeteer from 'puppeteer-core'
import os from 'os'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const EXPECTED_BOTS = parseInt(process.env.BOTS || '4', 10)
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
  await page.setViewport({ width: 800, height: 600 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  // MENU SAFETY: connecting no longer spawns an entity — deploy explicitly
  // (the PLAY click's server half) before waiting on the combatant state.
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && ' +
    "window.gameClient.simulator._connectionState === 'connected'",
    { timeout: 30000 }
  )
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && ' +
    'window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.mySmoothEntity && ' +
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready',
    { timeout: 30000 }
  )

  // count WeaponFired messages from OTHER shooters (bots — we never fire)
  await page.evaluate(() => {
    window.__botShots = 0
    window.gameClient.simulator.client.on('message::WeaponFired', (m) => {
      const mine = window.gameClient.simulator.mySmoothEntity
      if (!mine || m.sourceId !== mine.nid) window.__botShots++
    })
  })

  // snapshot all other PlayerCharacter entities this client can see
  const others = () => page.evaluate(() => {
    const simulator = window.gameClient.simulator
    const skip = new Set([simulator.myRawId, simulator.mySmoothId])
    const out = []
    window.gameClient.client.entities.forEach((e) => {
      if (e.hitpoints !== undefined && !skip.has(e.nid)) {
        out.push({ nid: e.nid, x: e.x, z: e.z, alive: e.isAlive })
      }
    })
    return out
  })

  await sleep(2000)
  const first = await others()
  check(`sees at least ${EXPECTED_BOTS} AI players`, first.length >= EXPECTED_BOTS,
    `${first.length} other player entities (nids ${first.map((e) => e.nid).join(', ')})`)

  // watch movement over 6 seconds
  await sleep(6000)
  const second = await others()
  const moved = second.filter((now) => {
    const before = first.find((e) => e.nid === now.nid)
    return before && Math.hypot(now.x - before.x, now.z - before.z) > 1.5
  })
  check('bots move around the arena', moved.length >= Math.min(2, EXPECTED_BOTS),
    `${moved.length}/${second.length} moved >1.5m in 6s`)

  // bots should be shooting (at us or each other) well within this window
  await page.waitForFunction('window.__botShots > 0', { timeout: 20000 }).catch(() => {})
  const shots = await page.evaluate(() => window.__botShots)
  check('bots fire their weapons', shots > 0, `${shots} WeaponFired received`)

  // an idle player in a bot arena should not stay pristine for long
  await page.waitForFunction(
    'window.gameClient.simulator.myRawEntity.hitpoints < 100', { timeout: 30000 }
  ).catch(() => {})
  const hp = await page.evaluate(() => window.gameClient.simulator.myRawEntity.hitpoints)
  check('bots damage an idle player', hp < 100, `hp ${hp}`)

  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await browser.close()
}

console.log('\n=== AI players verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
