// PROBE (read-only, no production code touched): quantify how far the server's
// SMOOTH entity lags the RAW entity, under followPath semantics.
//
// Faithful re-implementation of server/followPath.js (including its path.unshift
// quirk) driven at the real server tick rate with the real MAX_SPEED / GRAVITY /
// TERMINAL_FALL, and the real per-case position streams.
import { MAX_SPEED } from '../common/applyCommand.js'

const TICK_HZ = 40
const DT = 1 / TICK_HZ
const GRAVITY = 18          // common/applyCommand.js:20
const TERMINAL_FALL = 30    // common/applyCommand.js:21
const BUDGET = MAX_SPEED * 1.1 * DT   // server/GameInstance.js:3264

type P = { x: number, y: number, z: number }
const d3 = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// ---- verbatim port of server/followPath.js (minus the babylon mesh call) ----
const followPath = (entity: P, path: P[], movementBudget: number) => {
  let budget = movementBudget
  while (budget > 0 && path.length > 0) {
    const position = path[0]
    const dx = position.x - entity.x, dy = position.y - entity.y, dz = position.z - entity.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (budget >= dist) {
      budget -= dist
      Object.assign(entity, position)
      path.shift()                     // shift(position) — arg ignored
    } else if (budget < dist) {
      const ratio = budget / dist
      budget = 0
      entity.x += dx * ratio; entity.y += dy * ratio; entity.z += dz * ratio
      path.unshift(position)           // BUG: head was never removed -> duplicates it
    }
  }
}

// Run a scenario. rawPath = the per-tick RAW positions the MoveCommand handler
// would push (server/GameInstance.js:630). preQueue = whatever is ALREADY in
// client.positions when the event fires. smoothStart = where smooth sits then.
const run = (name: string, smoothStart: P, preQueue: P[], rawPath: P[]) => {
  const smooth = { ...smoothStart }
  const queue: P[] = preQueue.map(p => ({ ...p }))
  let maxLag = 0, maxLagTick = 0, maxQueue = queue.length, catchUpTick = -1
  const total = rawPath.length + 400   // let it settle after the raw stream ends
  for (let t = 0; t < total; t++) {
    const raw = rawPath[Math.min(t, rawPath.length - 1)]
    if (t < rawPath.length) queue.push({ ...raw })
    followPath(smooth, queue, BUDGET)
    if (queue.length > maxQueue) maxQueue = queue.length
    const lag = d3(smooth, raw)
    if (lag > maxLag) { maxLag = lag; maxLagTick = t }
    if (catchUpTick < 0 && t >= rawPath.length - 1 && lag < 0.05) catchUpTick = t
  }
  const settle = catchUpTick < 0 ? NaN : (catchUpTick - (rawPath.length - 1)) * DT
  console.log(
    `${name.padEnd(46)} maxLag=${maxLag.toFixed(2).padStart(7)} m  @t=${(maxLagTick * DT).toFixed(2)}s` +
    `  settleAfterEvent=${settle.toFixed(2)}s  maxQueue=${String(maxQueue).padStart(4)}`
  )
  return { maxLag, settle, maxQueue }
}

// walking stream: raw strolls in +x at full ground speed
const walk = (from: P, ticks: number, speed = MAX_SPEED): P[] => {
  const out: P[] = []; const p = { ...from }
  for (let i = 0; i < ticks; i++) { p.x += speed * DT; out.push({ ...p }) }
  return out
}

// ballistic stream with the real integrator (velY -= G*dt, clamped at TERMINAL_FALL)
const ballistic = (from: P, vel: { x: number, y: number, z: number }, ticks: number, floorY: number): P[] => {
  const out: P[] = []; const p = { ...from }; const v = { ...vel }
  for (let i = 0; i < ticks; i++) {
    v.y -= GRAVITY * DT
    if (v.y < -TERMINAL_FALL) v.y = -TERMINAL_FALL
    p.x += v.x * DT; p.z += v.z * DT; p.y += v.y * DT
    if (p.y <= floorY) { p.y = floorY; v.y = 0; v.x = 0; v.z = 0 }
    out.push({ ...p })
  }
  return out
}

const main = async () => {
  console.log(`MAX_SPEED=${MAX_SPEED} m/s   smooth cap=1.1x = ${(MAX_SPEED * 1.1).toFixed(2)} m/s`)
  console.log(`tick ${TICK_HZ}Hz (dt ${DT}s)  ->  per-tick movementBudget = ${BUDGET.toFixed(4)} m\n`)

  console.log('--- BASELINE: normal ground movement ------------------------------------')
  run('walk 5s @ MAX_SPEED', { x: 0, y: 0, z: 0 }, [], walk({ x: 0, y: 0, z: 0 }, 200))

  console.log('\n--- (a) TELEPORT (dm_baroque TeleBottm -> TopDeck, 42.0 m) ---------------')
  const teleFrom = { x: -31.686, y: 0.764, z: 34.128 }
  const teleTo = { x: 2.439, y: 12.937, z: 12.249 }
  console.log(`    portal distance = ${d3(teleFrom, teleTo).toFixed(2)} m`)
  // AS SHIPPED: applyTeleport snaps smooth AND clears positions (GameInstance.js:2124)
  run('teleport, AS SHIPPED (queue cleared + snap)', teleTo, [], walk(teleTo, 200))
  // COUNTERFACTUAL: what it would cost if the clear were missing
  run('teleport, COUNTERFACTUAL (no queue clear)', teleTo, [teleFrom], walk(teleTo, 200))

  console.log('\n--- (b) JUMP PAD (dm_somnus kicker: vy=20, hfrac=0.4) --------------------')
  const padAt = { x: 0, y: 20.576, z: 0 }
  run('jump pad launch vy=20 (vertical, apex ~11.1m)',
    padAt, [], ballistic(padAt, { x: 0, y: 20, z: 0 }, 160, padAt.y))
  run('jump pad launch vy=20 + h=8 (yawed kicker)',
    padAt, [], ballistic(padAt, { x: 8, y: 20, z: 0 }, 160, padAt.y))

  console.log('\n--- (c) LONG FALL (dm_hex2: top ledge y=16.5 -> shaft floor y=-2.1) -----')
  const fallFrom = { x: 17.069, y: 16.5, z: -18.288 }
  run('fall 18.6 m (walk off, no jump)', fallFrom, [], ballistic(fallFrom, { x: 0, y: 0, z: 0 }, 200, -2.133))
  run('fall 36.5 m to killY=-20 (void death)', fallFrom, [], ballistic(fallFrom, { x: 0, y: 0, z: 0 }, 200, -20))

  console.log('\n--- (d) LIFT (dm_hex2 MOVERS, smoothstep ease) ---------------------------')
  const lift = (rest: number, top: number, moveTime: number, label: string) => {
    const ease = (t: number) => t * t * (3 - 2 * t)   // server/movers.js:44
    const ticks = Math.ceil(moveTime / DT)
    const out: P[] = []
    for (let i = 1; i <= ticks; i++) {
      const t = Math.min(1, i * DT / moveTime)
      out.push({ x: 17.069, y: rest + (top - rest) * ease(t), z: -18.288 })
    }
    for (let i = 0; i < 80; i++) out.push({ ...out[out.length - 1] })
    const peak = 1.5 * (top - rest) / moveTime
    console.log(`    ${label}: travel ${(top - rest).toFixed(2)} m in ${moveTime}s, peak speed ${peak.toFixed(2)} m/s (cap ${(MAX_SPEED * 1.1).toFixed(2)})`)
    return { start: { x: 17.069, y: rest, z: -18.288 }, path: out }
  }
  const l1 = lift(-2.133, 7.621, 1.75, 'lift 1'); run('lift 1 ride', l1.start, [], l1.path)
  const l2 = lift(3.048, 7.925, 1.0, 'lift 2'); run('lift 2 ride', l2.start, [], l2.path)

  console.log('\n--- (e) RESPAWN (GameInstance.respawnPlayer — NO positions clear) --------')
  // Died at the far side of dm_hex2, respawns across the map. The queue still holds
  // the pre-death raw positions, so followPath drags smooth BACK to the death spot.
  const deathAt = { x: 19.257, y: 10.973, z: -22.499 }   // top-level spawn/ledge
  const respawnAt = { x: -35.974, y: 0, z: -8.538 }      // opposite-corner spawn
  console.log(`    death->respawn distance = ${d3(deathAt, respawnAt).toFixed(2)} m`)
  run('respawn, queue EMPTY at death (best case)', respawnAt, [], walk(respawnAt, 200))
  run('respawn, 1 stale entry (typical: died walking)', respawnAt, [deathAt], walk(respawnAt, 200))
  // Died mid-fall: the fall outran the cap, so the queue is DEEP at the moment of death.
  const fatalFall = ballistic({ x: 19.257, y: 10.973, z: -22.499 }, { x: 0, y: 0, z: 0 }, 200, -20)
  {
    const smooth = { ...deathAt }; const q: P[] = []
    let died = -1
    for (let t = 0; t < fatalFall.length; t++) {
      q.push({ ...fatalFall[t] }); followPath(smooth, q, BUDGET)
      if (fatalFall[t].y <= -20 + 1e-6) { died = t; break }
    }
    console.log(`    fell to killY in ${((died + 1) * DT).toFixed(2)}s; queue depth at death = ${q.length} entries`)
    run('respawn after a VOID DEATH (deep stale queue)', respawnAt, q, walk(respawnAt, 400))
  }

  console.log('\n--- (f) followPath unshift duplication: grow or leak? --------------------')
  {
    const smooth = { x: 0, y: 0, z: 0 }
    const q: P[] = []
    const stream = ballistic({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, 120, 0)
    let peak = 0
    for (let t = 0; t < 120; t++) { q.push({ ...stream[t] }); followPath(smooth, q, BUDGET); peak = Math.max(peak, q.length) }
    const atStop = q.length
    let flushTick = -1
    for (let t = 0; t < 600; t++) { followPath(smooth, q, BUDGET); if (q.length === 0 && flushTick < 0) flushTick = t }
    console.log(`    peak queue during a 100 m fall = ${peak} entries (raw stream was 120 pushes)`)
    console.log(`    queue at end of fall = ${atStop}; fully drained after ${flushTick} further ticks (${(flushTick * DT).toFixed(2)}s) -> final length ${q.length}`)
    console.log(`    verdict: ${q.length === 0 ? 'SELF-HEALS (duplicates flush at zero budget cost once smooth reaches the head)' : 'LEAKS'}`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
