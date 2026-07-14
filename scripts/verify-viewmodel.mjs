// Regression test for first-person weapon lifecycle ownership.
//
// Requires the local stack to be running (npm start). It hammers the same
// switch path used by keyboard, touch, and mouse wheel, then verifies that stale
// async GLB imports did not leave duplicate rigs or GPU resources in the scene.
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
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail })
  return pass
}

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
    { timeout: 20000 }
  )

  const sceneStats = () => page.evaluate(() => {
    const simulator = window.gameClient.simulator
    const scene = simulator.renderer.scene
    const viewmodel = simulator.viewmodel
    const isLive = (resource) =>
      !resource.isDisposed || typeof resource.isDisposed !== 'function' || !resource.isDisposed()

    // Enabled state matters as much as liveness: the user-facing bug is a stale
    // rig still VISIBLE on screen, which liveness counts alone cannot see.
    const holders = scene.transformNodes.filter((node) => node.name === 'viewmodel' && isLive(node))
    const vmMeshes = scene.meshes.filter((mesh) => mesh.layerMask === 0x10000000 && isLive(mesh))
    const underLiveHolder = (mesh) => {
      for (let node = mesh; node; node = node.parent) {
        if (holders.indexOf(node) !== -1) return true
      }
      return false
    }
    const enabledVmMeshes = vmMeshes.filter((mesh) => mesh.isEnabled())

    return {
      weapon: simulator.weaponIndex,
      visualWeapon: viewmodel ? viewmodel.spec.index : null,
      holders: holders.length,
      enabledHolders: holders.filter((node) => node.isEnabled()).length,
      ghostMeshes: enabledVmMeshes.filter((mesh) => !underLiveHolder(mesh)).length,
      muzzles: scene.transformNodes.filter((node) => node.name === 'muzzle' && isLive(node)).length,
      meshes: vmMeshes.length,
      skeletons: scene.skeletons.length,
      animationGroups: scene.animationGroups.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      materialNames: scene.materials.map((material) => material.name),
      textureNames: scene.textures.map((texture) => texture.name),
      ownedSkeletons: viewmodel && viewmodel._result ? viewmodel._result.skeletons.length : 0,
      ownedGroups: viewmodel && viewmodel._result ? viewmodel._result.animationGroups.length : 0,
    }
  })

  const waitForEquippedViewmodel = () => page.waitForFunction(
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready && ' +
    'window.gameClient.simulator.viewmodel.spec.index === ' +
    'window.gameClient.simulator.weaponIndex',
    { timeout: 20000 }
  )

  // The sun's shadow generator lazily allocates a second RTT (sun_shadowMap2) on
  // its first shadow renders. Capturing baseline before that one-time allocation
  // would read as a per-swap texture leak on the first comparison. Wait until the
  // scene texture count is stable across renders so baseline includes every lazily
  // created resource. This does NOT weaken leak detection: a real leak adds a NEW
  // texture on EVERY swap, which the post-swap comparisons below still catch.
  const stableTextureCount = async () => {
    let prev = -1
    for (let i = 0; i < 40; i++) {
      const n = await page.evaluate(() => window.gameClient.simulator.renderer.scene.textures.length)
      if (n === prev) return n
      prev = n
      await sleep(200)
    }
    return prev
  }
  await stableTextureCount()

  const baseline = await sceneStats()

  // A high-resolution wheel or trackpad can emit many events in one frame.
  await page.evaluate(() => {
    const simulator = window.gameClient.simulator
    for (let i = 0; i < 25; i++) {
      simulator.switchWeapon(simulator.weaponIndex + 1)
    }
  })
  await waitForEquippedViewmodel()
  // land back on weapon 0 so the rig comparison is against the SAME weapon's
  // baseline (each weapon owns different mesh/material counts) regardless of
  // how the burst length divides the weapon count
  await page.evaluate(() => window.gameClient.simulator.switchWeapon(0))
  await waitForEquippedViewmodel()
  await sleep(250)
  const afterBurst = await sceneStats()

  check('rapid swaps leave one holder', afterBurst.holders === 1,
    'holders=' + afterBurst.holders)
  check('rapid swaps leave one muzzle', afterBurst.muzzles === 1,
    'muzzles=' + afterBurst.muzzles)
  check('visual and gameplay weapons agree', afterBurst.visualWeapon === afterBurst.weapon,
    'visual=' + afterBurst.visualWeapon + ' gameplay=' + afterBurst.weapon)
  check('rapid swaps do not leak rig resources',
    afterBurst.meshes === baseline.meshes &&
    afterBurst.skeletons === baseline.skeletons &&
    afterBurst.animationGroups === baseline.animationGroups &&
    afterBurst.ownedSkeletons === baseline.ownedSkeletons &&
    afterBurst.ownedGroups === baseline.ownedGroups,
    JSON.stringify({ baseline, afterBurst }))
  check('rapid swaps do not leak GPU resources',
    afterBurst.materials === baseline.materials &&
    afterBurst.textures === baseline.textures,
    'materials ' + baseline.materials + '->' + afterBurst.materials + ', ' +
    'textures ' + baseline.textures + '->' + afterBurst.textures)

  // Also exercise completed swaps, which catches leaks hidden by burst coalescing.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const simulator = window.gameClient.simulator
      simulator.switchWeapon(simulator.weaponIndex + 1)
    })
    await waitForEquippedViewmodel()
  }
  // same-weapon comparison (see burst note above)
  await page.evaluate(() => window.gameClient.simulator.switchWeapon(0))
  await waitForEquippedViewmodel()
  await sleep(250)
  const afterSequential = await sceneStats()

  check('completed swaps still leave one rig',
    afterSequential.holders === 1 &&
    afterSequential.muzzles === 1 &&
    afterSequential.visualWeapon === afterSequential.weapon,
    JSON.stringify(afterSequential))
  check('completed swaps keep resource totals stable',
    afterSequential.meshes === baseline.meshes &&
    afterSequential.skeletons === baseline.skeletons &&
    afterSequential.animationGroups === baseline.animationGroups &&
    afterSequential.materials === baseline.materials &&
    afterSequential.textures === baseline.textures,
    JSON.stringify({ baseline, afterSequential }))

  // The burst above coalesces into a single queued swap, and sequential swaps
  // always settle first — but real players also issue the next switch WHILE the
  // previous swap's GLB import is still in flight (tap Q, tap Q again a beat
  // later). That interleaving is what shipped the original ghost-gun bug: an
  // uncancellable import finishing after dispose() re-showed the dead rig.
  // Throttle the network and disable the HTTP cache so every import stays in
  // flight long enough for switches to land in each phase of the async
  // dispose/import lifecycle.
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 60,
    downloadThroughput: (20 * 1024 * 1024) / 8,
    uploadThroughput: (20 * 1024 * 1024) / 8,
  })

  const swapOnce = () => page.evaluate(() => {
    const simulator = window.gameClient.simulator
    simulator.switchWeapon(simulator.weaponIndex + 1)
  })

  let firstGhost = null
  for (const delay of [0, 60, 120, 180, 240]) {
    await swapOnce()
    await sleep(delay)
    await swapOnce()
    await waitForEquippedViewmodel()
    await sleep(250)
    const stats = await sceneStats()
    const clean = stats.holders === 1 && stats.enabledHolders === 1 &&
      stats.muzzles === 1 && stats.ghostMeshes === 0 &&
      stats.visualWeapon === stats.weapon
    if (!clean && !firstGhost) firstGhost = { delay, stats }
  }
  check('interleaved mid-import swaps leave exactly one visible rig',
    !firstGhost, firstGhost ? JSON.stringify(firstGhost) : '')

  // random-cadence soak for timing windows the fixed sweep misses
  for (let i = 0; i < 12; i++) {
    await swapOnce()
    await sleep(20 + Math.floor(Math.random() * 260))
  }
  await page.evaluate(() => { window.gameClient.simulator.switchWeapon(0) })
  await waitForEquippedViewmodel()
  await sleep(250)
  const afterSoak = await sceneStats()
  check('random-cadence soak settles to one visible weapon-0 rig',
    afterSoak.holders === 1 && afterSoak.enabledHolders === 1 &&
    afterSoak.muzzles === 1 && afterSoak.ghostMeshes === 0 &&
    afterSoak.weapon === 0 && afterSoak.visualWeapon === 0 &&
    afterSoak.skeletons === baseline.skeletons &&
    afterSoak.animationGroups === baseline.animationGroups,
    JSON.stringify(afterSoak))

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })

  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await browser.close()
}

console.log('\n=== viewmodel lifecycle verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
