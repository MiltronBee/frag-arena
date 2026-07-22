// Boot probe for one map: join, confirm the /mapinfo handshake was adopted, count
// entities, screenshot. Usage: node scripts/_verify-map-cycle.mjs <mapId>
import puppeteer from 'puppeteer-core'
const mapId = process.argv[2]
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 40000 })
  await new Promise(r => setTimeout(r, 6000)) // map visual + bake + dressing load
  for (let i = 0; i < 12 && await page.$('#splash'); i++) { await page.mouse.click(640, 360); await new Promise(r => setTimeout(r, 300)) }
  const st = await page.evaluate(() => {
    ['entry-overlay','splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
    document.body.classList.add('arena-entered')
    const sim = window.gameClient.simulator
    let others = 0
    window.gameClient.client.entities.forEach(e => { if (e.hitpoints !== undefined) others++ })
    return {
      handshake: window.__SERVER_MAP_ID__ || null,
      simMap: sim.map.id,
      me: !!sim.myRawEntity,
      entities: others,
      baked: !!(sim.renderer && sim.renderer._vertexlightApplied),
    }
  })
  await new Promise(r => setTimeout(r, 1500))
  await page.screenshot({ path: `_work/verify-map-${mapId}.png` })
  const ok = st.handshake === mapId && st.simMap === mapId && st.me && st.entities >= 4
  console.log(JSON.stringify({ mapId, ...st, pageErrors: errors.slice(0, 2), verdict: ok ? 'PASS' : 'CHECK' }))
  process.exitCode = ok ? 0 : 1
} finally { await browser.close() }
