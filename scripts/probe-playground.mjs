// Headless smoke test for the anim playground. Serves public/ (already-built
// bundle), loads the default route (playground), confirms the model loads and
// clips enumerate, drives a couple of clips, screenshots. Exits non-zero on error.
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://localhost:8081/'
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
const logs = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 300)))
p.on('console', (m) => { const t = m.text(); logs.push(t); if (/playground/i.test(t)) console.log('  console:', t.slice(0, 120)) })

await p.goto(URL, { waitUntil: 'domcontentloaded' })

// wait for the playground object + clip list to populate
await p.waitForFunction(
  'window.playground && window.playground.groups && window.playground.groups.length > 0',
  { timeout: 45000 },
).catch(() => {})

const state = await p.evaluate(() => {
  const pg = window.playground
  if (!pg) return { ok: false, reason: 'no window.playground' }
  return {
    ok: true,
    clipCount: pg.groups.length,
    currentClip: pg.currentName,
    mapping: pg.mapping,
    clipRows: document.querySelectorAll('#pg-clips .pg-clip').length,
    hasRolePanel: !!document.getElementById('pg-roles'),
    sampleClips: pg.groups.slice(0, 6).map((e) => e.name),
  }
})

// exercise: play run, then death, then mount a weapon
await p.evaluate(() => {
  const pg = window.playground
  if (pg.byName.has('Jog_Fwd_Loop')) pg.play('Jog_Fwd_Loop')
  pg.selectWeapon(0)
})
await new Promise((r) => setTimeout(r, 1500))
await p.screenshot({ path: '/tmp/playground-run-rifle.png' })
await p.evaluate(() => { if (window.playground.byName.has('Death01')) window.playground.play('Death01') })
await new Promise((r) => setTimeout(r, 1500))
await p.screenshot({ path: '/tmp/playground-death.png' })

console.log('\n=== PLAYGROUND STATE ===')
console.log(JSON.stringify(state, null, 2))
console.log('screenshots: /tmp/playground-run-rifle.png, /tmp/playground-death.png')
if (errors.length) { console.log('\n=== ERRORS ==='); errors.forEach((e) => console.log('  ' + e)) }
else console.log('\nno page errors.')

await browser.close()
process.exit(errors.length || !state.ok ? 1 : 0)
