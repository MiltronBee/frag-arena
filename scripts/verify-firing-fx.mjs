// Verification: muzzle flash light pulse + barrel smoke (client/graphics/firingFx.js
// light/smoke presets, BABYLONRenderer._muzzleLight + smoke pool).
//
// Requires the local stack (npm start). Asserts the two new firing-FX layers work
// AND that they honor the perf contract they were designed around:
//   * exactly ONE muzzle point light exists, created at init (light COUNT constant
//     through firing — creating lights per shot would recompile every material)
//   * the light idles at intensity 0, pulses >0 on a shot, and decays back to 0
//   * barrel smoke puffs appear on shots (shotgun/pistol have chance 1.0)
//   * smoke lives in the WORLD layer even for the local player's vm-layer flash
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
const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

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
  await page.setViewport({ width: 800, height: 600 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && ' +
    'window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready',
    { timeout: 30000 }
  )

  const setInput = (fields) => page.evaluate((f) => {
    Object.assign(window.gameClient.simulator.input._currentState, f)
  }, fields)

  const switchTo = async (index, settleMs = 1500) => {
    await page.evaluate((i) => window.gameClient.simulator.switchWeapon(i), index)
    await page.waitForFunction(
      'window.gameClient.simulator.viewmodel && ' +
      'window.gameClient.simulator.viewmodel.ready && ' +
      'window.gameClient.simulator.viewmodel.spec.index === ' + index,
      { timeout: 20000 }
    )
    await sleep(settleMs)
  }

  // ---- A) init contract: one muzzle light, idle at 0, in the scene's light list ----
  const init = await page.evaluate(() => {
    const renderer = window.gameClient.simulator.renderer
    const scene = renderer.scene
    return {
      lightCount: scene.lights.length,
      lightNames: scene.lights.map((l) => l.name),
      muzzleLights: scene.lights.filter((l) => l.name === 'muzzleFlashLight').length,
      idleIntensity: renderer._muzzleLight ? renderer._muzzleLight.intensity : null,
      smokePool: renderer._pool.smoke ? renderer._pool.smoke.length : 0,
    }
  })
  check('exactly one pre-created muzzle light', init.muzzleLights === 1, init.lightNames.join(', '))
  check('muzzle light idles at intensity 0', init.idleIntensity === 0, 'intensity=' + init.idleIntensity)
  check('barrel smoke pool allocated', init.smokePool > 0, init.smokePool + ' puffs')

  // per-frame sampler: light intensity + visible smoke puffs + scene light count
  const sampleFx = (ms) => page.evaluate((durationMs) => new Promise((resolve) => {
    const renderer = window.gameClient.simulator.renderer
    const scene = renderer.scene
    const samples = []
    const observer = scene.onAfterRenderObservable.add(() => {
      samples.push({
        light: renderer._muzzleLight.intensity,
        smoke: renderer._pool.smoke.filter((m) => m.isVisible).length,
        lights: scene.lights.length,
      })
    })
    setTimeout(() => {
      scene.onAfterRenderObservable.remove(observer)
      resolve({
        count: samples.length,
        lightPeak: Math.max(...samples.map((s) => s.light)),
        lightEnd: samples[samples.length - 1].light,
        smokePeak: Math.max(...samples.map((s) => s.smoke)),
        lightCountMin: Math.min(...samples.map((s) => s.lights)),
        lightCountMax: Math.max(...samples.map((s) => s.lights)),
      })
    }, durationMs)
  }), ms)

  // ---- B) per weapon: burst → light pulses; settle → light back to 0 ----
  // expected peaks from firingFx WEAPON_FX[i].light.intensity
  const expected = { 0: 1.7, 1: 1.15, 2: 3.2, 3: 1.9 }
  for (const [index, name] of [[0, 'rifle'], [1, 'smg'], [2, 'shotgun'], [3, 'pistol']]) {
    await switchTo(index)
    await sleep(600) // let any previous pulse fully decay
    await setInput({ mouseDown: true })
    const firing = await sampleFx(1000)
    await setInput({ mouseDown: false })
    await sleep(500) // longest light.life is 110ms; 500 is decisive
    const settled = await sampleFx(300)

    // The muzzle light is intentionally STOCHASTIC now: per-shot peak jitter
    // (firingFx light.jitter=0.15 → intensity × [0.925, 1.075], Vlambeer "no
    // fixed-brightness tell") and QUADRATIC decay (decayPow=2, punchier falloff).
    // The per-frame sampler only lands near t≈0 by timing luck, so it routinely
    // under-catches a fast-decaying peak — measuring the exact preset peak is no
    // longer meaningful. So verify the invariant that matters: the light PULSES
    // meaningfully above idle when firing, and never exceeds the jittered ceiling.
    check(name + ': muzzle light pulses when firing',
      firing.lightPeak > expected[index] * 0.25 && firing.lightPeak <= expected[index] * 1.1,
      `peak ${firing.lightPeak.toFixed(2)} over ${firing.count} frames (preset ${expected[index]})`)
    check(name + ': light decays back to 0 after the burst',
      settled.lightPeak === 0,
      `settled peak ${settled.lightPeak}`)
    check(name + ': scene light count constant while firing (no recompile trigger)',
      firing.lightCountMin === firing.lightCountMax && firing.lightCountMax === init.lightCount,
      `lights ${firing.lightCountMin}-${firing.lightCountMax} (init ${init.lightCount})`)
    // smoke is chance-gated on rifle/smg; only assert on the chance:1.0 weapons
    if (index === 2 || index === 3) {
      check(name + ': barrel smoke puff visible during/after the shot',
        firing.smokePeak > 0, firing.smokePeak + ' puffs peak')
    }
  }

  // ---- C) smoke puffs live in the WORLD layer (local shot must not vm-layer them) ----
  await switchTo(3)
  await setInput({ mouseDown: true }); await sleep(100); await setInput({ mouseDown: false })
  const layers = await page.evaluate(() => {
    const renderer = window.gameClient.simulator.renderer
    return renderer._pool.smoke.filter((m) => m.isVisible).map((m) => m.layerMask)
  })
  check('active smoke puffs are world-layer', layers.length > 0 && layers.every((l) => l === 0x0FFFFFFF),
    layers.map((l) => '0x' + l.toString(16)).join(', ') || 'none visible')

  // ---- D) screenshot mid-burst for eyeballing ----
  await switchTo(2) // shotgun: biggest flash + light + smoke
  await setInput({ mouseDown: true })
  await sleep(60) // inside the 110ms light life of the first shot
  await page.screenshot({ path: 'frag-firing-fx.png' })
  await setInput({ mouseDown: false })

  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await browser.close()
}

console.log('\n=== firing FX (light + smoke) verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
