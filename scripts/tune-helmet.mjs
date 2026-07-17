// Close-up helmet fit tuner. Boots the playground, frames the head bone, applies
// an optional transform override (env HELMET_XF = JSON subset of
// {scale,px,py,pz,rx,ry,rz}) via window.playground.setHelmetTransform, then
// screenshots the head from front / side / back so the fit + facing can be judged.
//   node scripts/tune-helmet.mjs                       # current spec transform
//   HELMET_XF='{"scale":0.8,"py":0.05,"ry":3.14}' node scripts/tune-helmet.mjs
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://localhost:8081/?playground'
const XF = process.env.HELMET_XF ? JSON.parse(process.env.HELMET_XF) : null

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 640, height: 640 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(
  'window.playground && window.playground.groups && window.playground.groups.length > 0',
  { timeout: 45000 },
).catch(() => {})

// play idle, apply transform override, hide the UI so it doesn't cover the model
const info = await p.evaluate((xf) => {
  const pg = window.playground
  const idle = pg.mapping.idle && pg.byName.has(pg.mapping.idle) ? pg.mapping.idle : pg.groups[0].name
  pg.play(idle)
  if (xf) pg.setHelmetTransform(xf)
  const panel = document.querySelector('#pg-panel, .pg-panel, aside, .panel')
  if (panel) panel.style.display = 'none'
  // find the Head bone transform node world position
  const bone = pg.skeleton && pg.skeleton.bones.find((b) => b.name === (window.assets?.playerBody?.headBone || 'Head'))
  const node = bone && ((bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode)
  const wp = node && node.getAbsolutePosition()
  return { idle, head: wp ? { x: wp.x, y: wp.y, z: wp.z } : null, helmet: !!pg._helmetRoot }
}, XF)

await new Promise((r) => setTimeout(r, 800))

// drive the ArcRotate camera to frame the head, orbit for 3 views
async function shot(alpha, beta, tag) {
  await p.evaluate(({ alpha, beta, head }) => {
    const sc = window.playground.scene
    const cam = sc.activeCamera
    if (head && cam.setTarget) cam.setTarget(new BABYLON.Vector3(head.x, head.y, head.z))
    if ('alpha' in cam) { cam.alpha = alpha; cam.beta = beta; cam.radius = 0.85 }
  }, { alpha, beta, head: info.head })
  await new Promise((r) => setTimeout(r, 250))
  await p.screenshot({ path: `/tmp/helmet-${tag}.png` })
}
// front (a=270) + 3/4 (a=225) close-ups for final fit judgement
await shot(Math.PI * 1.5, Math.PI / 2.15, 'front')
await shot(Math.PI * 1.25, Math.PI / 2.15, 'q34')

console.log(JSON.stringify({ ...info, xf: XF, errors }, null, 0))
await browser.close()
if (errors.length) process.exit(1)
