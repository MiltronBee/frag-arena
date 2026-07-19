// In-game Visage check: join dev (:8080), confirm the player spawns on the deck,
// and grab a first-person spawn view + two aerials of the bowtie (real renderer:
// textures + vertex-bake + coronas). World coords = native(ROTX=-90) * 0.65 scale.
import puppeteer from 'puppeteer-core'
import fs from 'fs'
const URL = process.env.FRAG_URL || "http://localhost:8080/"
const OUT = process.env.HOME + '/unreal/_work/map-shots'
fs.mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio','--window-size=1280,720'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0,200)))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await sleep(2500); await page.keyboard.press('Enter').catch(()=>{}); await sleep(1200)
  await page.click('#enter-arena').catch(()=>{})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity', { timeout: 30000 })
  await sleep(1500)
  const spawn = await page.evaluate(() => {
    const e = window.gameClient.simulator.myRawEntity
    return { x:+e.x.toFixed(1), y:+e.y.toFixed(1), z:+e.z.toFixed(1) }
  })
  console.log('SPAWNED AT', JSON.stringify(spawn))
  await page.evaluate(() => ['entry-overlay','splash','menu','main-menu'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display='none' }))
  const views = [
    { name: 'visage-spawn', natural: true },
    { name: 'visage-aerial', x: 26, z: -40, y: 40, yaw: 0, pitch: -0.55 },
    { name: 'visage-bridge', x: 26, z: 40, y: -18, yaw: 0, pitch: 0.0 },
    { name: 'visage-side',   x: -70, z: 68, y: 10, yaw: Math.PI/2, pitch: -0.15 },
  ]
  for (const v of views) {
    await page.evaluate((v) => {
      if (v.natural) return
      const s = window.gameClient.simulator, e = s.myRawEntity
      e.x=v.x; e.z=v.z; e.y=v.y; e.velX=e.velY=e.velZ=0
      if (e.mesh){ e.mesh.position.set(v.x,v.y,v.z); e.mesh.rotation.y=v.yaw }
      const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
      if (cam){ if(cam.position) cam.position.set(v.x, v.y+1.6, v.z); if('rotation' in cam){ cam.rotation.x=-v.pitch; cam.rotation.y=v.yaw } }
    }, v)
    for (let i=0;i<40;i++){ await page.evaluate(()=>{try{window.gameClient.simulator.renderer.scene.render()}catch(e){}}); await sleep(16) }
    await page.screenshot({ path: `${OUT}/${v.name}.png` }); console.log('shot', v.name)
  }
  console.log('ERRORS:', errs.slice(0,4).join(' | ') || 'none')
} finally { await browser.close() }
