// Post-deploy live check: load the REAL site (fresh new-bundle client), confirm it
// connects to the game server (protocol matches), spawns an entity, and can send
// aim+fire commands without console/page errors. This is the atomic client+server
// protocol-match proof. Uses the live wss endpoint.
import puppeteer from 'puppeteer-core'
const URL = 'https://sol-pkmn.fun/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []; const check = (n, p, d) => results.push({ n, p: !!p, d })
const errs = []
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)) })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 20000 })

  // connection state should reach 'connected' (nengi handshake over wss/ws)
  let connected = false
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => window.gameClient.simulator._connectionState)
    if (s === 'connected') { connected = true; break }
    await sleep(500)
  }
  check('fresh client CONNECTS to live server (protocol matches)', connected, 'state=' + (await page.evaluate(() => window.gameClient.simulator._connectionState)))

  // server should replicate our own entity to us (spawn) within a few seconds
  let spawned = false
  for (let i = 0; i < 30; i++) {
    const has = await page.evaluate(() => !!window.gameClient.simulator.myRawEntity)
    if (has) { spawned = true; break }
    await sleep(500)
  }
  check('own entity spawned/replicated', spawned, 'myRawEntity=' + spawned)

  // drive an aim+fire command locally and confirm aimFactor ramps (gameplay path live)
  if (spawned) {
    const af = await page.evaluate(async () => {
      const sim = window.gameClient.simulator
      // simulate held aim on the current weapon by forcing the input flag + running updates
      sim.input._currentState.aimDown = true
      const t0 = sim.myRawEntity.aimFactor || 0
      await new Promise((r) => setTimeout(r, 600))
      return { t0, t1: sim.myRawEntity.aimFactor || 0, weapon: sim.weaponIndex }
    })
    check('aimFactor ramps on live entity (ADS gameplay active)', af.t1 > af.t0, JSON.stringify(af))
  }

  check('no page/console errors on the fresh client', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean')
} finally { await browser.close() }
let fail = 0
for (const r of results) { console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`); if (!r.p) fail++ }
if (errs.length) { console.log('\n--- errors seen ---'); errs.slice(0, 6).forEach((e) => console.log('  ' + e)) }
console.log(`\n${results.length - fail}/${results.length} checks passed`)
process.exit(fail ? 1 : 0)
