// WALK-IN capture repro: a team-0 human spawns at the BLUE (team-1) flag, grabs it, then
// autopilots across the Facing-Worlds bridge to the team-0 home stand and tries to score.
// Unlike _probe-cap-test.mjs (which teleports onto the stand and proves the RULE works),
// this exercises the whole player-facing loop — the thing the user actually does.
//
// Route: the map's OWN baked UT ReachSpec nav graph (public/assets/maps/<Map>/<Map>.nav.json,
// the same file server/navGraph.js feeds the bots) is loaded here and A*'d from the live
// spawn position to the team-0 FlagBase node. A hand-picked two-waypoint line does NOT work
// — the blue tower interior walls it in — so we follow real floor the whole way.
//
// Autopilot: hold `forwards` on InputSystem._currentState (releaseKeys copies it into
// frameState every frame) and steer by writing the camera yaw. Stuck detection (no 1m of
// progress in 3s) jumps and fans the heading until it unwedges.
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const portBusy = p => new Promise(res => {
  const s = net.createConnection({ port: +p, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false))
})

const SCALE = 0.65
const NAV = 'public/assets/maps/CTF-Visage/CTF-Visage.nav.json'
const BLUE_FLAG_NATIVE = '-19.306,-37.508,-11.28'
const T0 = { x: 123.599 * SCALE, y: -37.28 * SCALE, z: 8.356 * SCALE } // team-0 stand (world, pre drop-probe)

// ---------------------------------------------------------------------------
// Nav graph + A* (same fit rules as server/navGraph.js: player r=0.5 hh=0.5, no specials)
// ---------------------------------------------------------------------------
const buildNav = () => {
  const d = JSON.parse(fs.readFileSync(NAV, 'utf8'))
  const nodes = d.nodes.map(n => ({ x: n.x * SCALE, y: n.y * SCALE, z: n.z * SCALE, cls: n.cls }))
  const N = nodes.length
  const adj = Array.from({ length: N }, () => [])
  for (const [from, to, dist, radius, height, jump, special] of d.edges) {
    if (special) continue
    if (radius * SCALE < 0.5 || height * SCALE < 0.5) continue
    adj[from].push({ to, dist: dist * SCALE, jump: !!jump })
  }
  return { nodes, adj, N }
}
const nearestNode = (g, x, y, z) => {
  let best = -1, bestD = Infinity
  for (let i = 0; i < g.N; i++) {
    if (!g.adj[i].length) continue
    const n = g.nodes[i]
    const dx = n.x - x, dz = n.z - z, dy = n.y - y
    const d = dx * dx + dz * dz + dy * dy * 4
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}
const aStar = (g, start, goal) => {
  if (start < 0 || goal < 0) return null
  if (start === goal) return [start]
  const { nodes, adj, N } = g
  const gn = nodes[goal]
  const h = i => Math.hypot(nodes[i].x - gn.x, nodes[i].y - gn.y, nodes[i].z - gn.z)
  const gScore = new Float64Array(N).fill(Infinity)
  const came = new Int32Array(N).fill(-1)
  const closed = new Uint8Array(N)
  gScore[start] = 0
  const heap = [[h(start), start]]
  const push = (f, n) => {
    heap.push([f, n]); let i = heap.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p }
  }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last; let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let s = i
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r
        if (s === i) break;[heap[s], heap[i]] = [heap[i], heap[s]]; i = s
      }
    }
    return top
  }
  while (heap.length) {
    const [, u] = pop()
    if (u === goal) { const path = [u]; let c = u; while ((c = came[c]) !== -1) path.push(c); return path.reverse() }
    if (closed[u]) continue
    closed[u] = 1
    for (const e of adj[u]) {
      if (closed[e.to]) continue
      const ng = gScore[u] + e.dist
      if (ng < gScore[e.to]) { gScore[e.to] = ng; came[e.to] = u; push(ng + h(e.to), e.to) }
    }
  }
  return null
}

let serverLog = ''
const procs = []
const boot = (cmd, args, env, tag, cap) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { const s = d.toString(); if (cap) serverLog += s; if (/objective|error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
  p.stderr.on('data', d => { const s = d.toString(); if (cap) serverLog += s; process.stderr.write(`[${tag}!] ${s}`) })
  procs.push(p); return p
}

let browser = null
try {
  const nav = buildNav()

  const t0 = Date.now()
  while ((await portBusy(8078) || await portBusy(8079)) && Date.now() - t0 < 90000) await sleep(4000)
  boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOTS: '0', DEV_SPAWN_AT: BLUE_FLAG_NATIVE, CAPDIAG: '1', MATCH_SECONDS: '900' }, 'srv', true)
  const ownVite = !(await portBusy(8080)); if (ownVite) boot('npx', ['vite', '--port', '8080', '--strictPort'], {}, 'vite')
  await sleep(ownVite ? 10000 : 6000)

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 600 })
  const events = []
  await page.exposeFunction('__obj', e => events.push({ ...e, t: Date.now() }))
  page.on('pageerror', e => console.error('[page!]', e.message))
  // Attach (or RE-attach after a client reload — the map-change/disconnect path calls
  // location.reload(), which drops window.gameClient and every listener with it).
  let reloads = 0
  const attach = async (navigate) => {
    if (navigate) await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction('window.gameClient?.simulator?._connectionState === "connected"', { timeout: 60000 })
    await page.evaluate(() => {
      const sim = window.gameClient.simulator
      if (sim.__probeHooked) return
      sim.__probeHooked = true
      sim.client.on('message::ObjectiveEvent', m => window.__obj({ kind: m.kind, team: m.team, nid: m.playerNid }))
      sim.requestDeploy()
    })
    await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
    await sleep(1500)
  }
  page.on('framenavigated', f => { if (f === page.mainFrame()) reloads++ })
  await attach(true)

  // Live world state: real (drop-probed) flag stand positions + the current position.
  const snapshot = () => page.evaluate(() => {
    const sim = window.gameClient.simulator
    const e = sim.myRawEntity
    if (!e) return null
    const flags = []
    for (const f of sim._flags.values()) flags.push({ team: f.team, x: +f.x.toFixed(2), y: +f.y.toFixed(2), z: +f.z.toFixed(2), state: f.state, carrierNid: f.carrierNid })
    return { me: { x: e.x, y: e.y, z: e.z, teamId: e.teamId, nid: sim.mySmoothId }, flags }
  })

  const world = await snapshot()
  const myTeam = world.me.teamId
  const ownFlagNow = world.flags.find(f => f.team === myTeam)
  const goalPt = ownFlagNow ? { x: ownFlagNow.x, y: ownFlagNow.y, z: ownFlagNow.z } : T0

  // Route from a live position to the stand, as node waypoints + the real stand last.
  const planFrom = (p) => {
    const sIdx = nearestNode(nav, p.x, p.y, p.z)
    const gIdx = nearestNode(nav, goalPt.x, goalPt.y, goalPt.z)
    const idx = aStar(nav, sIdx, gIdx)
    if (!idx) return null
    const w = idx.map(i => ({ ...nav.nodes[i], node: i }))
    w.push({ x: goalPt.x, y: goalPt.y, z: goalPt.z, cls: 'STAND', node: -1 })
    return w
  }

  let wps = planFrom(world.me)
  if (!wps) throw new Error('no nav path from spawn to own stand')

  const report = {
    myTeam, myNid: world.me.nid, spawn: world.me, goal: goalPt,
    flagsAtStart: world.flags,
    route: wps.map(w => `${w.node}:${w.cls}(${w.x.toFixed(1)},${w.y.toFixed(1)},${w.z.toFixed(1)})`),
    grabbed: false, captured: false, minDistToStand: 999, deaths: 0, stucks: 0, wpReached: 0,
    evalErrors: 0, replans: 0,
  }

  const track = []
  const START = Date.now()
  const DEADLINE = START + 300000
  let wi = 0
  let lastProgressAt = Date.now()
  let lastProgressPos = { x: world.me.x, z: world.me.z }
  let fan = 0          // heading offset (rad) applied while unwedging
  let jumpUntil = 0
  let wasAlive = true

  while (Date.now() < DEADLINE) {
    const target = wps[Math.min(wi, wps.length - 1)]
    let st = null
    try {
      st = await page.evaluate(({ tx, tz, fan, jump }) => {
        const sim = window.gameClient && window.gameClient.simulator
        const e = sim && sim.myRawEntity
        if (!e) return null
        sim.renderer.camera.rotation.y = Math.atan2(tx - e.x, tz - e.z) + fan
        sim.renderer.camera.rotation.x = 0
        const cs = sim.input && sim.input._currentState
        if (cs) { cs.forwards = true; cs.backwards = cs.left = cs.right = false; cs.jump = jump; cs.mouseDown = false }
        let carrying = false, ownFlag = null, enemyFlag = null
        for (const f of sim._flags.values()) {
          if (f.carrierNid === sim.mySmoothId) carrying = true
          if (f.team === e.teamId) ownFlag = { state: f.state }
          else enemyFlag = { state: f.state, carrier: f.carrierNid }
        }
        return { x: e.x, y: e.y, z: e.z, carrying, ownFlag, enemyFlag, alive: e.isAlive }
      }, { tx: target.x, tz: target.z, fan, jump: Date.now() < jumpUntil })
    } catch (err) {
      // the client reloaded (map change / disconnect) — re-attach and carry on
      report.evalErrors++
      try { await attach(false) } catch (e2) { try { await attach(true) } catch (e3) {} }
      const w2 = await snapshot().catch(() => null)
      if (w2) { const p = planFrom(w2.me); if (p) { wps = p; wi = 0; report.replans++ } }
      lastProgressAt = Date.now()
      continue
    }

    if (!st) {
      // dead / not yet respawned: hold still, then re-plan from wherever we come back
      await sleep(400)
      const w2 = await snapshot().catch(() => null)
      if (w2) { const p = planFrom(w2.me); if (p) { wps = p; wi = 0; report.replans++; lastProgressAt = Date.now(); lastProgressPos = { x: w2.me.x, z: w2.me.z } } }
      continue
    }

    if (st.carrying) report.grabbed = true
    if (wasAlive && st.alive === false) {
      report.deaths++
      // respawn puts us back at DEV_SPAWN_AT (the enemy stand) — re-plan from there
      await sleep(4000)
      const w2 = await snapshot().catch(() => null)
      if (w2) { const p = planFrom(w2.me); if (p) { wps = p; wi = 0; report.replans++ } }
      wasAlive = true
      fan = 0; lastProgressAt = Date.now()
      continue
    }
    wasAlive = st.alive !== false

    const dWp = Math.hypot(st.x - target.x, st.z - target.z)
    const dGoal = Math.hypot(st.x - goalPt.x, st.z - goalPt.z)
    if (dGoal < report.minDistToStand) report.minDistToStand = +dGoal.toFixed(2)

    // waypoint advance: horizontal proximity + a loose vertical gate (bridge apex is ~7m up)
    if (wi < wps.length - 1 && dWp < 2.2 && Math.abs(st.y - target.y) < 4) { wi++; report.wpReached = Math.max(report.wpReached, wi); fan = 0; lastProgressAt = Date.now() }

    // stuck detection: <1m of ground gained in 3s -> jump + fan the heading
    const moved = Math.hypot(st.x - lastProgressPos.x, st.z - lastProgressPos.z)
    if (moved > 1.0) { lastProgressPos = { x: st.x, z: st.z }; lastProgressAt = Date.now(); fan = 0 }
    else if (Date.now() - lastProgressAt > 3000) {
      report.stucks++
      jumpUntil = Date.now() + 500
      fan = [0.6, -0.6, 1.2, -1.2, 2.0][report.stucks % 5]
      lastProgressAt = Date.now()
      lastProgressPos = { x: st.x, z: st.z }
    }

    track.push({ t: +((Date.now() - START) / 1000).toFixed(1), wi, x: +st.x.toFixed(1), y: +st.y.toFixed(1), z: +st.z.toFixed(1), dWp: +dWp.toFixed(1), dGoal: +dGoal.toFixed(1), carry: st.carrying, own: st.ownFlag && st.ownFlag.state, alive: st.alive })

    if (events.some(e => e.kind === 3)) { report.captured = true; break }
    await sleep(200)
  }

  report.reloads = reloads
  report.events = events.map(e => ({ kind: e.kind, team: e.team, nid: e.nid, t: +((e.t - START) / 1000).toFixed(1) }))
  report.trackSamples = track.filter((_, i) => i % 15 === 0).concat(track.slice(-8))
  report.capdiag = (serverLog.match(/\[capdiag\][^\n]*/g) || []).slice(-8)
  report.objectiveLog = (serverLog.match(/\[objective\][^\n]*/g) || [])
  report.serverTail = serverLog.split('\n').filter(l => l && !l.includes('[capdiag]')).slice(-25)
  report.verdict = report.captured ? 'WALK_CAPTURE_OK' : 'WALK_CAPTURE_FAILED'
  console.log('===REPORT===')
  console.log(JSON.stringify(report, null, 2))
} catch (e) {
  console.error('ERR', e.message, e.stack)
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  await sleep(400); spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true']); await sleep(600)
}
