// Armor placement solver + prover.
//
// The Blender-authored transforms did not survive the glTF bone-frame conversion, so
// instead of nudging them we re-derive each mount from ANATOMY. Two measured facts do
// all the work:
//   * every piece is a dome whose apex runs along its own local +Y, base at y=0
//     (chest also carries a collar bar + gem on its +Z side; pauldron a fin at -Z;
//     elbow/knee a lip at +Z),
//   * each bone's local axes, measured in character space (scratch/probe-axes.mjs):
//       spine_03   +X left      +Y up         +Z anterior
//       clavicle_l +X anterior  +Y outboard   +Z up
//       lowerarm_l +X down      +Y to wrist   +Z anterior
//       calf_l     +X left      +Y to ankle   +Z posterior
// So a mount rotation is just "point the dome at the body part": we write the desired
// bone-local directions of the piece's own X/Y/Z as the ROWS of a rotation matrix and
// read the Euler angles back out of it (Babylon's rotation vector is exactly the Euler
// of that matrix). No hand-guessed radians anywhere.
//
//   node scripts/fit-armor.mjs                       # default plan below
//   PLAN='{"kneeL":{"pos":[0,0.05,-0.03]}}' node scripts/fit-armor.mjs
//   PLAN=... SHOTS=... CLIP=Jog_Fwd_Loop FRAME=0.4 node scripts/fit-armor.mjs
// Prints the resulting manifest rows; screenshots to /tmp/armor-<tag>.png.
import puppeteer from 'puppeteer-core'

// pos = bone-local metres (rig scale, i.e. the manifest's units). tilt only applies to
// the pauldron (how far the dome leans off the clavicle toward "up").
const DEFAULT_PLAN = {
  // Measured anatomy, bone-local bind space (scratch/probe-bonelocal.mjs):
  //   spine_03   chest front surface z=+0.126, torso half-width 0.14-0.20, neck at y=0.215
  //   clavicle_l shoulder joint at y=0.197, deltoid reaches y~0.275, shoulder top z=+0.04
  //   lowerarm_l elbow at y=0 (wrist y=0.244), section x[-0.056,0.082] z[-0.063,0.040]
  //   calf_l     knee at y=0 (ankle y=0.459), section x[-0.043,0.060] z[-0.062,0.086]
  // SHIPPED FIT (2026-07-24) — these are the numbers written into assetManifest.js.
  chest: { scale: 0.78, pos: [0, 0.045, 0.072] },
  pauldronL: { scale: 0.88, pos: [0, 0.19, 0.0], tilt: 0.55 },
  elbowL: { scale: 0.95, pos: [0.013, 0.01, -0.012] },
  kneeL: { scale: 0.80, pos: [0.009, 0.012, -0.012] },
}
const PLAN = Object.assign({}, DEFAULT_PLAN)
if (process.env.PLAN) {
  const o = JSON.parse(process.env.PLAN)
  for (const k of Object.keys(o)) PLAN[k] = Object.assign({}, PLAN[k], o[k])
}
const CLIP = process.env.CLIP || null
const FRAME = process.env.FRAME ? parseFloat(process.env.FRAME) : null
const SHOTS = process.env.SHOTS ? JSON.parse(process.env.SHOTS) : [
  { tag: 'front', a: Math.PI * 0.5, b: Math.PI / 2.15, r: 2.6 },
  { tag: 'side', a: Math.PI, b: Math.PI / 2.15, r: 2.6 },
  { tag: 'arm', bone: 'lowerarm_l', a: Math.PI * 0.75, b: Math.PI / 2.1, r: 0.7 },
  { tag: 'knee', bone: 'calf_l', a: Math.PI * 0.6, b: Math.PI / 2.1, r: 0.7 },
]

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 720, height: 900 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))
await p.goto('http://localhost:8080/?playground', { waitUntil: 'domcontentloaded' })
await p.waitForFunction('window.playground && window.playground._armorRoots && window.playground._armorRoots.size >= 7',
  { timeout: 60000 }).catch(() => {})

const info = await p.evaluate(({ plan, clip, frame }) => {
  const pg = window.playground
  ;['splash', 'entry-overlay', 'pg-panel', 'pg-hint'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove() })
  const name = clip && pg.byName.has(clip) ? clip
    : (pg.mapping.idle && pg.byName.has(pg.mapping.idle) ? pg.mapping.idle : pg.groups[0].name)
  pg.play(name)
  if (frame != null) { const g = pg.byName.get(name); g.pause(); g.goToFrame(g.from + (g.to - g.from) * frame) }

  // rows -> Babylon Euler. Row i is where the piece's local axis i must point in
  // bone-local space, which IS the rotation matrix in Babylon's row-vector convention.
  const checks = []
  const euler = (rows) => {
    const m = BABYLON.Matrix.FromValues(
      rows[0][0], rows[0][1], rows[0][2], 0,
      rows[1][0], rows[1][1], rows[1][2], 0,
      rows[2][0], rows[2][1], rows[2][2], 0,
      0, 0, 0, 1)
    const e = BABYLON.Quaternion.FromRotationMatrix(m).toEulerAngles()
    // self-check: rebuild the matrix the way TransformNode.rotation does and read
    // back where the piece's local axes actually land in bone-local space
    const back = BABYLON.Matrix.RotationYawPitchRoll(e.y, e.x, e.z)
    const row = (i) => [back.m[i * 4], back.m[i * 4 + 1], back.m[i * 4 + 2]].map((v) => +v.toFixed(3))
    checks.push({ want: rows, got: [row(0), row(1), row(2)] })
    return [e.x, e.y, e.z]
  }
  const c = Math.cos(plan.pauldronL.tilt), s = Math.sin(plan.pauldronL.tilt)
  const ROT = {
    // dome -> anterior (+Z), collar/gem side (+Z) -> up (+Y); X flips to keep it a rotation
    chest: euler([[-1, 0, 0], [0, 0, 1], [0, 1, 0]]),
    // dome -> outboard (+Y) leaned `tilt` toward up (+Z); fin (piece -Z) flares posteriorly
    pauldronL: euler([[0, s, -c], [0, c, s], [1, 0, 0]]),
    // dome -> posterior (-Z, the olecranon); lip (piece +Z) runs down the forearm (+Y)
    elbowL: euler([[1, 0, 0], [0, 0, -1], [0, 1, 0]]),
    // dome -> anterior (-Z, the patella); lip (piece +Z) runs down the shin (+Y)
    kneeL: euler([[1, 0, 0], [0, 0, -1], [0, 1, 0]]),
  }
  const applied = {}
  for (const k of Object.keys(ROT)) {
    const q = plan[k], r = ROT[k]
    const t = { scale: q.scale, px: q.pos[0], py: q.pos[1], pz: q.pos[2], rx: r[0], ry: r[1], rz: r[2] }
    pg.tuneArmor(k, t)
    applied[k] = t
  }
  return { clip: name, applied, checks, rows: pg.dumpArmor() }
}, { plan: PLAN, clip: CLIP, frame: FRAME })

await new Promise((r) => setTimeout(r, 900))
for (const s of SHOTS) {
  await p.evaluate((s) => {
    const pg = window.playground
    const cam = pg.scene.activeCamera
    let t = new BABYLON.Vector3(0, 1.0, 0)
    if (s.bone) { const n = pg._boneNode(s.bone); if (n) t = n.getAbsolutePosition().clone() }
    cam.setTarget(t); cam.alpha = s.a; cam.beta = s.b; cam.radius = s.r
  }, s)
  await new Promise((r) => setTimeout(r, 300))
  await p.screenshot({ path: `/tmp/armor-${s.tag}.png` })
}
console.log(info.rows)
console.log(JSON.stringify({ clip: info.clip, plan: PLAN, checks: info.checks, errors }))
await browser.close()
