// Two-client repro for the late-joiner invisibility bug.
// IMPORTANT: each client runs in its OWN browser instance so BOTH tabs stay
// foreground — two pages in one browser makes the first tab a background tab,
// whose requestAnimationFrame Chrome pauses (anti-throttle flags only cover
// timers, not rAF), which by itself stalls the network read loop and fakes the
// bug. Separate browsers isolate the real game behaviour.
// A connects first and settles; ~5s later B joins. We poll whether each sees a
// FOREIGN PlayerCharacter. Exit 0 if A sees B, 1 otherwise.
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS })

const openClient = async (browser, tag) => {
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 600 })
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror:`, e.message))
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 30000 }
  )
  await page.evaluate(() => {
    const ov = document.getElementById('entry-overlay')
    if (ov) ov.classList.remove('is-visible')
    document.body.classList.add('arena-entered')
  })
  return page
}

const foreignPlayers = (page) => page.evaluate(() => {
  const sim = window.gameClient.simulator
  const own = new Set([sim.myRawEntity, sim.mySmoothEntity])
  const ids = []
  for (const [nid, e] of window.gameClient.client.entities) {
    if (e.protocol?.name === 'PlayerCharacter' && !own.has(e)) ids.push(nid)
  }
  return ids
})

const browserA = await launch()
const browserB = await launch()
try {
  console.log('--- opening client A (own browser) ---')
  const A = await openClient(browserA, 'A')
  await sleep(5000)

  console.log('--- opening client B, the late joiner (own browser) ---')
  const B = await openClient(browserB, 'B')

  let aSeesB = [], bSeesA = []
  for (let t = 0; t < 20; t++) {
    await sleep(1000)
    aSeesB = await foreignPlayers(A)
    bSeesA = await foreignPlayers(B)
    console.log(`t+${t + 1}s   A sees foreign: [${aSeesB}]   B sees foreign: [${bSeesA}]`)
    if (aSeesB.length > 0 && bSeesA.length > 0) break
  }

  console.log('\n===== RESULT =====')
  console.log(`A (pre-existing) sees late-joiner B : ${aSeesB.length > 0 ? 'YES ✓' : 'NO ✗ (BUG)'}`)
  console.log(`B (late joiner) sees A              : ${bSeesA.length > 0 ? 'YES ✓' : 'NO ✗'}`)
  process.exitCode = aSeesB.length > 0 ? 0 : 1
} finally {
  await browserA.close()
  await browserB.close()
}
