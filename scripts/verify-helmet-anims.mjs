// Confirms the helmet stays mounted on the head bone across idle / run / death
// clips (it's bone-parented, so it should ride any pose). Full-body shots.
import puppeteer from 'puppeteer-core'
const URL = process.argv[2] || 'http://localhost:8081/?playground'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 500, height: 640 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message.slice(0, 160)))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction('window.playground && window.playground.groups && window.playground.groups.length>0', { timeout: 45000 }).catch(() => {})
await p.evaluate(() => { const el = document.querySelector('#pg-panel,.pg-panel,aside,.panel'); if (el) el.style.display = 'none' })

async function clipShot(clip, tag) {
  const played = await p.evaluate((c) => {
    const pg = window.playground
    const name = pg.byName.has(c) ? c : (pg.groups.find((e) => e.name.toLowerCase().includes(c.toLowerCase())) || {}).name
    if (name) pg.play(name)
    // frame whole body from the front
    const cam = pg.scene.activeCamera
    if (cam.setTarget) cam.setTarget(new BABYLON.Vector3(0, 0.95, 0))
    if ('alpha' in cam) { cam.alpha = Math.PI * 1.5; cam.beta = Math.PI / 2.1; cam.radius = 2.6 }
    return { name, helmet: !!pg._helmetRoot }
  }, clip)
  await new Promise((r) => setTimeout(r, 1200))
  await p.screenshot({ path: `/tmp/vh-${tag}.png` })
  return played
}
const res = {
  idle: await clipShot('Idle_Loop', 'idle'),
  run: await clipShot('Jog_Fwd_Loop', 'run'),
  death: await clipShot('Death01', 'death'),
  errors,
}
console.log(JSON.stringify(res))
await browser.close()
if (errors.length || !res.idle.helmet) process.exit(1)
