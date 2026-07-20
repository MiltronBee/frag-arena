// Find the correct up-orientation for the artist OBJ and verify walkable floors.
// Rotates the map by ROTX degrees about X (Z-up OBJ -> Y-up engine is usually -90),
// then grid-probes: drops players over a grid and reports how many land + a floor
// height histogram. The right orientation = lots of probes landing on a FEW
// consistent floor levels (a real multi-level building), not scattered wall hits.
//   ROTX=-90 npx tsx scripts/verify-meshmap.ts
import * as BABYLON from '../common/babylon.node.js'
import '@babylonjs/loaders/glTF/index.js' // register glTF/GLB loader (node barrel already covers OBJ)
import http from 'http'; import fs from 'fs'; import path from 'path'
import XHR from 'xhr2'
;(global as any).XMLHttpRequest = XHR

const ROOT = path.resolve(process.env.HOME as string, 'unreal/public')
const PORT = 8098
const MAPDIR = '/assets/maps/DM-W-Grove/'
const MAPFILE = 'DM-W-Grove-2025.obj'
const ROTX = (parseFloat(process.env.ROTX || '0') * Math.PI) / 180

;(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent((req.url as string).split('?')[0]))
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200); fs.createReadStream(f).pipe(res)
  })
  await new Promise<void>(r => server.listen(PORT, () => r()))

  const engine = new BABYLON.NullEngine()
  const scene = new BABYLON.Scene(engine)
  scene.collisionsEnabled = true

  const loaded = await BABYLON.SceneLoader.ImportMeshAsync('', `http://localhost:${PORT}${MAPDIR}`, MAPFILE, scene)
  const meshes = loaded.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)

  // rotate the whole map about X (upright it) via a root, then bake world matrices
  const root = new BABYLON.TransformNode('mapRoot', scene)
  meshes.forEach(m => { if (!m.parent) m.parent = root })
  root.rotation.x = ROTX
  root.computeWorldMatrix(true)
  meshes.forEach(m => { m.computeWorldMatrix(true); m.checkCollisions = true; m.refreshBoundingInfo && m.refreshBoundingInfo(true) })

  let mn = new BABYLON.Vector3(1e9, 1e9, 1e9), mx = new BABYLON.Vector3(-1e9, -1e9, -1e9)
  meshes.forEach(m => { const b = m.getBoundingInfo().boundingBox; mn = BABYLON.Vector3.Minimize(mn, b.minimumWorld); mx = BABYLON.Vector3.Maximize(mx, b.maximumWorld) })
  console.log(`ROTX=${(process.env.ROTX || '0')}deg  bounds min(${mn.x.toFixed(1)},${mn.y.toFixed(1)},${mn.z.toFixed(1)}) max(${mx.x.toFixed(1)},${mx.y.toFixed(1)},${mx.z.toFixed(1)})`)

  function drop(px: number, pz: number, topY: number) {
    const p = BABYLON.MeshBuilder.CreateBox('p', { size: 1 }, scene)
    p.ellipsoid = new BABYLON.Vector3(0.5, 0.5, 0.5); p.checkCollisions = true
    p.position.set(px, topY, pz)
    let vy = 0, rest: number | null = null
    for (let t = 0; t < 600; t++) {
      vy -= 18 * 0.025; const oldY = p.position.y
      p.moveWithCollisions(new BABYLON.Vector3(0, vy * 0.025, 0))
      if (vy < 0 && (p.position.y - oldY) - vy * 0.025 > 0.001) { rest = p.position.y; break }
      if (p.position.y < mn.y - 5) break
    }
    p.dispose(); return rest
  }

  // grid probe over the footprint
  const topY = mx.y + 5, N = 7
  const floors: number[] = []
  const pts: {x:number,y:number,z:number}[] = []
  let landed = 0, total = 0
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    total++
    const x = mn.x + (mx.x - mn.x) * (i + 0.5) / N
    const z = mn.z + (mx.z - mn.z) * (j + 0.5) / N
    const y = drop(x, z, topY)
    if (y !== null) { landed++; floors.push(y); pts.push({x:+x.toFixed(1), y:+y.toFixed(1), z:+z.toFixed(1)}) }
  }
  // suggest spawns: prefer the lower floors (where you'd fight), spread out
  const spawns = pts.sort((a,b)=>a.y-b.y).filter((p,i)=>i%2===0).slice(0,8)
  console.log('  SPAWN CANDIDATES:', JSON.stringify(spawns.map(p=>({x:p.x,z:p.z,y:+(p.y+1.2).toFixed(1)}))))
  // histogram of floor heights (bucket by 3 units)
  const hist = new Map<number, number>()
  floors.forEach(y => { const b = Math.round(y / 3) * 3; hist.set(b, (hist.get(b) || 0) + 1) })
  const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1])
  console.log(`  landed ${landed}/${total} grid probes.  floor levels (y: count): ${sorted.map(([y, c]) => `${y}:${c}`).join('  ')}`)
  const biggest = sorted[0]
  if (biggest) console.log(`  -> dominant floor ~y=${biggest[0]} (${biggest[1]} hits). ${landed >= total * 0.6 ? 'LOOKS WALKABLE ✓' : 'sparse — probably wrong orientation ✗'}`)
  server.close(); process.exit(0)
})()
