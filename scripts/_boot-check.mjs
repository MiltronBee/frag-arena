// Minimal prod boot check: load the live page, deploy, wait for the entity + a few
// frames, and report any console/page errors. Confirms the freshly-deployed bundle
// evaluates and the audio-bus + viewmodel-framing rewrites don't throw at runtime.
import puppeteer from 'puppeteer-core'
const URL = process.env.FRAG_URL || 'https://sol-pkmn.fun/'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }) // portrait: exercises the vm-framing path
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
  { timeout: 45000 })
await page.evaluate(() => {
  const s = window.gameClient.simulator
  s.audio.resume()   // headless has no gesture; kick the WebAudio bus directly (builds voiceBus)
  s.music.unlock()
  s.requestDeploy()
})
await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
await sleep(4000) // let a few frames + the audio load run

// probe the runtime state my changes touch
const state = await page.evaluate(() => {
  const s = window.gameClient.simulator
  const a = s.audio
  return {
    build: window.__BUILD_ID__,
    voiceBusWired: !!(a && a.voiceBus),          // narrator bus exists after resume()
    musicDuckWired: typeof (a && a._musicDuck) === 'function',
    vmFraming: s.renderer && s.renderer.scene && s.renderer.scene.metadata
      ? s.renderer.scene.metadata.vmFraming : null,
    musicVol: s.music ? s.music.baseVolume : null,
  }
})
console.log(JSON.stringify({ url: URL, state, errors }, null, 2))
await browser.close()
process.exit(errors.length ? 1 : 0)
