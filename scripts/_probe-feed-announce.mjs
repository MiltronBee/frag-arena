// Synthetic-state probe for the feed/announce surfaces (HUD2030 Surface C):
// killfeed rows (own-kill/own-death/suicide/headshot), frag banner + medal callout,
// YOU DIED card, TDM match-end banner. Throwaway verification script.
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

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 30000 }
  )
  for (let i = 0; i < 12 && await page.$('#splash'); i++) {
    await page.mouse.click(640, 360); await sleep(400)
  }
  await page.evaluate(() => {
    const sp = document.getElementById('splash'); if (sp) sp.remove()
    const ov = document.getElementById('entry-overlay'); if (ov) ov.classList.remove('is-visible')
    document.body.classList.add('arena-entered')
    const s = document.getElementById('settings-menu'); if (s) s.classList.add('settings-closed')
    document.body.classList.remove('menu-open')
  })
  await sleep(3000)

  // Shot 1: killfeed variants + frag banner + medal
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const fl = sim.fragLayer
    const my = fl._mySmoothNid()
    sim.getName = (nid) => nid === my ? 'You' : (nid === 901 ? 'xX_DegenLord_Xx' : nid === 902 ? 'wagmi_wolf' : 'paperhands' + nid)
    fl._pushKillFeed({ killerNid: 901, victimNid: 902, weaponIndex: 1, suicide: false, iKilled: false, iDied: false, headshot: false })
    fl._pushKillFeed({ killerNid: my, victimNid: 901, weaponIndex: 2, suicide: false, iKilled: true, iDied: false, headshot: true })
    fl._pushKillFeed({ killerNid: 902, victimNid: my, weaponIndex: 3, suicide: false, iKilled: false, iDied: true, headshot: false })
    fl._pushKillFeed({ killerNid: 903, victimNid: 903, weaponIndex: 4, suicide: true, iKilled: false, iDied: false, headshot: false })
    fl._showFragBanner(901)
    fl.showMedal('DOUBLE KILL')
  })
  await sleep(600)
  await page.screenshot({ path: `${OUT}/probe-feed-banner.png` })
  console.log('wrote probe-feed-banner.png')

  // Shot 2: YOU DIED card (Simulator re-toggles the class per-frame off isAlive)
  await page.evaluate(() => {
    window.gameClient.simulator.myRawEntity.isAlive = false
  })
  await sleep(500)
  await page.screenshot({ path: `${OUT}/probe-youdied.png` })
  console.log('wrote probe-youdied.png')

  // Shot 3: match-end banner (FFA VICTORY = gold underline)
  await page.evaluate(() => {
    window.gameClient.simulator.myRawEntity.isAlive = true
    const b = document.getElementById('tdm-banner')
    const t = document.getElementById('tdm-banner-title')
    const s = document.getElementById('tdm-banner-score')
    t.textContent = 'VICTORY'; t.className = 'tdm-win'
    s.textContent = '24 — 19'
    b.classList.add('is-visible')
  })
  await sleep(500)
  await page.screenshot({ path: `${OUT}/probe-matchend.png` })
  console.log('wrote probe-matchend.png')

  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '))
  else console.log('no page errors')
} finally {
  await browser.close()
}
