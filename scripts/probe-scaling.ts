// How does the server tick scale with headcount?
//
// There is no player cap, so the honest question is not "is there a limit" but
// "where does the 25ms tick budget (40Hz) actually run out". Boots the real
// GameInstance and runs real ticks with a growing roster.
//
//   npx tsx scripts/probe-scaling.ts [mapId]
import GameInstance from '../server/GameInstance'
import nengiConfig from '../common/nengiConfig'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DT = 1 / nengiConfig.UPDATE_RATE
const BUDGET = 1000 / nengiConfig.UPDATE_RATE

const main = async () => {
const mapId = process.argv[2] || 'dm_hex2'
const gi = new GameInstance(mapId, null)
for (let i = 0; i < 300 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never ready')

// start from a clean roster regardless of BOT_FILL
while (gi.bots.length) gi.removeBot(gi.bots[gi.bots.length - 1])

// per-player replicated state, straight off the protocol (what each body costs
// every other client on the wire, before nengi's delta encoding)
const SZ = { Float32: 4, RotationFloat32: 4, UInt8: 1, Boolean: 1, UInt16: 2, String: 16 }
let full = 0, moving = 0
const proto = (require('../common/entity/PlayerCharacter').default).protocol
for (const [k, v] of Object.entries(proto) as any) {
  const t = (v && v.type) ? v.type : v
  const name = (t && t.name) || String(t)
  const b = SZ[name] || 4
  full += b
  if (/^(x|y|z|rotationX|rotationY|rotationZ|velX|velY|velZ)$/.test(k)) moving += b
}
console.log(`\nreplicated PlayerCharacter state: ${full}B full, ${moving}B for a MOVING body (pos+rot+vel)`)
console.log(`tick budget @${nengiConfig.UPDATE_RATE}Hz = ${BUDGET.toFixed(1)}ms\n`)
console.log(' bodies   ms/tick   worst    %budget   est. per-client down   est. server up')

const rows = []
for (const target of [4, 8, 12, 16, 24, 32]) {
  while (gi.bots.length < target) gi.addBot(gi.bots.length)
  // warm up (JIT + first-tick allocations) before timing
  for (let i = 0; i < 40; i++) gi.update(DT)
  const N = 200
  const t = []
  for (let i = 0; i < N; i++) {
    const a = process.hrtime.bigint()
    gi.update(DT)
    t.push(Number(process.hrtime.bigint() - a) / 1e6)
  }
  t.sort((x, y) => x - y)
  const mean = t.reduce((a, b) => a + b, 0) / t.length
  const p99 = t[Math.floor(t.length * 0.99)]
  // each client receives every OTHER body's moving state, 40x/s
  const down = (target - 1) * moving * nengiConfig.UPDATE_RATE
  const up = down * target
  rows.push({ target, mean, p99, down, up })
  console.log(` ${String(target).padStart(6)}   ${mean.toFixed(2).padStart(7)}  ${p99.toFixed(2).padStart(6)}   ` +
    `${((mean / BUDGET) * 100).toFixed(0).padStart(6)}%   ${(down / 1024).toFixed(0).padStart(14)} KB/s   ` +
    `${(up / 1024 / 1024 * 8).toFixed(2).padStart(9)} Mbit/s`)
}

const over = rows.filter(r => r.mean > BUDGET)
console.log('\n' + (over.length
  ? `TICK BUDGET EXCEEDED at ${over[0].target} bodies (${over[0].mean.toFixed(1)}ms > ${BUDGET.toFixed(1)}ms)`
  : `every roster tested stayed inside the ${BUDGET.toFixed(1)}ms budget (worst mean ${Math.max(...rows.map(r => r.mean)).toFixed(2)}ms at ${rows[rows.length - 1].target})`))
console.log('NOTE: bots pay for AI (LoS raycasts, A*) that humans do not, but humans pay')
console.log('      for network serialisation that bots do not — treat this as the physics/')
console.log('      hitscan/collision envelope, not a full human-load simulation.')
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
