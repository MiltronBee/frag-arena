// End-to-end music verification. Serves public/ statically, boots the real client
// in headless Chrome, and inspects the live MusicManager (via window.gameClient)
// to confirm: both tracks resolve + 200, menu track plays on unlock (currentTime
// advances), and play('match') crossfades (match rises, menu falls). No game
// server needed — menu music + crossfade don't depend on the netcode connection.
import http from 'http'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(process.env.HOME, 'unreal/public')
const PORT = 8099
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.woff2': 'font/woff2',
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const file = path.join(ROOT, path.normalize(p))
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found')
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const results = []
const check = (name, pass, detail) => { results.push({ name, pass, detail }); }

await new Promise((r) => server.listen(PORT, r))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio', // silences output; currentTime still advances
    '--use-gl=angle', '--use-angle=swiftshader',
  ],
})

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => check('no page error: ' + e.message, false, String(e)))
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })

  // wait for the client to boot (window.gameClient hook set in clientMain.js)
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.music', { timeout: 15000 })
  check('client booted + MusicManager present', true)

  // settings controls exist in the DOM
  const controls = await page.evaluate(() => ({
    slider: !!document.getElementById('music-vol-slider'),
    mute: !!document.getElementById('music-mute'),
  }))
  check('settings has music volume slider', controls.slider)
  check('settings has mute toggle', controls.mute)

  // both mp3s resolve with 200 + audio/mpeg
  const http200 = await page.evaluate(async () => {
    const one = async (u) => {
      const r = await fetch(u); return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength }
    }
    return {
      menu: await one('/assets/music/arena-signal.mp3'),
      match: await one('/assets/music/frag-grenade.mp3'),
    }
  })
  check('arena-signal.mp3 served 200 audio/mpeg', http200.menu.ok && /audio\/mpeg/.test(http200.menu.type), JSON.stringify(http200.menu))
  check('frag-grenade.mp3 served 200 audio/mpeg', http200.match.ok && /audio\/mpeg/.test(http200.match.type), JSON.stringify(http200.match))

  // track src wiring
  const srcs = await page.evaluate(() => {
    const m = window.gameClient.simulator.music
    return { menu: m.tracks.menu.src, match: m.tracks.match.src, current: m.current, baseVolume: m.baseVolume }
  })
  check('menu track = arena-signal.mp3', /\/assets\/music\/arena-signal\.mp3$/.test(srcs.menu), srcs.menu)
  check('match track = frag-grenade.mp3', /\/assets\/music\/frag-grenade\.mp3$/.test(srcs.match), srcs.match)
  check("initial desired track is 'menu'", srcs.current === 'menu', 'current=' + srcs.current)

  // Unlock audio the way a real gesture does (the game calls music.unlock() from
  // pointerdown/touchstart). NB: do NOT page.mouse.click the bare canvas — headless
  // Chrome grants pointer lock freely, which fires pointerlockchange -> play('match')
  // and correctly leaves the menu. We're verifying the MENU state here, so unlock
  // directly and confirm we stay on it.
  await page.evaluate(() => window.gameClient.simulator.music.unlock())
  const traj = await page.evaluate(async () => {
    const m = window.gameClient.simulator.music
    const t = m.tracks.menu
    const samples = []
    for (let i = 0; i < 10; i++) {
      samples.push({ i, ct: +t.currentTime.toFixed(3), vol: +t.volume.toFixed(3), paused: t.paused, current: m.current })
      await new Promise((r) => setTimeout(r, 150))
    }
    return samples
  })
  console.log('--- MENU TRAJECTORY (expect current=menu, playing, vol -> 0.35) ---')
  for (const s of traj) console.log(JSON.stringify(s))
  console.log('-----------------------')
  const last = traj[traj.length - 1]
  const menuPlay = { paused: last.paused, t0: traj[3].ct, t1: last.ct, vol: last.vol }
  check("menu stays 'menu' until arena entered", last.current === 'menu', 'current=' + last.current)
  check('menu track is playing (not paused)', menuPlay.paused === false, JSON.stringify(menuPlay))
  check('menu track currentTime advances', menuPlay.t1 > menuPlay.t0 + 0.2, `t0=${menuPlay.t0.toFixed(2)} t1=${menuPlay.t1.toFixed(2)}`)
  check('menu track faded up (vol>0)', menuPlay.vol > 0, 'vol=' + menuPlay.vol.toFixed(3))

  // drive the crossfade to the match track and confirm menu falls / match rises
  await page.evaluate(() => window.gameClient.simulator.music.play('match'))
  await sleep(1200)
  const xfade = await page.evaluate(() => {
    const m = window.gameClient.simulator.music
    return { current: m.current, menuVol: m.tracks.menu.volume, matchVol: m.tracks.match.volume, matchPaused: m.tracks.match.paused, matchT: m.tracks.match.currentTime }
  })
  check("crossfaded: current is now 'match'", xfade.current === 'match', JSON.stringify(xfade))
  check('match track playing + advancing', xfade.matchPaused === false && xfade.matchT > 0, JSON.stringify(xfade))
  check('match volume risen above menu', xfade.matchVol > xfade.menuVol, `match=${xfade.matchVol.toFixed(3)} menu=${xfade.menuVol.toFixed(3)}`)

  // mute takes effect
  await page.evaluate(() => window.gameClient.simulator.music.setMuted(true))
  await sleep(900)
  const muted = await page.evaluate(() => window.gameClient.simulator.music.tracks.match.volume)
  check('mute drives volume to 0', muted < 0.02, 'vol=' + muted.toFixed(3))
} finally {
  await browser.close()
  server.close()
}

let failed = 0
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  if (!r.pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
