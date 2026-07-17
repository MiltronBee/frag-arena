// Headless smoke test for the helmet head-bone mount. Serves public/ (already-built
// bundle), loads the default route (playground), waits for the model + clips + helmet
// to settle on the idle clip, then screenshots. Exits non-zero on load error.
import puppeteer from 'puppeteer-core'

// clientMain boots the game by default; the anim playground is at ?playground.
const URL = process.argv[2] || 'http://localhost:8081/?playground'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 300)))
p.on('console', (m) => { const t = m.text(); if (/error/i.test(t)) errors.push('CONSOLE ' + t.slice(0, 300)) })

await p.goto(URL, { waitUntil: 'domcontentloaded' })

// wait for the playground object + clip list to populate
const ready = await p.waitForFunction(
  'window.playground && window.playground.groups && window.playground.groups.length > 0',
  { timeout: 45000 },
).then(() => true).catch(() => false)

if (!ready) {
  console.log('helmet probe: playground never loaded (no clips)')
  if (errors.length) errors.forEach((e) => console.log('  ' + e))
  await browser.close()
  process.exit(1)
}

// play the mapped idle (fall back to first clip) so the head/helmet settle
await p.evaluate(() => {
  const pg = window.playground
  const idle = pg.mapping && pg.mapping.idle && pg.byName.has(pg.mapping.idle)
    ? pg.mapping.idle
    : pg.groups[0].name
  pg.play(idle)
})

await new Promise((r) => setTimeout(r, 1500))
await p.screenshot({ path: '/tmp/helmet-idle.png' })

const state = await p.evaluate(() => {
  const pg = window.playground
  return { hasHelmet: !!pg._helmetRoot, currentClip: pg.currentName }
})

console.log('helmet probe: helmetMounted=' + state.hasHelmet + ' clip=' + state.currentClip)
console.log('screenshot: /tmp/helmet-idle.png')
if (errors.length) { console.log('=== ERRORS ==='); errors.forEach((e) => console.log('  ' + e)) }
else console.log('no page errors.')

await browser.close()
process.exit(errors.length ? 1 : 0)
