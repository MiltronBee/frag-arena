// Playground visual probe: helmet closeup + held guns + locomotion mid-stride.
// Assumes vite is ALREADY listening on 8080 (dev server serves client source, so
// edits are live on reload). Kills the #splash card sequence, which sits over the
// canvas and is what the older probe accidentally screenshotted.
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const OUT = '/tmp/pg'

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 1000 })
  await page.setCacheEnabled(false) // texture files are regenerated in place; never serve a stale one
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8080/?playground&armor=0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.playground && window.playground._helmetRoot', { timeout: 60000 })
  const nuke = () => page.evaluate(() => {
    for (const id of ['splash', 'entry-overlay', 'pg-panel', 'pg-hint', 'pg-toast']) {
      const el = document.getElementById(id); if (el) el.remove()
    }
  })
  await nuke(); await sleep(2500); await nuke()
  // hold a fixed pose so framing is repeatable
  await page.evaluate(() => { const p = window.playground; if (p.current) p.current.pause() })

  const frame = (o) => page.evaluate((o) => {
    const pg = window.playground
    const cam = pg.camera || pg.scene.activeCamera
    let t = new BABYLON.Vector3(0, o.y != null ? o.y : 1.0, 0)
    if (o.at === 'head' && pg._helmetRoot) t = pg._helmetRoot.getAbsolutePosition().clone()
    if (o.at === 'gun' && pg._weaponRoot) t = pg._weaponRoot.getAbsolutePosition().clone()
    cam.setTarget(t); cam.radius = o.r; cam.alpha = o.a; cam.beta = o.b
  }, o)

  const shot = async (name, o) => { await frame(o); await sleep(700); await page.screenshot({ path: `${OUT}_${name}.png` }) }

  // ---- 1. HELMET: front 3/4 and back 3/4 closeups
  await shot('helmet_front', { at: 'head', r: 0.85, a: Math.PI / 2 + 0.5, b: 1.45 })
  await shot('helmet_side', { at: 'head', r: 0.85, a: 0.0, b: 1.4 })

  // ---- 2. GUNS
  const gunInfo = {}
  for (const [idx, name] of [[0, 'rifle'], [2, 'shotgun'], [3, 'pistol']]) {
    await page.evaluate((i) => window.playground.selectWeapon(Number(i)), idx)
    await page.waitForFunction('window.playground._weaponRoot', { timeout: 20000 })
    await sleep(1600)
    gunInfo[name] = await page.evaluate(() => {
      const r = window.playground._weaponRoot
      return [r, ...r.getChildMeshes()].filter(m => m.material).map(m => {
        const t = m.material
        return {
          mesh: m.name, mat: t.name, metallic: t.metallic, rough: t.roughness,
          albedo: t.albedoTexture ? t.albedoTexture.name + (t.albedoTexture.isReady() ? ' ready' : ' NOTREADY') : null,
          emisTex: !!t.emissiveTexture, metalTex: !!t.metallicTexture,
          emis: t.emissiveColor ? [t.emissiveColor.r, t.emissiveColor.g, t.emissiveColor.b].map(v => +v.toFixed(2)) : null,
        }
      })
    })
    await shot(`gun_${name}`, { at: 'gun', r: 1.0, a: Math.PI / 2 - 0.5, b: 1.5 })
    await shot(`gun_${name}_wide`, { y: 1.0, r: 3.0, a: Math.PI / 2 - 0.4, b: 1.35 })
  }

  // ---- 3. LOCOMOTION
  const clips = await page.evaluate(() => window.playground.groups.map(g => g.name))
  const jog = clips.find(n => /Jog_Fwd_Loop/i.test(n))
  if (jog) {
    await page.evaluate((n) => window.playground.play(n), jog)
    await sleep(600)
    await shot('jog_a', { y: 1.0, r: 3.4, a: Math.PI / 2 - 0.4, b: 1.35 })
    await sleep(350); await page.screenshot({ path: `${OUT}_jog_b.png` })
    await sleep(350); await page.screenshot({ path: `${OUT}_jog_c.png` })
  }
  console.log(JSON.stringify({ jog, gunInfo, errors: errors.slice(0, 5) }, null, 1))
} catch (e) { console.error('ERR', e.message, errors.slice(0, 5)) } finally { await browser.close().catch(() => {}) }
