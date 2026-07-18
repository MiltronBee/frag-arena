// ADS (aim-down-sights) runtime verification. Serves public/ statically, boots the
// real client in headless Chrome, and drives the live Simulator/Viewmodel via the
// window.gameClient hook. The headline guard is AIM-RAY INVARIANCE: the composed
// world-camera FOV must never move camera.getForwardRay() (the fire ray + the
// MoveCommand aim). Also checks the Viewmodel aim FSM, composed FOV, and sensitivity
// scaling. No game server needed — the viewmodel equips + the camera exists offline.
import http from 'http'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(process.env.HOME, 'unreal/public')
const PORT = 8097
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'
  const file = path.join(ROOT, path.normalize(p))
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })

await new Promise((r) => server.listen(PORT, r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'] })
try {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 15000 })

  // wait for the Rifle viewmodel to load and settle into idle
  await page.waitForFunction(
    "window.gameClient.simulator.viewmodel && window.gameClient.simulator.viewmodel.ready", { timeout: 20000 })
  const vm0 = await page.evaluate(() => {
    const v = window.gameClient.simulator.viewmodel
    return { hasAds: v.hasAds, state: v.aimState, name: v.spec.name }
  })
  check('Rifle viewmodel loaded with ADS clips (hasAds)', vm0.hasAds, JSON.stringify(vm0))
  await page.waitForFunction("['idle','drawing'].includes(window.gameClient.simulator.viewmodel.aimState)", { timeout: 8000 }).catch(() => {})

  // ---- AIM-RAY INVARIANCE: FOV change must not move getForwardRay() ----
  const inv = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const cam = sim.renderer.camera
    // pin a fixed, non-trivial orientation
    cam.rotation.x = 0.21; cam.rotation.y = -0.63; cam.rotation.z = 0
    sim._recoilApplied.set(0, 0, 0); sim._recoilFov = null
    const dir = () => { const d = cam.getForwardRay().direction; return { x: d.x, y: d.y, z: d.z } }
    sim._adsT = 0; sim._applyRecoilFov(); const fovHip = cam.fov; const r0 = dir()
    sim._adsT = 1; sim._applyRecoilFov(); const fovAds = cam.fov; const r1 = dir()
    const d = Math.hypot(r1.x - r0.x, r1.y - r0.y, r1.z - r0.z)
    return { fovHip, fovAds, rayDelta: d, r0, r1 }
  })
  check('ADS zooms the world camera (fov shrinks)', inv.fovAds < inv.fovHip - 1e-4, `hip=${inv.fovHip.toFixed(4)} ads=${inv.fovAds.toFixed(4)}`)
  check('AIM RAY UNCHANGED by ADS FOV (delta < 1e-6)', inv.rayDelta < 1e-6, `rayDelta=${inv.rayDelta.toExponential(2)}`)

  // ---- composed FOV values: hip == user FOV(deg), aimed == weapon ads.fov(deg) ----
  const fovs = await page.evaluate(() => {
    const sim = window.gameClient.simulator, cam = sim.renderer.camera
    const deg = (rad) => rad * 180 / Math.PI
    sim._recoilFov = null
    sim._adsT = 0; sim._applyRecoilFov(); const hip = deg(cam.fov)
    sim._adsT = 1; sim._applyRecoilFov(); const ads = deg(cam.fov)
    return { hip: Math.round(hip), ads: Math.round(ads), userFov: sim.fov }
  })
  check('hip FOV == user FOV setting', Math.abs(fovs.hip - fovs.userFov) <= 1, JSON.stringify(fovs))
  check('aimed FOV == Rifle ads.fov (75)', fovs.ads === 75, JSON.stringify(fovs))

  // ---- sensitivity scaling ----
  const sens = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    sim._adsT = 0; const hip = sim._adsSensFactor()
    sim._adsT = 1; const ads = sim._adsSensFactor()
    return { hip, ads }
  })
  check('sensitivity 1.0 at hip', Math.abs(sens.hip - 1) < 1e-6, JSON.stringify(sens))
  // focal-length matched: tan(75/2)/tan(95/2) ~= 0.703
  check('sensitivity focal-length matched aimed (~0.70)', Math.abs(sens.ads - 0.703) < 0.02, JSON.stringify(sens))

  // ---- Viewmodel aim FSM: idle -> aiming_in -> aimed -> aiming_out -> idle ----
  // The game's RAF only renders the scene when an entity is spawned, so offline we
  // pump scene.render() ourselves to step Babylon's animation clock and let the
  // one-shot clip-end observables fire (this is what drives the FSM transitions).
  const pump = async (ms) => {
    const steps = Math.max(1, Math.round(ms / 16))
    for (let i = 0; i < steps; i++) { await page.evaluate(() => window.gameClient.simulator.renderer.scene.render()); await sleep(16) }
  }
  const state = () => page.evaluate(() => window.gameClient.simulator.viewmodel.aimState)

  await pump(1400) // let the draw clip finish -> idle
  check("viewmodel settles to 'idle' after draw", (await state()) === 'idle', 'state=' + (await state()))

  await page.evaluate(() => window.gameClient.simulator.viewmodel.setAim(true))
  check("aim pressed -> 'aiming_in'", (await state()) === 'aiming_in', 'state=' + (await state()))
  await pump(1200)
  check("aim_start ends -> 'aimed'", (await state()) === 'aimed', 'state=' + (await state()))

  // fire while aimed -> ads_firing -> back to aimed (still held)
  await page.evaluate(() => window.gameClient.simulator.viewmodel.kick({ back: 0.5, up: 0.06, pitch: 0.35 }))
  check("fire while aimed -> 'ads_firing'", (await state()) === 'ads_firing', 'state=' + (await state()))
  await pump(1400)
  check("fire_aiming ends, still held -> 'aimed'", (await state()) === 'aimed', 'state=' + (await state()))

  // release -> aiming_out -> idle
  await page.evaluate(() => window.gameClient.simulator.viewmodel.setAim(false))
  check("release -> 'aiming_out'", (await state()) === 'aiming_out', 'state=' + (await state()))
  await pump(1400)
  check("aim_end ends -> 'idle'", (await state()) === 'idle', 'state=' + (await state()))

  // reload cancels aim: aim, then reload -> reloading (ADS exited)
  await page.evaluate(() => window.gameClient.simulator.viewmodel.setAim(true))
  await pump(1200)
  await page.evaluate(() => window.gameClient.simulator.viewmodel.reload())
  check('reload exits ADS (state == reloading)', (await state()) === 'reloading', 'state=' + (await state()))
  await pump(1600)
  // aim was still held through the reload, so it correctly re-aims afterwards
  check('reload held-through -> re-aims (aimed)', (await state()) === 'aimed', 'state=' + (await state()))
  await page.evaluate(() => window.gameClient.simulator.viewmodel.setAim(false))
  await pump(1400)
  check('release after re-aim -> idle', (await state()) === 'idle', 'state=' + (await state()))

  // REGRESSION: pressing ADS mid hip-fire must settle to AIMED when the shot ends, not
  // hip idle (the "FOV zooms but no aim animation" bug). Ensure idle, hip-fire, press
  // aim DURING the shot, let it finish -> must be aimed.
  await pump(600) // fully idle
  await page.evaluate(() => window.gameClient.simulator.viewmodel.kick({ back: 0.5, up: 0.06, pitch: 0.35 }))
  check('hip fire (aim released) -> firing', (await state()) === 'firing', 'state=' + (await state()))
  await page.evaluate(() => window.gameClient.simulator.viewmodel.setAim(true)) // press ADS mid-shot
  await pump(1600)
  check('ADS pressed during hip-fire settles to AIMED (bug fix)', (await state()) === 'aimed', 'state=' + (await state()))
} finally {
  await browser.close(); server.close()
}
let failed = 0
for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`); if (!r.pass) failed++ }
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
