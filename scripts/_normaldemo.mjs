import puppeteer from 'puppeteer-core'
import fs from 'fs'
const URL = 'https://sol-pkmn.fun/'
const OUT = process.env.HOME + '/unreal/_work/normal-demo'; fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio','--window-size=1280,720'] })
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await sleep(2500); await page.keyboard.press('Enter').catch(()=>{}); await sleep(1200)
  await page.click('#enter-arena').catch(()=>{})
  await page.waitForFunction('window.gameClient?.simulator?.myRawEntity', { timeout: 30000 })
  await sleep(1500)
  await page.evaluate(() => ['entry-overlay','splash','menu','main-menu'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none' }))
  // vantage: low over the deck, camera pitched down so the sun rakes the rock ground
  const V = { x: 2, z: -6, y: -23.5, yaw: 0.6, pitch: 0.35 }
  const setCam = async () => { await page.evaluate((v) => {
    const s = window.gameClient.simulator, e = s.myRawEntity
    e.x=v.x; e.z=v.z; e.y=v.y; e.velX=e.velY=e.velZ=0
    if (e.mesh){ e.mesh.position.set(v.x,v.y,v.z) }
    const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
    if (cam){ if(cam.position) cam.position.set(v.x, v.y+1.4, v.z); if('rotation' in cam){ cam.rotation.x=-v.pitch; cam.rotation.y=v.yaw } }
  }, V) }
  const render = async () => { for (let i=0;i<30;i++){ await page.evaluate(()=>{try{window.gameClient.simulator.renderer.scene.render()}catch(e){}}); await sleep(16) } }
  await setCam(); await render()
  await page.screenshot({ path: `${OUT}/A-flat.png` }); console.log('shot A-flat')

  // inject bumpTexture at runtime — no source edit. Get Texture ctor from an existing texture.
  const res = await page.evaluate((nurl) => {
    const s = window.gameClient.simulator
    const scene = s.renderer?.scene || s.scene
    const rok = scene.materials.find(m => (m.diffuseTexture?.url||'').includes('rok2') && (m.name||'').includes('rok2'))
    if (!rok) return 'no rok2'
    const TexCtor = rok.diffuseTexture.constructor
    const t = new TexCtor(nurl, scene)
    rok.bumpTexture = t
    rok.bumpTexture.level = 1.4
    return { applied: rok.name, cls: rok.getClassName(), url: nurl }
  }, 'https://sol-pkmn.fun/assets/maps/CTF-Visage/textures/UTtech1_Misc_rok2_n.webp')
  console.log('inject:', JSON.stringify(res))
  await sleep(1500) // let the texture load
  await setCam(); await render()
  await page.screenshot({ path: `${OUT}/B-normal.png` }); console.log('shot B-normal')
} finally { await browser.close() }
