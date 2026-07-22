// GATE B/D silent-break probe: arena-dressing node count + shadow-map presence.
// Launches headless SwiftShader Chrome (same flags as verify-scifi), loads the
// live client, and reads the render scene directly — the definitive check that
// the scoped glTF loader / shadow scene-component / materials all registered.
import puppeteer from 'puppeteer-core'
const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME || '/usr/bin/chromium'

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1024, height: 640 })
  const errors = []
  page.on('pageerror', e => { if (errors.length < 5) errors.push(e.message) })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.renderer && window.gameClient.simulator.renderer.scene', { timeout: 30000 })
  // let the arena dressing + shadow map settle
  await new Promise(r => setTimeout(r, 8000))
  const r = await page.evaluate(() => {
    const gc = window.gameClient
    const rn = gc.simulator.renderer
    const scene = rn.scene
    const sg = rn.shadowGenerator
    const smap = sg && sg.getShadowMap ? sg.getShadowMap() : null
    const dressing = rn.arenaDressing
    const nodes = dressing && dressing._nodes ? dressing._nodes : null
    let instanceCount = 0
    scene.meshes.forEach(m => { if (m.instances) instanceCount += m.instances.length })
    return {
      hasBABYLON: typeof window.BABYLON !== 'undefined',
      babylonKeys: window.BABYLON ? Object.keys(window.BABYLON).length : 0,
      hasVector3: !!(window.BABYLON && window.BABYLON.Vector3),
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      lights: scene.lights.length,
      shadowGenerator: !!sg,
      shadowMapTexture: !!smap,
      shadowMapName: smap ? smap.name : null,
      shadowRenderListLen: smap && smap.renderList ? smap.renderList.length : -1,
      dressingNodes: nodes ? (nodes.size !== undefined ? nodes.size : nodes.length) : -1, meshMapArena: !rn.arenaDressing,
      instanceCount,
      standardMaterialCount: scene.materials.filter(m => m.getClassName && m.getClassName() === 'StandardMaterial').length,
    }
  })
  console.log(JSON.stringify(r, null, 2))
  console.log('pageerrors:', errors.length ? errors : 'none')
  const ok = r.hasBABYLON && r.hasVector3 && r.meshes > 0 && r.materials > 0 && r.standardMaterialCount > 0 &&
        r.shadowGenerator && r.shadowMapTexture && r.shadowRenderListLen > 0 && r.lights >= 4 && (r.meshMapArena || r.dressingNodes > 0)
  console.log(ok ? 'RENDER PROBE: PASS (dressing nonzero, shadow map present, window.BABYLON live)'
                 : 'RENDER PROBE: FAIL — see fields above')
  await browser.close()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('PROBE ERROR', e.message)
  await browser.close(); process.exit(2)
}
