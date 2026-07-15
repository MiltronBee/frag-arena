// Introspect why remote-player (enemy) animations aren't playing. Opens two
// clients; client A inspects the CharacterModel it built for client B.
//   node scripts/probe-anim.mjs
import puppeteer from 'puppeteer-core'

const URL = process.env.FRAG_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ],
})

const open = async () => {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('  pageerror:', e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
    { timeout: 30000 })
  return page
}

const a = await open()
const b = await open()
await sleep(6000) // let models load + animations settle

const inspect = (page, tag) => page.evaluate((tag) => {
  const sim = window.gameClient.simulator
  const models = sim.characterModels
  const out = { tag, entities: window.gameClient.client.entities.size, count: models.size, models: [] }
  for (const [nid, m] of models) {
    const groupNames = Object.keys(m.groups || {})
    const playing = []
    const scene = sim.renderer.scene
    for (const g of scene.animationGroups || []) {
      if (g.isPlaying) playing.push(g.name)
    }
    out.models.push({
      nid,
      ready: m.ready,
      groupCount: groupNames.length,
      idleName: m.spec?.anims?.idle,
      idleFound: !!m.idle,
      idleGroupName: m.idle?.name,
      idleIsPlaying: m.idle?.isPlaying,
      currentName: m.current?.name,
      currentIsPlaying: m.current?.isPlaying,
      sampleGroupNames: groupNames.slice(0, 6),
      hasIdleKey: groupNames.includes(m.spec?.anims?.idle),
      idleTargetedAnims: m.idle ? m.idle.targetedAnimations?.length : null,
      scenePlayingCount: playing.length,
      scenePlayingSample: playing.slice(0, 4),
      skeletonBones: m.skeleton?.bones?.length,
      // --- linkage diagnostics ---
      idleTargetSample: (m.idle?.targetedAnimations || []).slice(0, 3).map((ta) => ({
        targetCtor: ta.target?.getClassName ? ta.target.getClassName() : typeof ta.target,
        targetName: ta.target?.name,
        prop: ta.animation?.targetProperty,
      })),
      boneSample: (m.skeleton?.bones || []).slice(0, 3).map((bne) => ({
        bone: bne.name,
        hasLinkedNode: !!bne._linkedTransformNode,
        linkedName: bne._linkedTransformNode?.name,
      })),
      meshHasSkeleton: (m.meshes || []).map((me) => !!me.skeleton).filter(Boolean).length,
      skeletonPrepareOnRender: m.skeleton?._numBonesWithLinkedTransformNode,
    })
    break // first enemy is enough
  }
  return out
}, tag)

const ra = await inspect(a, 'A(first)')
const rb = await inspect(b, 'B(second)')
console.log(JSON.stringify({ A: ra, B: rb }, null, 2))

// visual: whichever client has a model, aim its camera at the enemy + screenshot
const shooter = rb.count > 0 ? b : (ra.count > 0 ? a : null)
if (shooter) {
  await shooter.evaluate(() => {
    const ov = document.getElementById('entry-overlay'); if (ov) ov.classList.remove('is-visible')
    document.body.classList.add('arena-entered')
    const sim = window.gameClient.simulator
    const cam = sim.renderer.camera
    if (sim.viewmodel) { sim.viewmodel.dispose?.() }
    let t = null
    for (const [, m] of sim.characterModels) { t = m.holder; break }
    if (t) {
      const BABYLON = window.BABYLON
      const pos = t.position
      cam.position = new BABYLON.Vector3(pos.x + 1.6, pos.y + 1.0, pos.z + 1.6)
      cam.setTarget(new BABYLON.Vector3(pos.x, pos.y + 0.5, pos.z))
    }
  })
  await sleep(1500)
  await shooter.screenshot({ path: '/tmp/hero-idle-check.png' })
  console.log('screenshot: /tmp/hero-idle-check.png')
}
await browser.close()
