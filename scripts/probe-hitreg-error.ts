// PROBE (read-only): two independent hit-registration error sources.
//   (A) respawn smooth-entity excursion under SUSTAINED player motion
//   (B) the rewind/interp mismatch: timeAgo = RTT + 100 vs interp delay of 100
import { MAX_SPEED } from '../common/applyCommand.js'

const DT = 1 / 40
const CAP = MAX_SPEED * 1.1
const BUDGET = CAP * DT
type P = { x: number, y: number, z: number }
const d3 = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

const followPath = (e: P, path: P[], mb: number) => {
  let budget = mb
  while (budget > 0 && path.length > 0) {
    const p = path[0]
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (budget >= dist) { budget -= dist; Object.assign(e, p); path.shift() }
    else { const r = budget / dist; budget = 0; e.x += dx * r; e.y += dy * r; e.z += dz * r; path.unshift(p) }
  }
}

const main = async () => {
  console.log('(A) RESPAWN EXCURSION with the player STILL PLAYING (raw keeps moving)')
  console.log(`    smooth cap ${CAP.toFixed(2)} m/s vs raw ground speed 7.60 / dodge 11.40 m/s\n`)
  const deathAt: P = { x: 19.257, y: 10.973, z: -22.499 }
  const spawnAt: P = { x: -35.974, y: 0, z: -8.538 }
  console.log(`    dm_hex2 death->respawn separation = ${d3(deathAt, spawnAt).toFixed(1)} m\n`)

  for (const [label, rawSpeed] of [['sprint 11.40 m/s (dodge-chained)', 11.4], ['run 7.60 m/s (GROUND_SPEED)', 7.6], ['skirmish ~4 m/s (strafe/stop)', 4.0]] as [string, number][]) {
    const smooth: P = { ...spawnAt }
    const q: P[] = [{ ...deathAt }]          // the one stale entry emitCommands pushed this tick
    const raw: P = { ...spawnAt }
    const marks: Record<string, number> = {}
    let recovered = -1
    for (let t = 0; t < 40 * 120; t++) {
      raw.x += rawSpeed * DT
      q.push({ ...raw })
      followPath(smooth, q, BUDGET)
      const lag = d3(smooth, raw)
      const s = (t + 1) * DT
      for (const m of [1, 2, 5, 10, 20, 30, 60]) if (Math.abs(s - m) < DT / 2) marks[`t=${m}s`] = lag
      if (lag >= 1.0) recovered = s
    }
    console.log(`  ${label}`)
    console.log(`    lag: ` + Object.entries(marks).map(([k, v]) => `${k} ${v.toFixed(1)}m`).join('  '))
    console.log(`    LAST moment lag exceeded 1 m (one hitbox width): ${recovered.toFixed(1)} s after respawn\n`)
  }

  console.log('(B) REWIND vs INTERP MISMATCH  (GameInstance.js:830 vs GameClient.js:8)')
  console.log('    client renders remotes at (server_now - oneway - 100ms); server rewinds RTT+100ms')
  console.log('    => the hitbox is placed an EXTRA oneway = RTT/2 into the past.')
  console.log('    hitbox half-width = 0.5 m (CreateBox size 1); head sphere r = 0.13 m\n')
  console.log('      RTT    extra rewind   miss @7.6 m/s   miss @11.4 m/s   miss @12.54 m/s (ghost glide)')
  for (const rtt of [20, 50, 80, 100, 150, 200, 250]) {
    const dtErr = rtt / 2 / 1000
    const f = (v: number) => (dtErr * v).toFixed(2).padStart(6) + ' m'
    console.log(`   ${String(rtt).padStart(4)} ms   ${String(rtt / 2).padStart(6)} ms      ${f(7.6)}          ${f(11.4)}           ${f(12.54)}`)
  }
  console.log('\n    (a lateral error > 0.5 m clears the box entirely -> the clip lands on nothing)')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
