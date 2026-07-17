// Verify the entry loading screen: progress bar fills, status text transitions
// LOADING ASSETS % -> ARENA READY, and ENTER enables once assets+connection ready.
import puppeteer from 'puppeteer-core'
const URL = process.argv[2] || 'http://localhost:8080/'
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1000, height: 750 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
const read = async () => p.evaluate(() => ({
  status: (document.getElementById('entry-status') || {}).textContent,
  fill: ((document.getElementById('entry-progress-fill') || {}).style || {}).width,
  barHidden: ((document.getElementById('entry-progress') || {}).classList || { contains: () => null }).contains('is-hidden'),
  enterDisabled: (document.getElementById('enter-arena') || {}).disabled,
}))
for (let i = 0; i < 10; i++) { console.log(i + 's', JSON.stringify(await read())); await new Promise((r) => setTimeout(r, 1000)) }
await p.screenshot({ path: '/tmp/loading-screen.png' })
console.log('errors:', errs.length ? errs : 'none')
await b.close()
