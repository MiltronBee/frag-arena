// which chrome GL backend / viewport gets the client above ~20fps headless?
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})
const procs = []
const boot = (cmd, args, env, tag) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${String(d).slice(0, 160)}`))
  procs.push(p); return p
}
const BASE = ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
const CONFIGS = [
  { name: 'swiftshader-900x620', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], vp: [900, 620] },
  { name: 'swiftshader-320x240', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], vp: [320, 240] },
  { name: 'egl-900x620', args: ['--use-gl=egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'], vp: [900, 620] },
  { name: 'angle-vulkan-900x620', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'], vp: [900, 620] },
  { name: 'default-900x620', args: ['--ignore-gpu-blocklist'], vp: [900, 620] },
]
try {
  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 60000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '5', MATCH_SECONDS: '3000' }, 'srv')
  const ownVite = !(await portBusy(8080))
  if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 11000 : 6000)
  for (const c of CONFIGS) {
    let br = null
    try {
      br = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 120000, args: [...BASE, ...c.args] })
      const page = await br.newPage()
      await page.setViewport({ width: c.vp[0], height: c.vp[1] })
      await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
      await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 45000 })
      await page.evaluate(() => window.gameClient.simulator.requestDeploy())
      await page.waitForFunction('window.gameClient.simulator.characterModels.size > 0', { timeout: 40000 })
      await sleep(6000)
      const r = await page.evaluate(async () => {
        const sc = window.gameClient.simulator.renderer.scene
        let n = 0; const ob = sc.onAfterRenderObservable.add(() => n++)
        const t = performance.now(); await new Promise(r => setTimeout(r, 5000))
        sc.onAfterRenderObservable.remove(ob)
        const gl = document.querySelector('canvas')?.getContext?.('webgl2')
        return { fps: +(n / ((performance.now() - t) / 1000)).toFixed(1), renderer: sc.getEngine().description || '' }
      })
      console.log(c.name, JSON.stringify(r))
    } catch (e) { console.log(c.name, 'FAIL', e.message.slice(0, 120)) } finally { if (br) await br.close().catch(() => {}) }
  }
} catch (e) { console.error('ERR', e.stack) } finally {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(800)
}
