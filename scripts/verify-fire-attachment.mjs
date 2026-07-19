// Regression test: the gun must stay attached to the hands through firing.
//
// Requires the local stack (npm start). Exercises the REAL input path
// (mouseDown/reload on the input state) so cooldown/reload/cancel interplay is
// covered, and samples the rig EVERY FRAME during bursts:
//   * two-handed weapons: the left-hand bone must track the gun through recoil
//     (regression: fire's left-arm channels were stripped and replaced by a
//     zero-weight "IK lock", freezing the arm while the gun kicked)
//   * cancelled reloads must not freeze gun-only bones (weapon root, slide,
//     magazine) away from the base pose
//   * rapid shoot+swap sequences must leave exactly one attached rig
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
    await sleep(settleMs) // draw anim + idle settle
  }

  // sample hand->gun distance once per render frame for `ms` milliseconds.
  // Uses the pack's own bones: hand_l (skinned left hand) vs the weapon armature
  // root; distances are in model units (centimeters for these GLBs).
  const trackAttachment = (ms, refName) => page.evaluate(({ durationMs, refName }) => new Promise((resolve) => {
    const simulator = window.gameClient.simulator
    const scene = simulator.renderer.scene
    const vm = simulator.viewmodel
    const find = (name) => scene.transformNodes.find(
      (n) => n.name === name && (!n.isDisposed || !n.isDisposed()))
    // Reference node the support hand should ride. Default = the gun armature root.
    // The pump-action Shotgun's support hand rides the sliding fore-end, so it must be
    // measured against the pump bone ('Forearm'): relative to the receiver/root it
    // travels the full authored pump stroke every shot, which is NOT a detachment.
    const gun = (refName && find(refName)) ||
      find('Rifle_01_Armature') || find('Pistol_01_Armature') ||
      scene.transformNodes.find((n) => /_?Armature$/.test(n.name) &&
        n.name !== 'Arms_Armature' && (!n.isDisposed || !n.isDisposed()))
    const hand = find('hand_l')
    if (!gun || !hand || !vm || !vm.holder) { resolve(null); return }
    const inv = new BABYLON.Matrix()
    const samples = []
    const observer = scene.onAfterAnimationsObservable.add(() => {
      vm.holder.computeWorldMatrix(true).invertToRef(inv)
      gun.computeWorldMatrix(true)
      hand.computeWorldMatrix(true)
      const g = BABYLON.Vector3.TransformCoordinates(gun.getAbsolutePosition(), inv)
      const h = BABYLON.Vector3.TransformCoordinates(hand.getAbsolutePosition(), inv)
      samples.push(BABYLON.Vector3.Distance(g, h))
    })
    setTimeout(() => {
      scene.onAfterAnimationsObservable.remove(observer)
      resolve({
        count: samples.length,
        min: Math.min(...samples),
        max: Math.max(...samples),
        mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      })
    }, durationMs)
  }), { durationMs: ms, refName })

  // ---- A) two-handed weapons: hand tracks the gun through a burst ----
  // The Shotgun is pump-action: its support hand rides the sliding fore-end, so it is
  // measured against the pump bone ('Forearm') rather than the receiver root.
  for (const [index, name] of [[0, 'rifle'], [1, 'smg'], [2, 'shotgun']]) {
    const ref = name === 'shotgun' ? 'Forearm' : null
    await switchTo(index)
    const idle = await trackAttachment(900, ref)
    await setInput({ mouseDown: true })
    const firing = await trackAttachment(1400, ref)
    await setInput({ mouseDown: false })
    await sleep(1200)
    const settled = await trackAttachment(900, ref)

    const ok = idle && firing && settled
    // the authored clips keep the hand ON the gun: the hand->gun distance range
    // seen while firing must stay close to the idle range. The stripped-clip bug
    // showed 2-4x the idle spread here (gun recoiling under a frozen arm).
    const idleSpread = ok ? idle.max - idle.min : Infinity
    const fireDrift = ok ? Math.max(Math.abs(firing.max - idle.mean), Math.abs(idle.mean - firing.min)) : Infinity
    const settleDrift = ok ? Math.abs(settled.mean - idle.mean) : Infinity
    const TOL_FIRE = 3.5   // cm — authored grip shift + recoil follow
    const TOL_SETTLE = 1.0 // cm — must come back to the idle hold
    check(name + ': left hand rides the gun while firing',
      ok && fireDrift < Math.max(TOL_FIRE, idleSpread * 1.5),
      ok ? `idle ${idle.min.toFixed(2)}-${idle.max.toFixed(2)}cm, firing ${firing.min.toFixed(2)}-${firing.max.toFixed(2)}cm (drift ${fireDrift.toFixed(2)}cm over ${firing.count} frames)` : 'no samples')
    check(name + ': hand back on the gun after the burst',
      ok && settleDrift < TOL_SETTLE,
      ok ? `settled mean ${settled.mean.toFixed(2)}cm vs idle mean ${idle.mean.toFixed(2)}cm` : 'no samples')
  }

  // ---- B) cancelled reload restores the gun root to idle, not a frozen pose ----
  // The rifle's authored idle BREATHES the weapon-root object (~0.13 model-units,
  // Y axis only; X/Z are constant). A single-snapshot "within 0.05 of rest" check
  // therefore compares two breathing phases and is physically impossible to pass.
  // Instead: measure the idle breathing envelope over a full cycle, then after the
  // cancel assert the root sits back INSIDE that envelope (tight on the still axes,
  // within measured sway on the breathing axis), is still breathing (not frozen at
  // the reload pose), and the reload flag is clear. This is strictly stronger than
  // the snapshot check — it also catches a freeze, which a snapshot near rest cannot.
  await switchTo(0)
  const gunRootEnvelope = (ms) => page.evaluate((durationMs) => new Promise((resolve) => {
    const scene = window.gameClient.simulator.renderer.scene
    const gun = scene.transformNodes.find((n) => n.name === 'Rifle_01_Armature')
    if (!gun) { resolve(null); return }
    const samples = []
    const observer = scene.onAfterAnimationsObservable.add(() => {
      gun.computeWorldMatrix(true)
      samples.push(gun.position.asArray())
    })
    setTimeout(() => {
      scene.onAfterAnimationsObservable.remove(observer)
      const axes = [0, 1, 2].map((i) => {
        const vals = samples.map((s) => s[i])
        const min = Math.min(...vals), max = Math.max(...vals)
        return { min, max, range: max - min, mean: vals.reduce((a, b) => a + b, 0) / vals.length }
      })
      resolve({ count: samples.length, axes })
    }, durationMs)
  }), ms)

  const idleEnv = await gunRootEnvelope(7000) // >= one ~6.7s breathing period
  await setInput({ reload: true }); await sleep(120); await setInput({ reload: false })
  await sleep(400)
  const midReload = await gunRootEnvelope(150) // reload mid-swing
  // cancel by firing with rounds left; the same click may or may not re-fire —
  // the invariant is the gun root returns to the idle breathing envelope.
  await setInput({ mouseDown: true }); await sleep(80); await setInput({ mouseDown: false })
  await sleep(1500) // settle: idle blends fully back in
  const afterCancel = await gunRootEnvelope(2500)
  const reloadingFlag = await page.evaluate(() => window.gameClient.simulator.viewmodel._reloading)

  const ok = idleEnv && midReload && afterCancel
  const M = 0.02 // model-units slack on the still axes
  // (i) the reload actually displaced the root well outside the idle envelope
  const midDisplaced = ok && [0, 1, 2].some((i) =>
    midReload.axes[i].mean < idleEnv.axes[i].min - 0.3 ||
    midReload.axes[i].mean > idleEnv.axes[i].max + 0.3)
  // (ii) after cancel every sample sits back inside the idle breathing envelope
  const backInEnvelope = ok && [0, 1, 2].every((i) =>
    afterCancel.axes[i].min >= idleEnv.axes[i].min - M &&
    afterCancel.axes[i].max <= idleEnv.axes[i].max + M)
  // (iii) the root is breathing again — a freeze at the reload rest frame would
  //       land inside the envelope yet have ~zero range
  const idleSway = ok ? Math.max(...idleEnv.axes.map((a) => a.range)) : 0
  const cancelSway = ok ? Math.max(...afterCancel.axes.map((a) => a.range)) : 0
  const notFrozen = cancelSway > idleSway * 0.4
  check('rifle: cancelled reload restores idle (back in envelope, breathing, flag clear)',
    ok && midDisplaced && backInEnvelope && notFrozen && !reloadingFlag,
    `midDisplaced=${midDisplaced} backInEnvelope=${backInEnvelope} ` +
    `idleSway=${idleSway.toFixed(3)} cancelSway=${cancelSway.toFixed(3)} reloading=${reloadingFlag}`)

  // ---- C) rapid shoot+swap leaves one attached rig, no duplicates ----
  await setInput({ mouseDown: true })
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const simulator = window.gameClient.simulator
      simulator.switchWeapon(simulator.weaponIndex + 1)
    })
    await sleep(120) // swap mid-burst
  }
  await setInput({ mouseDown: false })
  await page.waitForFunction(
    'window.gameClient.simulator.viewmodel && ' +
    'window.gameClient.simulator.viewmodel.ready && ' +
    'window.gameClient.simulator.viewmodel.spec.index === ' +
    'window.gameClient.simulator.weaponIndex',
    { timeout: 20000 }
  )
  await sleep(500)
  const rigs = await page.evaluate(() => {
    const scene = window.gameClient.simulator.renderer.scene
    const live = (n) => !n.isDisposed || !n.isDisposed()
    return {
      holders: scene.transformNodes.filter((n) => n.name === 'viewmodel' && live(n)).length,
      muzzles: scene.transformNodes.filter((n) => n.name === 'muzzle' && live(n)).length,
      weapon: window.gameClient.simulator.weaponIndex,
      visual: window.gameClient.simulator.viewmodel.spec.index,
    }
  })
  check('shoot+swap burst leaves exactly one rig',
    rigs.holders === 1 && rigs.muzzles === 1 && rigs.weapon === rigs.visual,
    JSON.stringify(rigs))

  // fire once more on the final weapon: the fresh rig must still animate
  const postSwapIdle = await trackAttachment(600)
  await setInput({ mouseDown: true }); await sleep(500); await setInput({ mouseDown: false })
  const postSwapFire = await trackAttachment(600)
  check('post-swap weapon still fires with hand attached',
    postSwapIdle && postSwapFire &&
    Math.abs(postSwapFire.mean - postSwapIdle.mean) < 4.0,
    postSwapIdle && postSwapFire
      ? `idle mean ${postSwapIdle.mean.toFixed(2)}cm, fire mean ${postSwapFire.mean.toFixed(2)}cm`
      : 'no samples')

  // The Projectile factory registration bug (factory.create/.delete is not a
  // function) is fixed at root in createFactories.js, so this is now unconditional.
  check('no uncaught client errors', errors.length === 0, errors.join(' | '))
} catch (error) {
  check('verification harness ran to completion', false, error.message)
} finally {
  await browser.close()
}

console.log('\n=== fire attachment verification ===')
let failed = 0
for (const result of checks) {
  console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.name +
    (result.detail ? '  (' + result.detail + ')' : ''))
  if (!result.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
