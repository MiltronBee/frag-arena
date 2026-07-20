// Slope-slide REPRO / REGRESSION probe for common/applyCommand.js.
//
// Loads the REAL active mesh map (common/mapMesh MAP_MESH) into a NullEngine scene
// exactly like the server does, drops a player onto sloped ground, and measures
// what a player who presses NOTHING actually does over 3 seconds of sim ticks:
//
//   - drift: how far the "standing still" player slid (m) and its final speed
//   - grounded duty cycle: what fraction of ticks the sim believed it was grounded
//     (friction only runs on grounded ticks — a low duty cycle IS the ice feel)
//
// It also walks the player downhill to detect ballistic ground-loss.
//
// Deterministic: static map data + fixed command sequences, no time/random.
//   npx tsx scripts/probe-slope-slide.ts
import * as BABYLON from '../common/babylon.node.js'
import http from 'http'; import fs from 'fs'; import path from 'path'
import XHR from 'xhr2'
;(global as any).XMLHttpRequest = XHR
import applyCommand from '../_work/slope-verify/applyCommand.PRESTRUCT-harness.js'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import { MAP_MESH } from '../common/mapMesh'
import nengiConfig from '../common/nengiConfig'

const ROOT = path.resolve(process.env.HOME as string, 'unreal/public')
const PORT = 8097
const DT = 1 / nengiConfig.UPDATE_RATE

const cmd = (over: any = {}) => ({
  forwards: false, backwards: false, left: false, right: false,
  jump: false, dodge: 0, reload: false, fireInput: false, aimInput: false,
  throwInput: false, camRayX: 0, camRayY: 0, camRayZ: 1, delta: DT, ...over,
})

;(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent((req.url as string).split('?')[0]))
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200); fs.createReadStream(f).pipe(res)
  })
  await new Promise<void>(r => server.listen(PORT, () => r()))

  const engine = new BABYLON.NullEngine()
  engine.enableOfflineSupport = false
  const scene = new BABYLON.Scene(engine)
  scene.collisionsEnabled = true

  const loaded = await BABYLON.SceneLoader.ImportMeshAsync(
    '', `http://localhost:${PORT}${MAP_MESH.dir}`, MAP_MESH.file, scene)
  const meshes = loaded.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
  const root = new BABYLON.TransformNode('mapRoot', scene)
  meshes.forEach(m => { if (!m.parent) m.parent = root })
  root.rotation.x = MAP_MESH.rotationX
  root.scaling.setAll(MAP_MESH.scale)
  root.computeWorldMatrix(true)
  meshes.forEach(m => {
    m.computeWorldMatrix(true); m.checkCollisions = true
    m.refreshBoundingInfo && m.refreshBoundingInfo(true)
  })
  console.log(`map: ${MAP_MESH.file}  scale=${MAP_MESH.scale}  tick=${nengiConfig.UPDATE_RATE}Hz dt=${DT}`)

  // Measure the local surface slope by dropping 3 probes in a small triangle and
  // fitting a plane through the rest points. Pure geometry — no sim involved.
  const dropTo = (px: number, pz: number, fromY: number): number | null => {
    const p = BABYLON.MeshBuilder.CreateBox('probe', { size: 1 }, scene)
    p.ellipsoid = new BABYLON.Vector3(0.5, 0.5, 0.5); p.checkCollisions = true
    p.position.set(px, fromY, pz)
    let vy = 0, rest: number | null = null
    for (let t = 0; t < 900; t++) {
      vy -= 18 * DT; const oldY = p.position.y
      p.computeWorldMatrix(true)
      p.moveWithCollisions(new BABYLON.Vector3(0, vy * DT, 0))
      if (vy < 0 && (p.position.y - oldY) - vy * DT > 0.001) { rest = p.position.y; break }
      if (p.position.y < MAP_MESH.killY * MAP_MESH.scale - 10) break
    }
    p.dispose(); return rest
  }

  const slopeAt = (x: number, z: number, y: number) => {
    const d = 0.6, top = y + 3
    const a = dropTo(x - d, z - d, top), b = dropTo(x + d, z - d, top), c = dropTo(x, z + d, top)
    if (a === null || b === null || c === null) return null
    const p1 = new BABYLON.Vector3(x - d, a, z - d)
    const p2 = new BABYLON.Vector3(x + d, b, z - d)
    const p3 = new BABYLON.Vector3(x, c, z + d)
    const n = BABYLON.Vector3.Cross(p2.subtract(p1), p3.subtract(p1)).normalize()
    const ny = Math.abs(n.y)
    return { deg: (Math.acos(Math.min(1, ny)) * 180) / Math.PI, normalY: ny }
  }

  // Run N ticks of the REAL sim from a rest position, holding `over` inputs.
  const run = (startX: number, startZ: number, startY: number, ticks: number, over: any = {}) => {
    const e: any = new PlayerCharacter()
    e.x = startX; e.y = startY; e.z = startZ
    e.velX = 0; e.velY = 0; e.velZ = 0; e.grounded = true; e.isAlive = true
    let groundedTicks = 0, maxSpeed = 0, airRuns = 0, inAir = false
    const x0 = e.x, z0 = e.z
    for (let t = 0; t < ticks; t++) {
      applyCommand(e, cmd(over) as any)
      if (e.grounded) { groundedTicks++; inAir = false }
      else { if (!inAir) airRuns++; inAir = true }
      const s = Math.hypot(e.velX, e.velZ)
      if (s > maxSpeed) maxSpeed = s
      if (e.y < MAP_MESH.killY * MAP_MESH.scale) break
    }
    const _r = {
      drift: Math.hypot(e.x - x0, e.z - z0),
      speed: Math.hypot(e.velX, e.velZ),
      maxSpeed,
      duty: groundedTicks / ticks,
      airRuns,
      dropped: e.y - startY,
    }
    e.mesh.dispose()
    return _r
  }

  // Sample candidate stands: the map spawns (native units -> world) plus a scatter,
  // keep the ones that rest on ground, and report the most-sloped ones.
  const S = MAP_MESH.scale
  const cands: { x: number; z: number; y: number; slope: any }[] = []
  for (const sp of MAP_MESH.spawns) {
    for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [5, 5], [-5, -5], [6, 0], [0, 6]]) {
      const x = sp.x * S + dx, z = sp.z * S + dz
      const y = dropTo(x, z, sp.y * S + 6)
      if (y === null) continue
      const slope = slopeAt(x, z, y)
      if (!slope) continue
      cands.push({ x, z, y, slope })
    }
  }
  cands.sort((a, b) => b.slope.deg - a.slope.deg)

  console.log(`\nprobed ${cands.length} standable spots; steepest first\n`)
  console.log('  slope   normalY | STAND 3s: drift  endSpd  grounded%  airRuns | WALK 2s: drift  maxSpd  grounded%')
  console.log('  ' + '-'.repeat(100))
  const report = cands.slice(0, 12)
  for (const c of report) {
    const stand = run(c.x, c.z, c.y, 120)                    // 3s, no input
    const walk = run(c.x, c.z, c.y, 80, { forwards: true })  // 2s, holding W
    console.log(
      `  ${c.slope.deg.toFixed(1).padStart(5)}°  ${c.slope.normalY.toFixed(3)} | ` +
      `${stand.drift.toFixed(3).padStart(13)}m ${stand.speed.toFixed(2).padStart(6)} ` +
      `${(stand.duty * 100).toFixed(0).padStart(8)}% ${String(stand.airRuns).padStart(8)} | ` +
      `${walk.drift.toFixed(2).padStart(9)}m ${walk.maxSpeed.toFixed(2).padStart(6)} ` +
      `${(walk.duty * 100).toFixed(0).padStart(9)}% | @ ${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}`)
  }

  // Only WALKABLE ground is asserted on. Steep faces (normalY < MIN_WALK_NORMAL)
  // are walls — sliding down those is the CORRECT, intended behaviour.
  const MIN_WALK_NORMAL = 0.7
  const walkables = cands.filter(c => c.slope.normalY >= MIN_WALK_NORMAL)
  console.log(`\n${walkables.length} of ${cands.length} spots are walkable (normalY >= ${MIN_WALK_NORMAL})`)
  let worst: any = null, w: any = null
  for (const c of walkables) {
    const r = run(c.x, c.z, c.y, 120)
    if (!w || r.drift > w.drift) { w = r; worst = c }
  }
  if (!w) { console.log('no walkable spots probed'); server.close(); process.exit(1) }
  console.log(`WORST WALKABLE STAND-STILL DRIFT: ${w.drift.toFixed(3)}m over 3s on a ${worst.slope.deg.toFixed(1)}° slope` +
    ` @ ${worst.x.toFixed(2)},${worst.y.toFixed(2)},${worst.z.toFixed(2)}` +
    ` (end speed ${w.speed.toFixed(2)} m/s, grounded ${(w.duty * 100).toFixed(0)}% of ticks,` +
    ` ${w.airRuns} airborne runs, sank ${w.dropped.toFixed(2)}m)`)
  console.log(`VERDICT: ${w.drift < 0.05 ? 'PASS — standing players stay put on walkable ground ✓' : 'FAIL — standing players slide ✗'}`)

  server.close(); process.exit(w.drift < 0.05 ? 0 : 1)
})()
