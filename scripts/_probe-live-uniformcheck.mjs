// What material/texture does a remote body ACTUALLY wear on live?
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('[pageerr]', e.message.slice(0,150)))
  await page.goto('https://sol-pkmn.fun/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 60000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
  await sleep(6000) // let character models + textures load
  const info = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const out = []
    sim.characterModels.forEach((model, nid) => {
      const mats = new Set()
      ;(model.meshes || []).forEach(m => { if (m.material) mats.add(m.material) })
      const matInfo = [...mats].map(mat => ({
        name: mat.name,
        albedo: (mat.albedoTexture && mat.albedoTexture.url) || (mat.diffuseTexture && mat.diffuseTexture.url) || null,
        bump: (mat.bumpTexture && mat.bumpTexture.url) || null,
        emissive: mat.emissiveColor ? mat.emissiveColor.toString() : null,
      }))
      out.push({ nid, team: model._teamId, ready: model.ready, mats: matInfo })
    })
    return out
  })
  console.log(JSON.stringify(info, null, 1).slice(0, 2500))
} catch (e) { console.error('ERR:', e.message) } finally { await browser.close().catch(()=>{}) }
process.exit(0)
