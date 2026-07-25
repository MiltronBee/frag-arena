// PROBE (read-only): drive the REAL GameInstance.respawnPlayer + the REAL followPath
// against a real raw/smooth PlayerCharacter pair, and observe what happens to
// client.positions. No production code is modified.
import GameInstance from '../server/GameInstance.js'
import followPath from '../server/followPath.js'
import PlayerCharacter from '../common/entity/PlayerCharacter.js'
import { MAX_SPEED } from '../common/applyCommand.js'

const DT = 1 / 40
const BUDGET = MAX_SPEED * 1.1 * DT

const main = async () => {
  const gi: any = new GameInstance('dm_hex2')
  await new Promise(r => setTimeout(r, 4000))   // let the map mesh load

  const deathAt = { x: 19.257, y: 10.973, z: -22.499 }
  const raw: any = new (PlayerCharacter as any)(deathAt.x, deathAt.y, deathAt.z)
  const smooth: any = new (PlayerCharacter as any)(deathAt.x, deathAt.y, deathAt.z)
  raw.isAlive = false; smooth.isAlive = false
  const client: any = {
    rawEntity: raw, smoothEntity: smooth, bot: false, _session: 2,
    // exactly what the MoveCommand handler pushed on this same tick (GameInstance.js:630)
    positions: [{ x: deathAt.x, y: deathAt.y, z: deathAt.z, rotation: 0 }]
  }
  gi.instance = { message: () => {}, messageAll: () => {}, clients: { forEach: () => {} } }

  console.log('BEFORE respawnPlayer: positions.length =', client.positions.length,
    ' smooth @', smooth.x.toFixed(2), smooth.y.toFixed(2), smooth.z.toFixed(2))
  gi.respawnPlayer(client)
  console.log('AFTER  respawnPlayer: positions.length =', client.positions.length,
    ' raw @', raw.x.toFixed(2), raw.y.toFixed(2), raw.z.toFixed(2),
    ' smooth @', smooth.x.toFixed(2), smooth.y.toFixed(2), smooth.z.toFixed(2))
  const stale = client.positions[0]
  console.log('stale queue head =', stale ? `(${stale.x.toFixed(2)},${stale.y.toFixed(2)},${stale.z.toFixed(2)})` : 'none',
    '  <- the DEATH position' )

  // now let the real followPath run with the player standing still at the spawn
  const spawn = { x: raw.x, y: raw.y, z: raw.z }
  let worst = 0, worstT = 0
  for (let t = 0; t < 40 * 30; t++) {
    client.positions.push({ x: spawn.x, y: spawn.y, z: spawn.z, rotation: 0 })
    followPath(smooth, client.positions, BUDGET)
    const lag = Math.hypot(smooth.x - spawn.x, smooth.y - spawn.y, smooth.z - spawn.z)
    if (lag > worst) { worst = lag; worstT = t }
  }
  console.log(`\nREAL followPath, player STANDING STILL at spawn for 30 s:`)
  console.log(`  worst smooth-vs-raw separation = ${worst.toFixed(2)} m at t=${(worstT * DT).toFixed(2)}s`)
  console.log(`  final separation after 30 s     = ${Math.hypot(smooth.x - spawn.x, smooth.y - spawn.y, smooth.z - spawn.z).toFixed(2)} m`)
  console.log(`  (the smooth entity — the ONLY thing remote clients render and the ONLY`)
  console.log(`   thing the historian holds — walked off to the death spot and back.)`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
