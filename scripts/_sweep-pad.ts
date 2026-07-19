// Sweep candidate jump-pad launches against the REAL tower collision to find the
// snappiest arc that reliably deposits a player ON the west tower deck. Symmetric,
// so the east pad is the mirror. Run: npx tsx scripts/_sweep-pad.ts
import * as BABYLON from 'babylonjs'
import applyCommand from '../common/applyCommand'
import { OBSTACLE_SPECS, obstacleY } from '../common/arenaConfig'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import nengiConfig from '../common/nengiConfig'

const DT = 1 / nengiConfig.UPDATE_RATE
const R = 0.5
const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
scene.collisionsEnabled = true

// Build ONLY the static world minus the old pads (style 4) — we test hypothetical
// launches, so the pad box shouldn't exist where we're relocating it.
for (const s of OBSTACLE_SPECS) {
  if (s.style === 4) continue
  const m = BABYLON.MeshBuilder.CreateBox('o', { size: 1 })
  m.position.set(s.x, s.y === undefined ? obstacleY(s.height) : s.y, s.z)
  m.scaling.set(s.width, s.height, s.depth)
  m.checkCollisions = true
  m.computeWorldMatrix(true)
}
const tower = OBSTACLE_SPECS.filter(s => s.style === 3).find(s => s.x < 0) // west
const front = tower.x + tower.width / 2 // -42
const deckStand = obstacleY(tower.height) + tower.height / 2 + R // 8.0
const xMin = tower.x - tower.width / 2, xMax = tower.x + tower.width / 2

// Launch a player from (startX, y0=1) with velX (toward -x) + velY, optional
// air-control toward tower. Return landing + apex + margin from deck edges.
function fly(startX, velX, velY, air) {
  // include the pad box the player launches FROM — it eats a little of the launch
  // on tick 0 (moveWithCollisions vs the surface you're resting on), so omitting it
  // over-estimates apex. Matching reality here keeps the sweep honest vs verify-map.
  const pad = BABYLON.MeshBuilder.CreateBox('pad', { size: 1 })
  pad.position.set(startX, obstacleY(1), 0)
  pad.scaling.set(4, 1, 4)
  pad.checkCollisions = true
  pad.computeWorldMatrix(true)
  const p = new PlayerCharacter()
  p.x = startX; p.y = 1.0; p.z = 0
  p.velX = -Math.abs(velX); p.velY = velY; p.velZ = 0
  p.grounded = false
  const command = {
    delta: DT, camRayX: -1, camRayY: 0, camRayZ: 0,
    forwards: air, backwards: false, left: false, right: false,
    jump: false, dodge: 0, weaponIndex: 0, fireInput: false, reload: false, aimInput: false
  }
  let apex = p.y, res = { onDeck: false, x: p.x, y: p.y, z: p.z, apex, edge: -99 }
  for (let t = 0; t < 160; t++) {
    applyCommand(p, command)
    apex = Math.max(apex, p.y)
    if (t > 1 && p.grounded) {
      const onDeck = Math.abs(p.y - deckStand) < 0.35 && p.x >= xMin && p.x <= xMax && Math.abs(p.z) < 4
      const edge = Math.min(p.x - xMin, xMax - p.x) // how far from nearest deck edge
      res = { onDeck, x: p.x, y: p.y, z: p.z, apex, edge }
      break
    }
    res = { onDeck: false, x: p.x, y: p.y, z: p.z, apex, edge: -99 }
  }
  p.mesh.dispose() // CRITICAL: else meshes accumulate as colliders + O(n^2) slowdown
  pad.dispose()
  return res
}

const winners = []
for (let startX = -44; startX <= -30; startX += 1) {
  for (let velX = 3; velX <= 10; velX += 0.5) {
    for (let velY = 16; velY <= 28; velY += 0.5) {
      const ball = fly(startX, velX, velY, false)
      const airc = fly(startX, velX, velY, true)
      // require BOTH ballistic and air-control to land safely on deck with >=2m edge
      // margin AND >=0.9m vertical clearance over the deck top (so holding toward the
      // tower can't catch the front-top edge — the real failure mode)
      if (ball.onDeck && airc.onDeck && ball.edge >= 2 && airc.edge >= 2 &&
          ball.apex >= deckStand + 0.9 && airc.apex >= deckStand + 0.9) {
        winners.push({ startX, velX, velY, apex: ball.apex, ballX: ball.x, airX: airc.x, edge: Math.min(ball.edge, airc.edge) })
      }
    }
  }
}

// prefer: lowest apex (snappiest), then most centered landing, then most edge margin
winners.sort((a, b) => a.apex - b.apex || Math.abs(a.ballX - tower.x) - Math.abs(b.ballX - tower.x))
console.log(`tower west: front face x=${front}, deck footprint x[${xMin},${xMax}], stand y=${deckStand}`)
console.log(`candidates that land on deck (ballistic AND air-control, >=1.5m edge margin): ${winners.length}`)
for (const w of winners.slice(0, 12)) {
  console.log(`  padX=${w.startX}  velX=${-w.velX}  velY=${w.velY}  apex=${w.apex.toFixed(2)}  ballistic lands x=${w.ballX.toFixed(1)}  air x=${w.airX.toFixed(1)}  edgeMargin=${w.edge.toFixed(1)}`)
}
if (winners.length) {
  const w = winners[0]
  console.log(`\nRECOMMEND: pad at x=${w.startX} (mirror +${-w.startX}), launchX=${-w.velX} (mirror +${w.velX}), launchY=${w.velY}`)
}
