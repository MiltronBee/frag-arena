// Deterministic, offline per-weapon animation invariants (Babylon NullEngine).
//
// Complements the browser tests: it evaluates the SHIPPED weapon GLBs the exact
// way the runtime does (same loader, same skeletal eval) but headless and
// deterministic — no timing, no render loop — so every one of the five weapon
// definitions (Rifle, SMG, Shotgun, Pistol, and Plasma which reuses the Rifle
// GLB) is checked every run. It asserts, per weapon:
//   * the runtime clips exist (idle, fire, reload),
//   * the support hand rides the gun through the whole fire clip (the shotgun
//     pump-rack regression showed up here as a ~26cm swing),
//   * the hold is stable at idle,
//   * fire/reload REWIND to the same base pose idle rests at — this is exactly
//     what Viewmodel._rewindStop() relies on when a reload is cancelled or the
//     weapon is hidden mid-clip, so a drift here is a real freeze bug.
//
// Requires the dev stack (npm start) so GLBs load from the same URL the client
// uses. Distances are in model units (cm for these GLBs).
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
global.XMLHttpRequest = require('xhr2')
import * as BABYLON from '../common/babylon.node.js'
import '@babylonjs/loaders/glTF/index.js' // register glTF/GLB loader (GLB weapon models)

const BASE = (process.env.FRAG_URL || 'http://localhost:8080/').replace(/\/$/, '') + '/assets/weapons/'

const WEAPONS = [
  { name: 'Rifle',   file: 'retro_rifle_arms.glb',   gun: 'Rifle_01_Armature' },
  { name: 'SMG',     file: 'retro_smg_arms.glb',     gun: 'SMG_01_Armature' },
  { name: 'Shotgun', file: 'retro_shotgun_arms.glb', gun: 'Shotgun_01_Armature' },
  { name: 'Pistol',  file: 'retro_pistol_arms.glb',  gun: 'Pistol_01_Armature' },
]

const TOL_FIRE = 3.5  // cm — support hand must ride the gun through recoil
const TOL_IDLE = 2.0  // cm — stable two-hand/one-hand hold
const TOL_BASE = 0.05 // model-units — fire/reload rewind must match the idle rest

const checks = []
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }

const loadWeapon = async (file) => {
  const engine = new BABYLON.NullEngine()
  const scene = new BABYLON.Scene(engine)
  new BABYLON.FreeCamera('c', new BABYLON.Vector3(0, 0, -5), scene)
  const res = await BABYLON.SceneLoader.ImportMeshAsync('', BASE, file, scene)
  const groups = {}
  res.animationGroups.forEach((g) => { g.stop(); groups[g.name] = g })
  const node = (n) => scene.transformNodes.find((t) => t.name === n) || scene.getNodeByName(n)
  return { engine, scene, groups, node }
}

// hand<->gun distances sampled evenly across a clip (replays it like the runtime)
const spread = (g, hand, gun, n = 13) => {
  const d = []
  g.reset(); g.start(false, 1.0)
  for (let i = 0; i < n; i++) {
    g.goToFrame(g.from + (g.to - g.from) * i / (n - 1))
    hand.computeWorldMatrix(true); gun.computeWorldMatrix(true)
    d.push(BABYLON.Vector3.Distance(hand.getAbsolutePosition(), gun.getAbsolutePosition()))
  }
  g.stop()
  return { min: Math.min(...d), max: Math.max(...d), range: Math.max(...d) - Math.min(...d),
    finite: d.every((v) => Number.isFinite(v)) }
}

// gun-root object-space position at a clip's rest (from) frame
const restPos = (g, gun) => {
  g.reset(); g.start(false, 1.0); g.goToFrame(g.from)
  gun.computeWorldMatrix(true)
  const p = gun.position.asArray()
  g.stop()
  return p
}
const maxAbsDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

for (const w of WEAPONS) {
  let ctx
  try {
    ctx = await loadWeapon(w.file)
  } catch (e) {
    check(`${w.name}: GLB loads`, false, e.message)
    continue
  }
  const { engine, groups, node } = ctx
  const handL = node('hand_l'); const gun = node(w.gun)

  const haveClips = !!groups.idle && !!groups.fire && !!groups.reload
  check(`${w.name}: has idle+fire+reload clips`, haveClips,
    'groups: ' + Object.keys(groups).join(','))
  if (!haveClips || !handL || !gun) {
    if (!handL || !gun) check(`${w.name}: has hand_l + ${w.gun} nodes`, false, `hand_l=${!!handL} gun=${!!gun}`)
    engine.dispose(); continue
  }

  const idle = spread(groups.idle, handL, gun)
  const fire = spread(groups.fire, handL, gun)
  check(`${w.name}: support hand rides the gun through fire`, fire.finite && fire.range < TOL_FIRE,
    `fire spread ${fire.range.toFixed(2)}cm (${fire.min.toFixed(1)}-${fire.max.toFixed(1)})`)
  check(`${w.name}: stable hold at idle`, idle.finite && idle.range < TOL_IDLE,
    `idle spread ${idle.range.toFixed(2)}cm`)

  // fire and reload must rewind to the exact pose idle rests at — the base pose
  // Viewmodel._rewindStop() snaps back to on cancel/hide.
  const base = restPos(groups.idle, gun)
  const fireBase = restPos(groups.fire, gun)
  const reloadBase = restPos(groups.reload, gun)
  const fireDev = maxAbsDiff(base, fireBase)
  const reloadDev = maxAbsDiff(base, reloadBase)
  check(`${w.name}: fire rewinds to the idle base pose`, fireDev < TOL_BASE,
    `deviation ${fireDev.toFixed(4)} model-units`)
  check(`${w.name}: reload rewinds to the idle base pose`, reloadDev < TOL_BASE,
    `deviation ${reloadDev.toFixed(4)} model-units`)

  ctx.engine.dispose()
}

console.log('\n=== per-weapon offline animation verification ===')
let failed = 0
for (const r of checks) {
  console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  (' + r.detail + ')' : ''))
  if (!r.pass) failed++
}
console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed')
process.exit(failed ? 1 : 0)
