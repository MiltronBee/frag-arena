// Read-only diagnostic: connect to the live game, enter, and report the TRUE
// animated foot-bone world height of remote character models (skinned-mesh
// bounding boxes reflect bind pose, so we read the actual foot bones), plus a
// screenshot. Tells us if idle bodies really float and if movers slide.
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'https://sol-pkmn.fun/'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 1100, height: 760 })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160)))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity', { timeout: 30000 })
await p.evaluate(() => { const ov = document.getElementById('entry-overlay'); if (ov) ov.classList.remove('is-visible'); document.body.classList.add('arena-entered') })
await new Promise((r) => setTimeout(r, 6000))

const report = await p.evaluate(() => {
  const sim = window.gameClient.simulator
  const out = { bones: null, models: [], ground: null }
  // find the arena floor mesh y (name hints: ground/floor/plane)
  const scene = sim.renderer.scene
  const floor = scene.meshes.find((m) => /ground|floor|plane/i.test(m.name || ''))
  if (floor) { floor.computeWorldMatrix(true); out.ground = { name: floor.name, y: +floor.getBoundingInfo().boundingBox.centerWorld.y.toFixed(3) } }

  const footY = (model) => {
    const sk = model.skeleton
    if (!sk) return null
    const feet = sk.bones.filter((b) => /foot|toe|ball/i.test(b.name))
    if (!out.bones) out.bones = feet.map((b) => b.name)
    let lo = Infinity
    feet.forEach((b) => {
      const n = (b.getTransformNode && b.getTransformNode()) || b._linkedTransformNode
      if (n) { n.computeWorldMatrix(true); if (n.getAbsolutePosition().y < lo) lo = n.getAbsolutePosition().y }
    })
    return lo === Infinity ? null : +lo.toFixed(3)
  }
  // verify the upper-body shoot mask on the first model: shootUpper must exclude
  // all leg/pelvis bones (else the legs freeze and the body slides while shooting)
  const LOWER = ['root', 'pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'ball_leaf_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'ball_leaf_r']
  const first = sim.characterModels.values().next().value
  if (first && first.shootClip) {
    const names = (g) => g ? g.targetedAnimations.map((t) => t.target && t.target.name) : []
    const upper = names(first.shootUpper)
    out.mask = {
      shootClipTargets: names(first.shootClip).length,
      shootUpperTargets: upper.length,
      legBonesLeakedIntoShootUpper: upper.filter((n) => LOWER.includes(n)),
    }
  }
  sim.characterModels.forEach((model, nid) => {
    if (!model.holder || !model.skeleton) return
    out.models.push({
      nid,
      boxBottom: +(model.host.position.y - 0.5).toFixed(3),
      holderY: +model.holder.position.y.toFixed(3),
      footBoneY: footY(model),
      clip: model.current && model.current.name,
    })
  })
  return out
})

console.log('foot bones:', report.bones)
console.log('ground mesh:', report.ground)
console.log('shoot mask:', JSON.stringify(report.mask))
report.models.forEach((m) => {
  const gap = m.footBoneY == null ? null : +(m.footBoneY - m.boxBottom).toFixed(3)
  console.log(`nid ${m.nid} [${m.clip}] boxBottom=${m.boxBottom} footBoneY=${m.footBoneY} => ` +
    (gap == null ? 'n/a' : (gap > 0.02 ? `FLOAT +${gap}` : gap < -0.02 ? `sunk ${gap}` : `grounded (${gap})`)))
})
await p.screenshot({ path: '/tmp/live-bots.png' })
console.log('screenshot: /tmp/live-bots.png')
await browser.close()
