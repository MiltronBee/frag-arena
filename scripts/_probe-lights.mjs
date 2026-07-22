import puppeteer from 'puppeteer-core'
const URL = process.env.FRAG_URL || 'https://sol-pkmn.fun/'
const CHROME = '/usr/bin/google-chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', e => {})
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await sleep(2500); await page.keyboard.press('Enter').catch(()=>{}); await sleep(1200)
  await page.click('#enter-arena').catch(()=>{})
  await page.waitForFunction('window.gameClient?.simulator?.myRawEntity', { timeout: 30000 })
  await sleep(1500)
  const info = await page.evaluate(() => {
    const s = window.gameClient.simulator
    const scene = s.renderer?.scene || s.scene
    const lights = (scene.lights||[]).map(l => ({ name:l.name, type:l.getClassName?.(), intensity:l.intensity }))
    const rok = (scene.materials||[]).find(m => (m.name||'').includes('rok2') || (m.diffuseTexture?.url||'').includes('rok2'))
    const matInfo = rok ? {
      name: rok.name, cls: rok.getClassName?.(),
      disableLighting: rok.disableLighting,
      hasDiffuse: !!rok.diffuseTexture, diffuseUrl: (rok.diffuseTexture?.url||'').split('/').pop(),
      hasEmissive: !!rok.emissiveTexture, emissiveColor: rok.emissiveColor,
      hasBump: !!rok.bumpTexture,
      usesVertexColor: rok.useVertexColor ?? null,
    } : 'rok2 material not found'
    // does the map mesh carry vertex colors (the bake)?
    const meshes = (scene.meshes||[]).filter(m => (m.name||'').toLowerCase().includes('map') || m.material===rok)
    const vcol = meshes.slice(0,3).map(m => ({ name:m.name, hasVColors: m.useVertexColors, hasColorsData: !!m.getVerticesData?.('color') }))
    return { lightCount: lights.length, lights, matInfo, vcol, materialCount: scene.materials.length }
  })
  console.log(JSON.stringify(info, null, 2))
} finally { await browser.close() }
