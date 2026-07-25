// Screenshot the armour set on the real character in the real renderer (the playground
// mounts straight from assetManifest, so what you see here is what ships). Companion to
// scripts/fit-armor.mjs, but read-only: it applies NO transform overrides, it just looks.
//
//   node scripts/shoot-armor.mjs                       # bind-ish idle, default views
//   CLIP=Jog_Fwd_Loop FRAME=0.35 TAG=jog node scripts/shoot-armor.mjs
//   TUNE='{"bootL":{"py":0.01}}' node scripts/shoot-armor.mjs   # try a mount nudge live
// Writes /tmp/shot-<TAG><view>.png and prints the manifest rows actually in effect.
import puppeteer from 'puppeteer-core'

const CLIP = process.env.CLIP || null
const FRAME = process.env.FRAME ? parseFloat(process.env.FRAME) : null
const TAG = process.env.TAG || ''
const TUNE = process.env.TUNE ? JSON.parse(process.env.TUNE) : null
// `dir` is degrees around the model measured from ITS OWN anterior (0 = looking the
// character in the face, 45 = 3/4, 90 = side, 180 = from behind). Resolving it against the
// model's real forward vector at shoot time removes the guesswork that made the first
// pass unreadable — a raw camera alpha tells you nothing about which way the body faces.
const VIEWS = process.env.VIEWS ? JSON.parse(process.env.VIEWS) : [
  { tag: 'front', dir: 0, b: 88, r: 2.4, bone: 'spine_02' },
  { tag: 'q34', dir: 40, b: 84, r: 2.4, bone: 'spine_02' },
  { tag: 'side', dir: 90, b: 88, r: 2.4, bone: 'spine_02' },
  { tag: 'chest', dir: 0, b: 88, r: 0.95, bone: 'spine_03' },
  { tag: 'chest34', dir: 42, b: 82, r: 0.95, bone: 'spine_03' },
  { tag: 'chestside', dir: 90, b: 88, r: 0.95, bone: 'spine_03' },
  { tag: 'bootfront', dir: 0, b: 78, r: 0.5, bone: 'foot_l' },
  { tag: 'boot34', dir: 42, b: 72, r: 0.5, bone: 'foot_l' },
  { tag: 'bootside', dir: 90, b: 84, r: 0.5, bone: 'foot_l' },
  { tag: 'bootback', dir: 155, b: 76, r: 0.5, bone: 'foot_l' },
]

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const p = await browser.newPage()
await p.setViewport({ width: 760, height: 900 })
const errors = []
p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 160)) })
await p.goto('http://localhost:8080/?playground', { waitUntil: 'domcontentloaded' })
await p.waitForFunction('window.playground && window.playground._armorRoots && window.playground._armorRoots.size >= 9',
  { timeout: 90000 }).catch(() => {})

const info = await p.evaluate(({ clip, frame, tune }) => {
  const pg = window.playground
  ;['splash', 'entry-overlay', 'pg-panel', 'pg-hint'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove() })
  const name = clip && pg.byName.has(clip) ? clip
    : (pg.mapping.idle && pg.byName.has(pg.mapping.idle) ? pg.mapping.idle : pg.groups[0].name)
  pg.play(name)
  if (frame != null) { const g = pg.byName.get(name); g.pause(); g.goToFrame(g.from + (g.to - g.from) * frame) }
  if (tune) for (const k of Object.keys(tune)) pg.tuneArmor(k, tune[k])
  return { clip: name, mounted: [...pg._armorRoots.keys()], rows: pg.dumpArmor() }
}, { clip: CLIP, frame: FRAME, tune: TUNE })

await new Promise((r) => setTimeout(r, 1200))
for (const s of VIEWS) {
  await p.evaluate((s) => {
    const pg = window.playground
    const cam = pg.scene.activeCamera
    let t = new BABYLON.Vector3(0, s.y != null ? s.y : 1.0, 0)
    if (s.bone) { const n = pg._boneNode(s.bone); if (n) t = n.getAbsolutePosition().clone() }
    let a = s.a
    if (a == null) {
      const f = BABYLON.Vector3.TransformNormal(new BABYLON.Vector3(0, 0, 1),
        pg.meshes[0].getWorldMatrix()).normalize()
      a = Math.atan2(f.z, f.x) + (s.dir || 0) * Math.PI / 180
    }
    cam.setTarget(t)
    cam.alpha = a
    cam.beta = s.b > 3.2 ? s.b * Math.PI / 180 : s.b
    cam.radius = s.r
  }, s)
  await new Promise((r) => setTimeout(r, 260))
  await p.screenshot({ path: `/tmp/shot-${TAG}${s.tag}.png` })
}
console.log(info.rows)
console.log(JSON.stringify({ clip: info.clip, mounted: info.mounted, errors: errors.slice(0, 6) }))
await browser.close()
