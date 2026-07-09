// Headless-browser smoke test for the two-capsule netcode milestone.
//
// Launches two real game clients in headless Chrome against a running dev stack
// (`npm start`) and asserts the core netcode works end to end:
//   - both clients complete nengi's handshake over the ws transport
//   - entities replicate in both directions (each client sees the other)
//   - client-side prediction moves the local player from injected input
//   - that movement replicates through the authoritative server to the other client
//   - no uncaught client errors
//
// Lag-compensated hit registration is logged server-side ("you hit a player!")
// when this runs; watch the server console to see it.
//
// Usage: npm start   (in one terminal)
//        npm run verify   (in another)
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
    // software WebGL so Babylon can render without a GPU
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=800,600',
    // keep BOTH tabs' requestAnimationFrame running — otherwise a backgrounded
    // client's game loop is throttled to ~0 and it stops reading the network.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

async function openClient() {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  const errors = []
  page.on('console', (m) => { if (m.text().includes('onConnect response')) page._connected = true })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  // wait until our own raw entity actually exists (a few ticks after identity),
  // not merely until connected — otherwise entities read empty.
  await page.waitForFunction(
    "window.gameClient && window.gameClient.simulator && !!window.gameClient.simulator.myRawEntity && window.gameClient.client.entities.size > 0",
    { timeout: 15000 }
  )
  page._errors = errors
  return page
}

const playerPositions = (page) => page.evaluate(() => {
  const out = []
  const s = window.gameClient.simulator
  for (const e of window.gameClient.client.entities.values()) {
    if (e.protocol && e.protocol.name === 'PlayerCharacter') {
      out.push({ nid: e.nid, x: +e.x.toFixed(3), z: +e.z.toFixed(3) })
    }
  }
  return {
    size: window.gameClient.client.entities.size,
    players: out,
    // own-entity presence by id — robust even when OTHER people are connected
    // to the dev server (e.g. the developer's own browser tab)
    hasOwnRaw: out.some((p) => p.nid === s.myRawId),
    hasOwnSmooth: out.some((p) => p.nid === s.mySmoothId),
  }
})

const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

try {
  const A = await openClient()
  const aSolo = await playerPositions(A)

  const B = await openClient()
  await sleep(2000)
  await A.bringToFront()
  await sleep(500) // Settle: allow brought-to-front tab to process queue
  const aWithB = await playerPositions(A)
  const bWithA = await playerPositions(B)

  check('A completed handshake', !!A._connected)
  check('B completed handshake', !!B._connected)
  check('A sees its own two entities', aSolo.hasOwnRaw && aSolo.hasOwnSmooth, `raw=${aSolo.hasOwnRaw} smooth=${aSolo.hasOwnSmooth} (${aSolo.players.length} players in room)`)
  check('A sees the new player after B joins', aWithB.players.length > aSolo.players.length, `${aSolo.players.length} -> ${aWithB.players.length}`)
  check('B sees other players', bWithA.players.length >= 2, `players=${bWithA.players.length}`)

  const before = aWithB.players.map((p) => `${p.nid}:${p.x},${p.z}`).sort()

  // drive B (foreground so its loop ticks): aim at A and fire, then run forward.
  await B.bringToFront()
  const bTickBefore = await B.evaluate(() => window.gameClient.client.tick)
  await B.evaluate(() => { window.gameClient.simulator.input._currentState.mouseDown = true })
  for (let i = 0; i < 20; i++) {
    await B.evaluate(() => {
      const s = window.gameClient.simulator
      for (const e of window.gameClient.client.entities.values()) {
        if (e.protocol && e.protocol.name === 'PlayerCharacter' && e.nid !== s.myRawId && e.nid !== s.mySmoothId) {
          s.renderer.camera.setTarget(e.mesh.position)
          break
        }
      }
    })
    await sleep(50)
  }
  // turn AWAY from A before running — players spawn apart now, and running into
  // A's collision box would (correctly) stop us after a few centimeters
  const bStart = await B.evaluate(() => {
    const s = window.gameClient.simulator
    const c = s.renderer.camera
    // setTarget (aim phase) switched the camera to quaternion rotation, which makes
    // euler .rotation writes silently ignored — convert back before turning
    if (c.rotationQuaternion) { c.rotation = c.rotationQuaternion.toEulerAngles(); c.rotationQuaternion = null }
    c.rotation.y += Math.PI
    return { x: s.myRawEntity.x, z: s.myRawEntity.z }
  })
  await B.evaluate(() => { window.gameClient.simulator.input._currentState.forwards = true })
  await sleep(1800)
  await B.evaluate(() => {
    const cs = window.gameClient.simulator.input._currentState
    cs.forwards = false; cs.mouseDown = false
  })
  await sleep(600)

  const bMoved = await B.evaluate(() => {
    const s = window.gameClient.simulator
    return { x: s.myRawEntity.x, z: s.myRawEntity.z, tick: window.gameClient.client.tick }
  })
  // measure total horizontal displacement — spawn angle + aim direction are random,
  // so the run direction is arbitrary (not necessarily along Z)
  const bDist = Math.hypot(bMoved.x - bStart.x, bMoved.z - bStart.z)
  check('B game loop advanced', bMoved.tick - bTickBefore > 30, `+${bMoved.tick - bTickBefore} ticks`)
  check('B predicted its own movement', bDist > 1, `moved=${bDist.toFixed(2)}`)

  await A.bringToFront()
  await sleep(300)
  const after = (await playerPositions(A)).players.map((p) => `${p.nid}:${p.x},${p.z}`).sort()
  check('A sees B move (replication + interpolation)', JSON.stringify(before) !== JSON.stringify(after))

  check('no uncaught client errors', A._errors.length === 0 && B._errors.length === 0,
    [...A._errors, ...B._errors].join(' | '))
} catch (e) {
  check('harness ran to completion', false, e.message)
} finally {
  let failed = 0
  console.log('\n=== netcode verification ===')
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
    if (!c.pass) failed++
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  await browser.close()
  process.exit(failed === 0 ? 0 : 1)
}
