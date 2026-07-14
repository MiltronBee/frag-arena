// Visual check for the SciFi MegaKit arena skin (client/graphics/arenaDressing.js).
// Requires the local stack (npm start). Waits for the kit to load, confirms the
// collision boxes went invisible and instances exist, then saves a player-POV and
// an overhead screenshot for eyeballing.
import puppeteer from 'puppeteer-core'
import os from 'os'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'

let CHROME = process.env.CHROME_BIN
if (!CHROME) {
  if (os.platform() === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    ]
    CHROME = paths.find((path) => fs.existsSync(path))
  } else {
    CHROME = '/usr/bin/google-chrome'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1024, height: 640 })
  const errors = []
  page.on('pageerror', (error) => {
    if (errors.length < 3) errors.push(error.stack || error.message)
    else errors.length === 3 && errors.push('...more')
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log('[page]', msg.text())
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 20000 }
  )
  await page.waitForFunction('!document.getElementById("enter-arena").disabled', { timeout: 20000 })
  await page.click('#enter-arena')
  await page.waitForFunction('document.body.classList.contains("arena-entered")')

  const loaded = await page.evaluate(async () => {
    const d = window.gameClient.simulator.renderer.arenaDressing
    if (!d) return { ok: false, reason: 'no arenaDressing on renderer' }
    const ok = await d._ready
    return { ok, enabled: d.enabled, pieces: d._pieces.size, dressed: d._nodes.size }
  })
  console.log('dressing:', JSON.stringify(loaded))

  await sleep(2500) // let textures upload + obstacles attach

  const state = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    const boxes = scene.meshes.filter((m) => m.name === 'obstacle')
    return {
      obstacles: boxes.length,
      hiddenBoxes: boxes.filter((m) => m.visibility === 0).length,
      instances: scene.meshes.filter((m) => m.getClassName() === 'InstancedMesh').length,
      dressedNodes: sim.renderer.arenaDressing._nodes.size,
    }
  })
  console.log('scene:', JSON.stringify(state))

  await page.screenshot({ path: '/tmp/scifi-pov.png' })

  // pin the camera to a high corner overview (re-applied every frame so the
  // game loop can't fight it), then shoot again
  await page.evaluate(() => {
    const r = window.gameClient.simulator.renderer
    const center = r.scene.getMeshByName('ground').position // ~(0,-1,0); page has no BABYLON global
    r.scene.onBeforeRenderObservable.add(() => {
      r.camera.position.set(12, 3, -15)
      r.camera.setTarget(center)
    })
  })
  await sleep(600)
  await page.screenshot({ path: '/tmp/scifi-overview.png' })

  console.log('pageerrors:', errors.length ? errors : 'none')
  console.log('screenshots: /tmp/scifi-pov.png /tmp/scifi-overview.png')
} finally {
  await browser.close()
}
