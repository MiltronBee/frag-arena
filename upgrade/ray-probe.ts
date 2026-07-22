// Ray.intersectsMesh silent-break probe (server-side hitscan path).
// If '@babylonjs/core/Culling/ray' were missing from the node barrel,
// ray.intersectsMesh would return a no-hit / throw. This proves it works.
import * as BABYLON from '../common/babylon.node.js'

const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
const box = BABYLON.MeshBuilder.CreateBox('target', { size: 2 }, scene)
box.position.set(0, 0, 10)
box.computeWorldMatrix(true)
box.refreshBoundingInfo(true)
const ray = new BABYLON.Ray(new BABYLON.Vector3(0, 0, 0), new BABYLON.Vector3(0, 0, 1), 100)
const hit = ray.intersectsMesh(box)
console.log('intersectsMesh hit:', hit.hit, 'distance:', hit.distance)
if (hit.hit && Math.abs(hit.distance - 9) < 0.001) {
  console.log('RAY PROBE: PASS (hitscan intersection works; Culling/ray registered)')
  process.exit(0)
} else {
  console.log('RAY PROBE: FAIL — ray.intersectsMesh not functioning')
  process.exit(1)
}
