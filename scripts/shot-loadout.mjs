// Screenshot the LOADOUT panel, with and without a linked wallet.
//
// The panel's whole job is to make the Season 1 ownership gate legible, so "does it
// build" is not the test — the test is whether a player can look at it and understand
// what they own and what they do not. That has to be seen.
//
// The wallet read is stubbed at the network layer rather than by touching app code:
// /wallet/<addr> is intercepted and answered, so this exercises the real render path
// (_walletLookup -> _renderLoadout -> LoadoutPreview) exactly as production would.
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.FRAG_URL || "http://localhost:8080/?loadout3d=0"
const OUT = process.env.OUT_DIR || '/tmp/loadout-shots'
fs.mkdirSync(OUT, { recursive: true })

const paths = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
]
const CHROME = process.env.CHROME_BIN || paths.find((p) => fs.existsSync(p))
if (!CHROME) { console.error('no chrome found'); process.exit(1) }

const ALL = ['Vector Rifle', 'Static Repeater', 'Breach Ward', 'Long Debt',
  'Degen Helm', 'Cloth Cuirass', 'Cloth Pauldron', 'Cloth Joint Cap', 'Cloth Sabaton']

async function shot(name, holdings) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader', '--window-size=1280,900'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (/\/wallet\//.test(req.url())) {
      const weapons = holdings.filter((n) => ['Vector Rifle', 'Static Repeater', 'Breach Ward', 'Long Debt'].includes(n))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count: holdings.length, names: holdings, weapons: weapons.map((_, i) => i) }),
      })
    }
    req.continue()
  })

  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 })

  // seed the saved wallet exactly as a returning linked player would have it
  if (holdings.length) {
    await page.evaluate(() => localStorage.setItem('degen.wallet', 'DEGENZnU4NWTQSQsmdaDMrjTrUVuTUeVdYJPmw8x1994'))
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
  } else {
    await page.evaluate(() => localStorage.removeItem('degen.wallet'))
  }

  const clicked = await page.evaluate(() => {
    const b = document.querySelector('[data-action="loadout"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!clicked) { console.log(`${name}: LOADOUT plate not found`); await browser.close(); return }

  // let the body GLB, the armour props and the first frames land
  await new Promise((r) => setTimeout(r, 20000))

  const state = await page.evaluate(() => {
    const rows = (id) => [...document.querySelectorAll(`#${id} li`)].map((li) => ({
      label: li.querySelector('span')?.textContent,
      value: li.querySelector('b')?.textContent,
      state: li.getAttribute('data-state'),
    }))
    const c = document.getElementById('loadout-canvas')
    return {
      open: !document.getElementById('loadout-modal')?.classList.contains('info-closed'),
      canvas: c ? { w: c.width, h: c.height } : null,
      weapons: rows('loadout-weapons'),
      armor: rows('loadout-armor'),
      note: document.getElementById('loadout-note')?.textContent?.slice(0, 90),
    }
  })

  const el = await page.$('#loadout-modal')
  await el.screenshot({ path: `${OUT}/${name}.png` })

  console.log(`\n=== ${name} ===`)
  console.log('open:', state.open, '| canvas:', state.canvas)
  console.log('weapons:', state.weapons.map((r) => `${r.label}=${r.value}`).join('  '))
  console.log('armor  :', state.armor.map((r) => `${r.label}=${r.value}`).join('  '))
  console.log('note   :', state.note)
  if (errs.length) console.log('ERRORS :', [...new Set(errs)].slice(0, 6))
  await browser.close()
}

await shot('unlinked', [])
await shot('full-holder', ALL)
console.log('\nshots in', OUT)
