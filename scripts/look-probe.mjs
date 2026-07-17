import puppeteer from 'puppeteer-core'
const URL = process.argv[2] || 'http://localhost:8080/'
const TAG = process.argv[3] || 'local'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] })
const p = await browser.newPage()
await p.setViewport({ width: 1000, height: 750 })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0,200)))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity', { timeout: 30000 })
await p.evaluate(() => {
  const ov = document.getElementById('entry-overlay'); if (ov) ov.classList.remove('is-visible')
  document.body.classList.add('arena-entered')
  const sim = window.gameClient.simulator
  const input = sim.input || sim.inputSystem
  if (input) input.pointerLocked = true
})
await new Promise(r => setTimeout(r, 4000))
const look = async (dx, dy, name) => {
  await p.evaluate(({dx, dy}) => {
    // feed movement in chunks like a real mouse
    const steps = 10
    for (let i = 0; i < steps; i++)
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx/steps, movementY: dy/steps }))
  }, {dx, dy})
  await new Promise(r => setTimeout(r, 400))
  const st = await p.evaluate(() => {
    const sim = window.gameClient.simulator
    const c = sim.renderer.camera
    const vm = sim.renderer.vmCamera
    return { rot: [c.rotation.x, c.rotation.y, c.rotation.z].map(v=>+v.toFixed(3)),
             pos: [c.position.x, c.position.y, c.position.z].map(v=>+v.toFixed(2)),
             vmRot: vm ? [vm.rotation.x, vm.rotation.y, vm.rotation.z].map(v=>+v.toFixed(3)) : null,
             entRot: +sim.myRawEntity.rotation?.toFixed?.(3) }
  })
  await p.screenshot({ path: `/tmp/look-${TAG}-${name}.png` })
  console.log(`${TAG} ${name}: ${JSON.stringify(st)}`)
}
await look(0, 0, '0-start')
await look(400, 0, '1-right')
await look(400, 0, '2-right-more')
await look(0, -300, '3-up')
await look(-800, 300, '4-back-left-down')
await browser.close()
