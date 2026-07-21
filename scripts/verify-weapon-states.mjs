// Weapon state-machine race + soak verification (live browser).
//
// Drives the REAL first-person weapon FSM (client/graphics/Viewmodel.js) through
// the REAL code paths — input state for fire/reload, switchWeapon for swaps, and
// the viewmodel's own setActive for death/respawn — and hammers every overlap the
// state model must survive: fire tap/hold/release, empty-mag, reload on
// full/partial, held reload, fire-during-reload, swap during fire/reload/draw/
// import, rapid 1-2-3-1, repeated same slot, death mid-animation, respawn,
// fire+swap bursts, rejected cooldown shots, and the projectile weapon (Plasma)
// whose replicated entities exercise the factory create/delete path. It finishes
// with a seeded randomized soak of hundreds of mixed actions.
//
// Invariants after every scenario and across the soak: exactly one visible holder
// + muzzle, visual weapon == gameplay weapon, no ghost rig, the FSM settles out of
// firing/reloading/drawing, no per-weapon resource leak (skeletons/groups/
// materials/textures vs that weapon's own baseline, projectiles allowed to expire
// first), and NO uncaught client/console error.
//
// Requires the local stack (npm start).
import puppeteer from 'puppeteer-core'
import os from 'os'
import fs from 'fs'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
let CHROME = process.env.CHROME_BIN
if (!CHROME) {
  if (os.platform() === 'win32') {
    CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p))
  } else { CHROME = '/usr/bin/google-chrome' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

// seeded PRNG so a soak failure is reproducible from the printed seed
const SEED = parseInt(process.env.SOAK_SEED || '', 10) || 1337
let _s = SEED >>> 0
const rand = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000 }
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600 })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.viewmodel && window.gameClient.simulator.viewmodel.ready',
    { timeout: 30000 })

  const setInput = (f) => page.evaluate((x) => Object.assign(window.gameClient.simulator.input._currentState, x), f)
  const fireDown = () => setInput({ mouseDown: true })
  const fireUp = () => setInput({ mouseDown: false })
  const tapReload = async () => { await setInput({ reload: true }); await sleep(90); await setInput({ reload: false }) }
  const swapNext = () => page.evaluate(() => window.gameClient.simulator.switchWeapon(window.gameClient.simulator.weaponIndex + 1))
  const swapTo = (i) => page.evaluate((n) => window.gameClient.simulator.switchWeapon(n), i)
  // death/respawn reach the viewmodel as setActive(false/true); drive that directly
  // (the server keeps us alive, so toggling predicted isAlive would be reconciled away).
  const setVmActive = (on) => page.evaluate((a) => { const vm = window.gameClient.simulator.viewmodel; if (vm) vm.setActive(a) }, on)

  const stats = () => page.evaluate(() => {
    const sim = window.gameClient.simulator
    const scene = sim.renderer.scene
    const vm = sim.viewmodel
    const live = (n) => !n.isDisposed || typeof n.isDisposed !== 'function' || !n.isDisposed()
    const holders = scene.transformNodes.filter((n) => n.name === 'viewmodel' && live(n))
    const vmMeshes = scene.meshes.filter((m) => m.layerMask === 0x10000000 && live(m))
    const underLiveHolder = (mesh) => { for (let n = mesh; n; n = n.parent) if (holders.indexOf(n) !== -1) return true; return false }
    return {
      weapon: sim.weaponIndex,
      visualWeapon: vm ? vm.spec.index : null,
      state: vm ? vm._state : null,
      reloading: vm ? vm._reloading : null,
      vmNull: !vm,
      holders: holders.length,
      enabledHolders: holders.filter((n) => n.isEnabled()).length,
      muzzles: scene.transformNodes.filter((n) => n.name === 'muzzle' && live(n)).length,
      // a ghost must be actually RENDERING (isVisible + non-faded). isEnabled() alone
      // over-counts: pooled muzzle/glow FX sprites keep the vm layerMask after their
      // flash fades (only isVisible resets), and the vmLightAnchor is a permanently
      // invisible helper — neither draws a single pixel.
      ghosts: vmMeshes.filter((m) => m.isEnabled() && m.isVisible && m.visibility > 0.02 && !underLiveHolder(m)).length,
      skeletons: scene.skeletons.length,
      animationGroups: scene.animationGroups.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      projectiles: [...window.gameClient.client.entities.values()].filter((e) => e.protocol && e.protocol.name === 'Projectile').length,
    }
  })

  const waitEquipped = () => page.waitForFunction(
    'window.gameClient.simulator.viewmodel && window.gameClient.simulator.viewmodel.ready && ' +
    'window.gameClient.simulator.viewmodel.spec.index === window.gameClient.simulator.weaponIndex',
    { timeout: 20000 })
  // equip, let the draw clip (weapons that ship one) finish, then settle. A truly
  // stuck draw is still caught: the wait times out silently and the settled-state
  // assert sees state==='drawing' and fails.
  const settleEquipped = async (ms = 1200) => {
    await waitEquipped()
    await page.waitForFunction(
      "window.gameClient.simulator.viewmodel._state !== 'drawing'",
      { timeout: 8000 }).catch(() => {})
    await sleep(ms)
  }
  // let any in-flight plasma bolts (lifeTime 3s) expire so their materials don't
  // count as a rig leak
  const clearProjectiles = async () => { for (let i = 0; i < 25; i++) { if ((await stats()).projectiles === 0) return; await sleep(200) } }

  // UT-STYLE OWNERSHIP: a fresh spawn owns only the pistol, and switchWeapon refuses
  // unowned slots — which would silently no-op every swap below and shrink the suite
  // to pistol-only. Grant the full arsenal + ammo CLIENT-side: ownedWeapons is
  // down-only and nengi only re-sends on server-side change (which never happens
  // here — no pickups are touched), so the override sticks for the whole run. The
  // server still refuses the unowned fire/switch commands, which is fine — this
  // suite exercises the client-side visual FSM, not server hit resolution.
  await page.evaluate(() => {
    const raw = window.gameClient.simulator.myRawEntity
    raw.ownedWeapons = (1 << raw.weaponsState.length) - 1
    raw.weaponsState.forEach((st) => { st.magazineAmmo = Math.max(st.magazineAmmo, 30); st.reserveAmmo = Math.max(st.reserveAmmo, 90) })
  })

  // warm up lazy resources (shadow RTT) before capturing baselines
  const stableTex = async () => { let p = -1; for (let i = 0; i < 40; i++) { const n = (await stats()).textures; if (n === p) return; p = n; await sleep(200) } }
  await stableTex()

  // per-weapon rig baselines: each weapon has its own clip/material/texture totals
  // (shotgun ships 11 clips, the others 8; Plasma reuses the rifle rig). Comparing a
  // settle against the WRONG weapon's baseline was the only "leak" the first pass saw.
  const wbase = []
  // weapon count from the live entity so the suite tracks the config automatically
  const WEAPON_COUNT = await page.evaluate(() => window.gameClient.simulator.myRawEntity.weaponsState.length)
  for (let i = 0; i < WEAPON_COUNT; i++) {
    await swapTo(i); await settleEquipped(900); await clearProjectiles()
    wbase[i] = await stats()
  }
  await swapTo(0); await settleEquipped()
  const skelBase = wbase[0].skeletons

  const settledInvariant = (label, s, { expectActive = true } = {}) => {
    const b = wbase[s.weapon] || wbase[0]
    const okRig = s.holders === 1 && s.enabledHolders === (expectActive ? 1 : 0) && s.muzzles === 1 && s.ghosts === 0
    const okAgree = s.visualWeapon === s.weapon
    const okSettled = !expectActive || s.state === 'idle'
    const okLeak = s.skeletons === skelBase && s.animationGroups === b.animationGroups &&
      s.materials === b.materials && s.textures === b.textures
    check(`${label}: one visible rig, visual==gameplay, settled, no leak`,
      okRig && okAgree && okSettled && okLeak, JSON.stringify(s))
  }

  // ---------- A) fire tap / hold / release, empty-mag, cooldown ----------
  await swapTo(0); await settleEquipped()
  await fireDown(); await sleep(60); await fireUp(); await sleep(1300)
  settledInvariant('A1 fire tap', await stats())
  await fireDown(); await sleep(1200); await fireUp(); await sleep(1300)
  settledInvariant('A2 fire hold+release', await stats())
  await fireDown(); await sleep(3000); await fireUp(); await sleep(1300) // drain magazine, keep firing empty
  const drained = await stats()
  check('A3 empty-mag fire does not stick in FIRING', drained.state === 'idle', JSON.stringify(drained))

  // ---------- B) reload full/partial, held reload, fire-during-reload ----------
  await tapReload(); await sleep(1900)
  settledInvariant('B1 reload after empty', await stats())
  await fireDown(); await sleep(350); await fireUp(); await sleep(1300) // fire a few, settle
  await tapReload(); await sleep(300)
  const midReload = await stats()
  check('B2 reload enters RELOADING', midReload.state === 'reloading' && midReload.reloading === true, JSON.stringify(midReload))
  if (midReload.state === 'reloading') {
    // this game cancels a reload by shooting (reload-cancel-by-fire): the mid-reload
    // fire must cleanly cancel the reload and settle back to idle — never stick in
    // reloading and never freeze the gun (the frozen-gun case is caught by
    // verify-fire-attachment's cancelled-reload check).
    await fireDown(); await sleep(200); await fireUp(); await sleep(1400)
    const dr = await stats()
    check('B3 fire during reload cancels cleanly, settles to idle (not stuck reloading)',
      dr.state === 'idle' && dr.reloading === false, JSON.stringify(dr))
  } else {
    check('B3 fire during reload cancels cleanly, settles to idle (not stuck reloading)',
      false, 'precondition: not mid-reload: ' + JSON.stringify(midReload))
  }
  await sleep(600)
  settledInvariant('B4 reload/idle after fire-cancel', await stats())
  await setInput({ reload: true }); await sleep(1900); await setInput({ reload: false }); await sleep(600) // held reload
  settledInvariant('B5 held reload', await stats())

  // ---------- C) swap during fire / reload / draw / import ----------
  await fireDown()
  await swapNext(); await sleep(60); await swapNext(); await sleep(60); await swapNext()
  await fireUp(); await settleEquipped()
  settledInvariant('C1 swap during fire burst', await stats())
  await swapTo(0); await settleEquipped()
  await tapReload(); await sleep(250); await swapNext(); await settleEquipped()
  settledInvariant('C2 swap during reload', await stats())
  await swapTo(1); await sleep(40); await swapTo(3); await sleep(40); await swapTo(1); await settleEquipped() // draw + mid-import
  settledInvariant('C3 swap during draw + import', await stats())

  // ---------- D) rapid 1-2-3-1, repeated same slot ----------
  await swapTo(0); await swapTo(1); await swapTo(2); await swapTo(0); await settleEquipped()
  settledInvariant('D1 rapid 1-2-3-1', await stats())
  await swapTo(2); await swapTo(2); await swapTo(2); await settleEquipped()
  settledInvariant('D2 repeated same slot', await stats())

  // ---------- E) death during fire / reload / draw, respawn ----------
  await swapTo(0); await settleEquipped()
  await fireDown(); await sleep(80); await setVmActive(false); await fireUp(); await sleep(500)
  const deadFiring = await stats()
  check('E1 death during fire hides rig', deadFiring.state === 'hidden' && deadFiring.enabledHolders === 0, JSON.stringify(deadFiring))
  await setVmActive(true); await sleep(1200)
  settledInvariant('E2 respawn after death-in-fire', await stats())
  await tapReload(); await sleep(250); await setVmActive(false); await sleep(300); await setVmActive(true); await sleep(1400)
  settledInvariant('E3 death during reload + respawn', await stats())

  // (section F, the plasma projectile weapon, was removed with weapon slot 5 —
  // the projectile plumbing is dormant until a real energy weapon ships)

  // ---------- G) seeded randomized soak ----------
  const ACTIONS = ['fireTap', 'fireHold', 'reload', 'swapNext', 'swapRand', 'death', 'idle']
  const SOAK_N = parseInt(process.env.SOAK_N || '200', 10)
  let soakViolations = 0
  let firstViolation = null
  for (let i = 0; i < SOAK_N; i++) {
    const a = pick(ACTIONS)
    if (a === 'fireTap') { await fireDown(); await sleep(30 + Math.floor(rand() * 90)); await fireUp() }
    else if (a === 'fireHold') { await fireDown(); await sleep(120 + Math.floor(rand() * 400)); await fireUp() }
    else if (a === 'reload') { await tapReload() }
    else if (a === 'swapNext') { await swapNext() }
    else if (a === 'swapRand') { await swapTo(Math.floor(rand() * WEAPON_COUNT)) }
    else if (a === 'death') { await setVmActive(false); await sleep(40 + Math.floor(rand() * 120)); await setVmActive(true) }
    else { await sleep(40 + Math.floor(rand() * 120)) }
    // mid-soak: transient states/materials are fine; rig SHAPE never is
    if (i % 10 === 0) {
      const s = await stats()
      const shapeOk = (s.vmNull || (s.holders <= 1 && s.muzzles <= 1 && s.ghosts === 0)) && s.skeletons <= skelBase
      if (!shapeOk) { soakViolations++; if (!firstViolation) firstViolation = { i, a, s } }
    }
  }
  // settle everything and assert a clean, leak-free, agreeing final state on weapon 0
  await fireUp(); await setInput({ reload: false }); await setVmActive(true)
  await swapTo(0); await settleEquipped(1400); await clearProjectiles()
  check(`G1 soak (seed ${SEED}, ${SOAK_N} actions) held rig-shape invariants throughout`,
    soakViolations === 0, firstViolation ? JSON.stringify(firstViolation) : 'no violations')
  settledInvariant('G2 soak settled clean, no leak', await stats())

  check('no uncaught client/console errors across all scenarios', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message + '\n' + (error.stack || ''))
} finally {
  await browser.close()
}

console.log('\n=== weapon state-machine race + soak verification ===')
let failed = 0
for (const r of checks) {
  console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''))
  if (!r.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
