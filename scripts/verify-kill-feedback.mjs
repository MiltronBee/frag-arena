// End-to-end kill-FEEDBACK verification (the FragLayer client layer).
//
// Requires the local stack (npm start). Two real clients: p1 kills p2. Asserts
// the client-side juice layer reacts to the three server messages:
//   * KILL FEED: a kill-feed entry appears in the DOM after the frag
//   * FRAG BANNER: the centered "YOU FRAGGED ..." banner shows for the killer
//   * CORPSE (not vanish): the victim's CharacterModel is posed as a corpse — via
//     the Death clip frozen on its last frame (usingDeathClip), or the procedural
//     holder tip fallback (rotationQuaternion) — and still enabled at death,
//     instead of the old instant setEnabled(false) vanish
//   * HITMARKER UPGRADE: HitConfirmed reaches the attacker (kill marker active)
//   * no uncaught client errors on either side
//
// Modeled on scripts/verify-1v1.mjs (same launch flags, aim/fire helpers).
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

// one browser PER client so BOTH game loops run at full rAF (see verify-1v1.mjs).
const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]
const browsers = []

async function openClient() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: LAUNCH_ARGS,
  })
  browsers.push(browser)
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && ' +
    'window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.mySmoothEntity && ' +
    'window.gameClient.simulator.fragLayer && ' +
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready',
    { timeout: 30000 }
  )
  return page
}

const setInput = (page, fields) => page.evaluate((f) => {
  Object.assign(window.gameClient.simulator.input._currentState, f)
}, fields)

const snapshot = (page) => page.evaluate(() => {
  const s = window.gameClient.simulator
  const e = s.myRawEntity
  return {
    x: e.x, y: e.y, z: e.z,
    hp: e.hitpoints, alive: e.isAlive !== false,
    smoothNid: s.mySmoothEntity ? s.mySmoothEntity.nid : -1,
  }
})

const aimAt = (page, target) => page.evaluate((t) => {
  const cam = window.gameClient.simulator.renderer.camera
  const dx = t.x - cam.position.x
  const dy = t.y - cam.position.y
  const dz = t.z - cam.position.z
  cam.rotation.y = Math.atan2(dx, dz)
  cam.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz))
}, target)

// read FragLayer / DOM state on a page
const feedback = (page) => page.evaluate(() => {
  const feed = document.getElementById('kill-feed')
  const banner = document.getElementById('frag-banner')
  const hitMarker = document.getElementById('hit-marker')
  return {
    feedRows: feed ? feed.children.length : -1,
    feedText: feed ? feed.textContent.replace(/\s+/g, ' ').trim() : '',
    bannerShown: !!(banner && banner.classList.contains('frag-banner-show')),
    bannerText: banner ? banner.textContent : '',
    killMarker: !!(hitMarker && hitMarker.classList.contains('kill-active')),
  }
})

// inspect the victim's CharacterModel on the SHOOTER's client (it renders the
// victim as a remote CharacterModel keyed by the victim's smooth nid).
const victimCorpse = (page, victimSmoothNid) => page.evaluate((nid) => {
  const s = window.gameClient.simulator
  const model = s.characterModels.get(nid)
  if (!model || !model.holder) return { found: false }
  return {
    found: true,
    corpse: !!model._corpse,
    enabled: model.holder.isEnabled(),
    // the corpse pose now comes from the Death CLIP (usingDeathClip) frozen on its
    // last frame; the procedural holder tip (rotationQuaternion) is a fallback only
    // when the clip is missing. Either one means "posed as a corpse, not vanished".
    tipped: !!model.holder.rotationQuaternion,
    usingDeathClip: !!model._usingDeathClip,
  }
}, victimSmoothNid)

try {
  const p1 = await openClient() // the shooter
  const p2 = await openClient() // the victim
  await sleep(1200) // let both fully replicate

  const p2Start = await snapshot(p2)
  const p1Start = await snapshot(p1)
  check('both clients spawned alive with a fragLayer',
    p2Start.alive && p1Start.alive, JSON.stringify({ p1: p1Start.smoothNid, p2: p2Start.smoothNid }))

  // latch the kill-marker on the shooter: the kill CSS class only holds ~520ms,
  // so a post-hoc DOM read races the timer. A MutationObserver records that it
  // ever went 'kill-active' (the confirm-upgrade fired) regardless of when we read.
  await p1.evaluate(() => {
    window.__killMarkerSeen = false
    const el = document.getElementById('hit-marker')
    if (!el) return
    // synchronous latch: a MutationObserver races follow-up shots — the shooter
    // keeps firing after the kill and each predicted hit swaps kill-active for
    // hit-active before the (async) observer callback gets to look.
    const origAdd = el.classList.add.bind(el.classList)
    el.classList.add = (...cls) => {
      if (cls.includes('kill-active')) window.__killMarkerSeen = true
      return origAdd(...cls)
    }
  })

  // ---- kill p2 with sustained rifle fire ----
  await aimAt(p1, p2Start)
  await sleep(500) // orient the server entity via MoveCommand stream
  await setInput(p1, { mouseDown: true })
  await p2.waitForFunction('window.gameClient.simulator.myRawEntity.isAlive === false', { timeout: 10000 })
    .catch(() => {})
  // hold a moment past death so the kill marker / confirm is observable
  await sleep(250)
  await setInput(p1, { mouseDown: false })
  await sleep(400)

  const dead = await snapshot(p2)
  check('victim actually died', !dead.alive && dead.hp === 0, JSON.stringify(dead))

  // ---- KILL FEED: an entry appears on both clients (broadcast) ----
  const fbShooter = await feedback(p1)
  const fbVictim = await feedback(p2)
  check('kill-feed entry appears in the DOM (shooter)',
    fbShooter.feedRows >= 1, `${fbShooter.feedRows} rows: "${fbShooter.feedText}"`)
  check('kill-feed entry appears in the DOM (victim)',
    fbVictim.feedRows >= 1, `${fbVictim.feedRows} rows: "${fbVictim.feedText}"`)

  // ---- FRAG BANNER: shown for the killer ----
  check('frag banner shown for the killer',
    fbShooter.bannerShown && /FRAGGED/i.test(fbShooter.bannerText),
    `shown=${fbShooter.bannerShown} text="${fbShooter.bannerText}"`)

  // ---- HITMARKER UPGRADE: the kill marker fired on the shooter (latched) ----
  const killMarkerSeen = await p1.evaluate(() => !!window.__killMarkerSeen)
  check('kill hitmarker upgrade fired on the shooter',
    killMarkerSeen, `kill-active seen=${killMarkerSeen}`)

  // ---- CORPSE not instant-vanish: victim model tipped/enabled on the shooter ----
  const corpse = await victimCorpse(p1, p2Start.smoothNid)
  check('victim rendered as a corpse (not instant vanish)',
    corpse.found && corpse.corpse && corpse.enabled && (corpse.usingDeathClip || corpse.tipped),
    JSON.stringify(corpse))

  // ---- respawn resets the corpse cleanly ----
  await p2.waitForFunction('window.gameClient.simulator.myRawEntity.isAlive === true', { timeout: 8000 })
    .catch(() => {})
  await sleep(1200) // let the corpse timer's respawn-cancel path run on the shooter
  const afterRespawn = await victimCorpse(p1, p2Start.smoothNid)
  check('corpse reset to a clean pose after respawn',
    afterRespawn.found && !afterRespawn.corpse && !afterRespawn.tipped && afterRespawn.enabled,
    JSON.stringify(afterRespawn))

  check('no uncaught client errors', p1.errors.length === 0 && p2.errors.length === 0,
    [...p1.errors, ...p2.errors].join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await Promise.all(browsers.map((b) => b.close()))
}

console.log('\n=== kill-feedback (FragLayer) verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
