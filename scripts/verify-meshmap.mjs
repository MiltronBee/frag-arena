// Feasibility probe: can the SERVER (node + NullEngine) load the artist OBJ and does
// moveWithCollisions collide against it? Also maps floor heights so we can pick scale
// + spawn heights. Loads via xhr2 (XMLHttpRequest polyfill) from a tiny http server.
//   node scripts/verify-meshmap.mjs
import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders'
import http from 'http'; import fs from 'fs'; import path from 'path'
import XHR from 'xhr2'
// XHR polyfill so Babylon's file loader works in node. Do NOT stub window/document:
// defining window flips babylonjs into browser mode and hides NullEngine (node-only).
global.XMLHttpRequest = XHR

const ROOT = path.resolve(process.env.HOME, 'unreal/public')
const PORT = 8098
const MAPDIR = '/assets/maps/DM-W-Grove/'
const MAPFILE = 'DM-W-Grove-2025.obj'

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200); fs.createReadStream(f).pipe(res)
})
await new Promise(r => server.listen(PORT, r))

const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
scene.collisionsEnabled = true

console.log('loading OBJ in node...')
let loaded
try {
  loaded = await BABYLON.SceneLoader.ImportMeshAsync('', `http://localhost:${PORT}${MAPDIR}`, MAPFILE, scene)
} catch (e) {
  console.log('LOAD FAILED:', String(e).slice(0, 300)); server.close(); process.exit(1)
}
const meshes = loaded.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
console.log(`loaded meshes: ${meshes.length}  total tris ~${meshes.reduce((a, m) => a + (m.getTotalIndices ? m.getTotalIndices() / 3 : 0), 0) | 0}`)

// bounds
let mn = new BABYLON.Vector3(1e9, 1e9, 1e9), mx = new BABYLON.Vector3(-1e9, -1e9, -1e9)
meshes.forEach(m => { m.computeWorldMatrix(true); const b = m.getBoundingInfo().boundingBox; mn = BABYLON.Vector3.Minimize(mn, b.minimumWorld); mx = BABYLON.Vector3.Maximize(mx, b.maximumWorld) })
console.log(`bounds min(${mn.x.toFixed(1)},${mn.y.toFixed(1)},${mn.z.toFixed(1)}) max(${mx.x.toFixed(1)},${mx.y.toFixed(1)},${mx.z.toFixed(1)})`)
const center = mn.add(mx).scale(0.5)

// enable collision on every map mesh
meshes.forEach(m => { m.checkCollisions = true; m.computeWorldMatrix(true) })

// Drop a 1-unit player (ellipsoid 0.5) from high above several XZ probe points and
// report where it settles — that's the floor height at that spot (or "fell through").
function dropProbe(px, pz, topY) {
  const p = BABYLON.MeshBuilder.CreateBox('p', { size: 1 }, scene)
  p.ellipsoid = new BABYLON.Vector3(0.5, 0.5, 0.5)
  p.checkCollisions = true
  p.position.set(px, topY, pz)
  let vy = 0, rest = null
  for (let t = 0; t < 400; t++) {
    vy -= 18 * 0.025
    const oldY = p.position.y
    p.moveWithCollisions(new BABYLON.Vector3(0, vy * 0.025, 0))
    if (vy < 0 && (p.position.y - oldY) - vy * 0.025 > 0.001) { rest = p.position.y; break } // downward move cut short = landed
    if (p.position.y < mn.y - 5) break // fell through
  }
  p.dispose()
  return rest
}
const topY = mx.y + 5
console.log('\nfloor probes (drop from y=' + topY.toFixed(1) + '):')
const probes = [[center.x, center.z, 'center'], [mn.x + 15, mn.z + 15, 'min-corner'], [mx.x - 15, mx.z - 15, 'max-corner'], [center.x, mn.z + 15, 'edge'], [center.x + 20, center.z, 'off-center']]
let floors = []
for (const [x, z, label] of probes) {
  const y = dropProbe(x, z, topY)
  console.log(`  ${label.padEnd(12)} (${x.toFixed(1)},${z.toFixed(1)}) -> ${y === null ? 'FELL THROUGH' : 'floor y=' + y.toFixed(2)}`)
  if (y !== null) floors.push(y)
}
if (floors.length) {
  const lo = Math.min(...floors), hi = Math.max(...floors)
  console.log(`\nSUMMARY: collision WORKS on server. floor y range [${lo.toFixed(2)}, ${hi.toFixed(2)}] across ${floors.length}/${probes.length} probes.`)
  console.log(`=> to put main floor at our GROUND_Y=0, offset the map by about y=${(-lo).toFixed(2)} (or scale first).`)
} else {
  console.log('\nWARN: no probe landed — either collision not working or scale/orientation wrong.')
}
server.close()
process.exit(0)
