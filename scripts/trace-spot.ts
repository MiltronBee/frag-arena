// Tick-by-tick trace of ONE standing player, for diagnosing a specific slope spot.
//   SPOT_X=.. SPOT_Z=.. SPOT_Y=.. npx tsx scripts/trace-spot.ts
import * as BABYLON from '../common/babylon.node.js'
import http from 'http'; import fs from 'fs'; import path from 'path'
import XHR from 'xhr2'
;(global as any).XMLHttpRequest = XHR
import applyCommand from '../common/applyCommand'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import { MAP_MESH } from '../common/mapMesh'
import nengiConfig from '../common/nengiConfig'

const ROOT = path.resolve(process.env.HOME as string, 'unreal/public')
const PORT = 8097
const DT = 1 / nengiConfig.UPDATE_RATE
const cmd = () => ({
  forwards: false, backwards: false, left: false, right: false,
  jump: false, dodge: 0, reload: false, fireInput: false, aimInput: false,
  throwInput: false, camRayX: 0, camRayY: 0, camRayZ: 1, delta: DT,
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
  meshes.forEach(m => { m.computeWorldMatrix(true); m.checkCollisions = true; m.isPickable = true; m.refreshBoundingInfo && m.refreshBoundingInfo(true) })

  const X = parseFloat(process.env.SPOT_X || '0')
  const Z = parseFloat(process.env.SPOT_Z || '0')
  const Y = parseFloat(process.env.SPOT_Y || '0')

  const e: any = new PlayerCharacter()
  e.x = X; e.y = Y; e.z = Z
  e.velX = 0; e.velY = 0; e.velZ = 0; e.grounded = true; e.isAlive = true

  console.log(`start (${X.toFixed(3)}, ${Y.toFixed(3)}, ${Z.toFixed(3)})  killY(world)=${(MAP_MESH.killY * MAP_MESH.scale).toFixed(2)}`)

  // GROUND TRUTH FIRST — and do NOT read the `normal.y` column below as a slope.
  //
  // `collider.slidePlaneNormal` is NOT a unit surface normal in Babylon 9.17. It is a
  // residual vector whose magnitude scales with the UNCONSUMED part of the requested
  // move. Measured on this very map, on a face whose true normal is exactly (0,1,0)
  // (the flat main deck), sweeping a resting collider downward gives:
  //
  //     move  -0.005 -0.050 -0.100 -0.169 -0.250 -0.350 -0.500
  //     n.y    0.980  0.890  0.790  0.652  0.490  0.290 -0.010     (n.y ~= 1 - 2*|move|)
  //
  // Same flat floor every row; only the distance changed. So `n.y` encodes how far the
  // probe still had to travel, not how steep the thing it hit was — and a reading of
  // ~0.65 means "found something ~0.17m down", which is equally consistent with a
  // 49-degree face and with a flat step 0.17m below. Never conclude a slope from it.
  //
  // Therefore: dump the REAL triangle normals under a small neighbourhood first,
  // computed by pickWithRay with useVerticesNormals=false so it is the face normal
  // off the index buffer, not a smoothed vertex normal. A block of matching values is
  // a real surface; a sharp change or `void` is an edge or a step.
  const surfaceUnder = (x: number, z: number) => {
    const hit = scene.pickWithRay(
      new BABYLON.Ray(new BABYLON.Vector3(x, Y + 8, z), new BABYLON.Vector3(0, -1, 0), 60))
    if (!hit || !hit.hit || !hit.pickedPoint) return null
    const n = hit.getNormal(true, false)   // FACE normal — the arbiter
    return { y: hit.pickedPoint.y, ny: n ? Math.abs(n.y) : NaN, mesh: hit.pickedMesh!.name }
  }
  const here = surfaceUnder(X, Z)
  console.log(`TRUE face under start: ${here ? `y=${here.y.toFixed(3)} |n.y|=${here.ny.toFixed(3)} (${here.mesh})` : 'NOTHING — open void'}`)
  console.log('neighbourhood (true face y / |n.y|), 0.4m steps — "void" = no floor at all:')
  for (let dz = -0.8; dz <= 0.81; dz += 0.4) {
    let line = ''
    for (let dx = -0.8; dx <= 0.81; dx += 0.4) {
      const s = surfaceUnder(X + dx, Z + dz)
      line += s ? ` ${s.y.toFixed(2).padStart(7)}/${s.ny.toFixed(2)}` : '        void'
    }
    console.log(`  dz=${dz.toFixed(1).padStart(5)} |${line}`)
  }

  console.log('\ntick |        x        y        z |    velX    velY    velZ | grnd | slidePlane.y')
  console.log('(slidePlane.y = residual-distance artifact, NOT slope — see comment above)')
  for (let t = 0; t < 40; t++) {
    applyCommand(e, cmd() as any)
    const c = e.mesh.collider
    const ny = c && c.collisionFound && c.slidePlaneNormal ? c.slidePlaneNormal.y : NaN
    if (t < 24 || t % 8 === 0) {
      console.log(
        `${String(t).padStart(4)} | ${e.x.toFixed(4).padStart(8)} ${e.y.toFixed(4).padStart(8)} ${e.z.toFixed(4).padStart(8)} | ` +
        `${e.velX.toFixed(3).padStart(7)} ${e.velY.toFixed(3).padStart(7)} ${e.velZ.toFixed(3).padStart(7)} | ` +
        `${e.grounded ? ' ON ' : ' -- '} | ${isNaN(ny) ? '   --' : ny.toFixed(3)}`)
    }
  }
  server.close(); process.exit(0)
})()
