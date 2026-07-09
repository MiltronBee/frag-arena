// Headless smoke test for UT99-style movement (common/applyCommand.js).
//
// Drives one real client in headless Chrome against a running dev stack
// (`npm start`) and asserts the movement model behaves:
//   - jump: leaves the floor, arcs to a UT-ish apex, gravity brings it back
//   - dodge: a double-tap burst well above run speed + a hop, bled off by
//     ground friction after landing
//   - prediction stays healthy (no reconciliation error spam while moving)
//
// Usage: npm start   (in one terminal)
//        npm run verify:movement   (in another)
//
// Exit code 0 = all assertions passed, 1 = failure.
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
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ]
    CHROME = paths.find(p => fs.existsSync(p))
  } else {
    CHROME = '/usr/bin/google-chrome'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=800,600',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

// samples { y, velY, grounded, speedXZ } of our own predicted entity every ~16ms
const startSampling = (page) => page.evaluate(() => {
  const s = window.gameClient.simulator
  window.__samples = []
  window.__sampler = setInterval(() => {
    const e = s.myRawEntity
    window.__samples.push({
      y: e.y,
      velY: e.velY,
      grounded: e.grounded,
      speed: Math.hypot(e.velX, e.velZ),
    })
  }, 16)
})
const stopSampling = (page) => page.evaluate(() => {
  clearInterval(window.__sampler)
  return window.__samples
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  const errors = []
  let predictionErrors = 0
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.text().includes('prediciton error')) predictionErrors++ })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && !!window.gameClient.simulator.myRawEntity',
    { timeout: 15000 }
  )
  await sleep(500) // settle: first frames include the spawn drop to the floor

  /* jump: tap space, watch the arc */
  await startSampling(page)
  await page.evaluate(() => {
    const s = window.gameClient.simulator
    const startY = s.myRawEntity ? s.myRawEntity.y : 0
    s.input._currentState.jump = true
    const interval = setInterval(() => {
      if (s.myRawEntity && s.myRawEntity.y > startY + 0.05) {
        s.input._currentState.jump = false
        clearInterval(interval)
      }
    }, 16)
    // Fallback safety to release key in case it doesn't jump
    setTimeout(() => { clearInterval(interval); s.input._currentState.jump = false }, 1500)
  })
  // Poll until the jump lands back on the ground, up to 5 seconds
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    const samples = await page.evaluate(() => window.__samples)
    if (samples && samples.length > 0) {
      const last = samples[samples.length - 1]
      const hasLeftFloor = samples.some(s => s.y > 0.1)
      if (hasLeftFloor && last.grounded && last.y < 0.05) {
        break
      }
    }
  }
  const jump = await stopSampling(page)
  const apex = Math.max(...jump.map((s) => s.y))
  const last = jump[jump.length - 1]
  check('jump leaves the floor', apex > 0.3, `apex=${apex.toFixed(2)}m`)
  check('jump apex is UT-ish (~1m)', apex > 0.7 && apex < 1.5, `apex=${apex.toFixed(2)}m`)
  const gravityPass = last.y < 0.05 && last.grounded;
  check('gravity brings us back down', gravityPass, `y=${last.y.toFixed(3)} grounded=${last.grounded}`);
  if (!gravityPass) {
    console.log("Jump samples Y:", jump.map(s => s.y.toFixed(3)).join(', '));
    console.log("Jump samples grounded:", jump.map(s => s.grounded).join(', '));
  }

  /* dodge: double-tap burst + hop, friction bleeds it after landing */
  await startSampling(page)
  await page.evaluate(() => {
    // inject the already-detected double-tap (frameState.dodge is consumed by
    // the next simulator update, exactly like a real double-tap)
    window.gameClient.simulator.input.frameState.dodge = 'left'
  })
  // Poll until we land and friction slows us down, up to 5 seconds
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    const samples = await page.evaluate(() => window.__samples)
    if (samples && samples.length > 0) {
      const last = samples[samples.length - 1]
      const hasLeftFloor = samples.some(s => s.y > 0.1)
      if (hasLeftFloor && last.grounded && last.speed < 1 && last.y < 0.05) {
        break
      }
    }
  }
  const dodge = await stopSampling(page)
  const burst = Math.max(...dodge.map((s) => s.speed))
  const hop = Math.max(...dodge.map((s) => s.y))
  const settled = dodge[dodge.length - 1]
  check('dodge bursts above run speed', burst > 9, `burst=${burst.toFixed(1)}m/s (run=7.6)`)
  check('dodge hops off the floor', hop > 0.05, `hop=${hop.toFixed(2)}m`)
  check('friction bleeds the dodge after landing', settled.speed < 1, `settled=${settled.speed.toFixed(2)}m/s`)

  /* run + jump together: prediction should stay clean through all of it */
  await page.evaluate(() => {
    const s = window.gameClient.simulator
    s.input._currentState.forwards = true
    s.input._currentState.jump = true
  })
  await sleep(1500)
  await page.evaluate(() => {
    const s = window.gameClient.simulator
    s.input._currentState.forwards = false
    s.input._currentState.jump = false
  })
  await sleep(400)
  check('prediction stays healthy (no reconciliation spam)', predictionErrors < 10, `${predictionErrors} corrections`)
  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (e) {
  check('harness ran to completion', false, e.message)
} finally {
  let failed = 0
  console.log('\n=== movement verification ===')
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
    if (!c.pass) failed++
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  await browser.close()
  process.exit(failed === 0 ? 0 : 1)
}
