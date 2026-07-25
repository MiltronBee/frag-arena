// Deploy one idle human into the already-running local server and hold the connection
// for IDLE_MS, so the match state machine runs (it only arms with a human present).
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const IDLE_MS = parseInt(process.env.IDLE_MS || '270000', 10)
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
try {
  const page = await browser.newPage()
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  console.log('deployed; idling', IDLE_MS / 1000, 's')
  await sleep(IDLE_MS)
  console.log('idle complete')
} catch (e) {
  console.error('CLIENT_ERR', e.message)
} finally {
  await browser.close().catch(() => {})
}
