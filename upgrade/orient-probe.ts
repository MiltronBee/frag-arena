// GATE A.3 — OBJ X-mirror orientation probe (the USE_LEGACY_BEHAVIOR survival check).
// Loads the map OBJ exactly like GameInstance._loadMapMesh via the NEW scoped node
// barrel and asserts the world AABB x-max lands on the LEGACY (non-mirrored) side.
// Legacy 4.0.3 orientation: x-max ~= +131.3. A mirrored load flips to x-min ~= -131.3.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
global.XMLHttpRequest = require('xhr2')
import * as BABYLON from '../common/babylon.node.js'
import { MAP_MESH } from '../common/mapMesh.js'
import fs from 'fs'

async function main() {
  const engine = new BABYLON.NullEngine()
  const scene = new BABYLON.Scene(engine)
  scene.collisionsEnabled = true

  // mirror _loadMapMesh EXACTLY
  BABYLON.OBJFileLoader.USE_LEGACY_BEHAVIOR = true
  const obj = fs.readFileSync('public' + MAP_MESH.dir + MAP_MESH.file, 'utf8').replace(/^mtllib.*$/gm, '')
  const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:' + obj, scene, null, '.obj')
  const root = new BABYLON.TransformNode('mapRoot', scene)
  res.meshes.forEach(m => { if (!m.parent) m.parent = root })
  root.rotation.x = MAP_MESH.rotationX || 0
  root.scaling.setAll(MAP_MESH.scale || 1)
  root.computeWorldMatrix(true)

  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity
  let n = 0
  res.meshes.forEach(m => {
    if (m.getTotalVertices && m.getTotalVertices() > 0) {
      m.computeWorldMatrix(true)
      if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
      const bb = m.getBoundingInfo().boundingBox
      xmin = Math.min(xmin, bb.minimumWorld.x); xmax = Math.max(xmax, bb.maximumWorld.x)
      zmin = Math.min(zmin, bb.minimumWorld.z); zmax = Math.max(zmax, bb.maximumWorld.z)
      n++
    }
  })
  console.log(`meshes=${n}  worldAABB x=[${xmin.toFixed(3)}, ${xmax.toFixed(3)}]  z=[${zmin.toFixed(3)}, ${zmax.toFixed(3)}]`)
  const legacyOK = xmax > 100 && Math.abs(xmax - 131.3) < 20
  const mirrored = xmin < -100 && Math.abs(xmin + 131.3) < 20 && !(xmax > 100)
  if (legacyOK) {
    console.log(`ORIENTATION: PASS (legacy, non-mirrored) — x-max=${xmax.toFixed(3)} ~ +131.3`)
    process.exit(0)
  } else {
    console.log(`ORIENTATION: FAIL — expected legacy x-max ~+131.3; got x=[${xmin.toFixed(3)},${xmax.toFixed(3)}] mirrored=${mirrored}`)
    process.exit(1)
  }
}
main().catch(e => { console.error('PROBE ERROR', e); process.exit(2) })
