// Armor fit tuner / prover. Boots the playground, applies transform overrides via
// window.playground.tuneArmor, then screenshots from a list of camera framings so
// the elbow/knee/pauldron/chest fit can actually be looked at.
//
//   node scripts/tune-armor.mjs                                   # current manifest fit
//   ARMOR_XF='{"elbowL":{"py":0.06,"scale":0.9}}' node scripts/tune-armor.mjs
//   CLIP=Jog_Fwd_Loop FRAME=0.4 SHOTS='[{"tag":"side","bone":"spine_03","a":3.14,"b":1.45,"r":2.6}]' \
//     node scripts/tune-armor.mjs
//
// SHOTS entries: tag (file name), bone (frame the camera on that bone's node; omit
// for the body centre), a/b/r = ArcRotate alpha/beta/radius. Output: /tmp/armor-<tag>.png
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://localhost:8080/?playground'
const XF = process.env.ARMOR_XF ? JSON.parse(process.env.ARMOR_XF) : null
const CLIP = process.env.CLIP || null
const FRAME = process.env.FRAME ? parseFloat(process.env.FRAME) : null // 0..1 through the clip
const DUMP = process.env.DUMP === '1'
const SHOTS = process.env.SHOTS ? JSON.parse(process.env.SHOTS) : [
  { tag: 'front', a: Math.PI * 1.5, b: Math.PI / 2.15, r: 3.0 },
  { tag: 'side', a: Math.PI, b: Math.PI / 2.15, r: 3.0 },
  { tag: 'arm', bone: 'lowerarm_l', a: Math.PI * 1.35, b: Math.PI / 2.1, r: 0.75 },
  { tag: 'knee', bone: 'calf_l', a: Math.PI * 1.35, b: Math.PI / 2.1, r: 0.75 },
]

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--mute-audio', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 720, height: 900 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(
  'window.playground && window.playground.groups && window.playground.groups.length > 0',
  { timeout: 60000 },
).catch(() => {})
// armor mounts async after the rig; wait for the last piece
await p.waitForFunction('window.playground._armorRoots && window.playground._armorRoots.size >= 7',
  { timeout: 60000 }).catch(() => {})

const info = await p.evaluate(({ xf, clip, frame, dump }) => {
  const pg = window.playground
  // the splash card sequence and the side panel both cover the canvas
  ;['splash', 'entry-overlay', 'pg-panel', 'pg-hint'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.remove()
  })
  const name = clip && pg.byName.has(clip) ? clip
    : (pg.mapping.idle && pg.byName.has(pg.mapping.idle) ? pg.mapping.idle : pg.groups[0].name)
  pg.play(name)
  if (frame != null) {
    const g = pg.byName.get(name)
    g.pause()
    g.goToFrame(g.from + (g.to - g.from) * frame)
  }
  if (xf) for (const k of Object.keys(xf)) pg.tuneArmor(k, xf[k])
  return {
    clip: name,
    mounted: [...pg._armorRoots.keys()],
    twins: [...pg._armorTwin.entries()],
    rows: dump ? pg.dumpArmor() : undefined,
  }
}, { xf: XF, clip: CLIP, frame: FRAME, dump: DUMP })

await new Promise((r) => setTimeout(r, 900))

for (const s of SHOTS) {
  await p.evaluate((s) => {
    const pg = window.playground
    const cam = pg.scene.activeCamera
    let t = new BABYLON.Vector3(0, 1.0, 0)
    if (s.bone) {
      const node = pg._boneNode(s.bone)
      if (node) t = node.getAbsolutePosition().clone()
    }
    cam.setTarget(t)
    cam.alpha = s.a; cam.beta = s.b; cam.radius = s.r
  }, s)
  await new Promise((r) => setTimeout(r, 300))
  await p.screenshot({ path: `/tmp/armor-${s.tag}.png` })
}

console.log(JSON.stringify({ ...info, xf: XF, errors }, null, 0))
await browser.close()
