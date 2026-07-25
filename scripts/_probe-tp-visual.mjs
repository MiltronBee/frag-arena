// THIRD-PERSON VISUAL/ANIM diagnostics for remote players (bots), in the REAL game —
// not the playground. Answers, with hard numbers rather than screenshots:
//   * helmet    — is the gunmetal skin actually bound AND loaded, or still the GLB's
//                 flat near-black material? ("helmets are grey")
//   * held gun  — does the third-person weapon prop have a loaded albedo?
//   * pickups   — do the floor weapon props have a loaded albedo? ("guns have no skins")
//   * animation — how often does the locomotion clip SWITCH? A clip change restarts the
//                 group from frame 0, so rapid flapping between jog variants is exactly
//                 what "glitchy animations" looks like.
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const SAMPLE_MS = parseInt(process.env.SAMPLE_MS || '20000', 10)

const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
  procs.push(p); return p
}

let browser = null
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '4', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 9000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const failedReqs = []
  page.on('requestfailed', r => failedReqs.push(r.url()))
  page.on('response', r => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()) })

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
  await page.evaluate(() => window.gameClient.simulator.requestDeploy())
  await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 45000 })
  await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 45000 })
  await sleep(6000) // let helmets/weapons finish their async mounts

  // ---- install a per-frame animation sampler on every remote model -------------
  await page.evaluate(() => {
    const sim = window.gameClient.simulator
    window.__anim = { switches: 0, frames: 0, byClip: {}, seq: [] }
    window.__animTimer = setInterval(() => {
      const st = window.__anim
      for (const m of sim.characterModels.values()) {
        if (!m.ready) continue
        const name = m.current ? m.current.name : '(none)'
        st.frames++
        st.byClip[name] = (st.byClip[name] || 0) + 1
        const key = m.host && m.host.uniqueId
        if (st['last_' + key] !== undefined && st['last_' + key] !== name) {
          st.switches++
          if (st.seq.length < 200) st.seq.push(name)
        }
        st['last_' + key] = name
      }
    }, 33)
  })
  await sleep(SAMPLE_MS)

  const report = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    clearInterval(window.__animTimer)
    const texInfo = (t) => t ? { url: t.url || t.name, ready: typeof t.isReady === 'function' ? t.isReady() : null } : null
    const matInfo = (m) => {
      if (!m.material) return null
      const mt = m.material
      return {
        mesh: m.name, mat: mt.name, cls: mt.getClassName ? mt.getClassName() : '?',
        albedo: texInfo(mt.albedoTexture || mt.diffuseTexture),
        emissiveTex: texInfo(mt.emissiveTexture),
        emissive: mt.emissiveColor ? [+mt.emissiveColor.r.toFixed(2), +mt.emissiveColor.g.toFixed(2), +mt.emissiveColor.b.toFixed(2)] : null,
        albedoColor: mt.albedoColor ? [+mt.albedoColor.r.toFixed(2), +mt.albedoColor.g.toFixed(2), +mt.albedoColor.b.toFixed(2)] : null,
        metallic: typeof mt.metallic === 'number' ? +mt.metallic.toFixed(2) : null,
        roughness: typeof mt.roughness === 'number' ? +mt.roughness.toFixed(2) : null,
        helmetSkinned: !!mt._helmetSkinned, pickupLit: !!mt._pickupLit,
      }
    }
    const collect = (root) => root ? [root, ...root.getChildMeshes()].filter(m => m.material).map(matInfo) : []

    const chars = []
    for (const m of sim.characterModels.values()) {
      chars.push({
        ready: m.ready,
        clips: Object.keys(m.groups || {}).length,
        current: m.current ? m.current.name : null,
        hasHelmet: !!m._helmetRoot,
        helmetMats: collect(m._helmetRoot),
        hasWeapon: !!m._weaponRoot,
        weaponMats: collect(m._weaponRoot),
        bodyMats: collect(m.holder).slice(0, 3),
        armorMounted: !!m._armorRoots && m._armorRoots.length,
      })
    }

    const pickups = []
    if (sim._pickups) {
      for (const p of sim._pickups.values()) {
        if (!p._pickupModel) continue
        pickups.push({ mats: collect(p._pickupModel) })
      }
    }

    return { chars: chars.slice(0, 3), pickupCount: pickups.length, pickups: pickups.slice(0, 3), anim: window.__anim }
  })

  const anim = report.anim || {}
  const secs = SAMPLE_MS / 1000
  console.log(JSON.stringify({
    animation: {
      sampledSeconds: secs,
      clipSwitches: anim.switches,
      switchesPerSecond: +(anim.switches / secs).toFixed(2),
      clipHistogram: anim.byClip,
      firstSwitches: (anim.seq || []).slice(0, 40),
    },
    characters: report.chars,
    pickupCount: report.pickupCount,
    pickups: report.pickups,
    pageErrors: errors.slice(0, 10),
    failedRequests: [...new Set(failedReqs)].slice(0, 15),
  }, null, 2))
} catch (e) {
  console.error('ERR', e.message, e.stack)
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
