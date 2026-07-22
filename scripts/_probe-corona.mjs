import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 600 })
await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity', { timeout: 30000 })
for (let i = 0; i < 12 && await page.$('#splash'); i++) { await page.mouse.click(450, 300); await new Promise(r => setTimeout(r, 350)) }
const info = await page.evaluate(() => {
  ['entry-overlay','splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
  document.body.classList.add('arena-entered')
  const scene = window.gameClient.simulator.renderer.scene
  const cam = scene.activeCamera
  const coronas = scene.meshes.filter(m => /^corona\d/.test(m.name))
  if (!coronas.length) return { count: 0 }
  const c = coronas[0]
  const p = cam.globalPosition
  const fwd = cam.getDirection(new BABYLON.Vector3(0, 0, 1))
  c.position.set(p.x + fwd.x * 4, p.y + fwd.y * 4, p.z + fwd.z * 4)
  return { count: coronas.length, alpha: c.material.alpha }
})
console.log(JSON.stringify(info))
await new Promise(r => setTimeout(r, 800))
await page.screenshot({ path: '_work/corona-probe.png' })
await browser.close()
