// CPU profile of the real server tick at a full 4v4 roster.
//   npx tsx --cpu-prof --cpu-prof-dir=/tmp/prof scripts/profile-tick.ts
import GameInstance from '../server/GameInstance'
import nengiConfig from '../common/nengiConfig'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DT = 1 / nengiConfig.UPDATE_RATE

const main = async () => {
const gi = new GameInstance(process.argv[2] || 'dm_hex2', null)
for (let i = 0; i < 300 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never ready')
while (gi.bots.length < 8) gi.addBot(gi.bots.length)
while (gi.bots.length > 8) gi.removeBot(gi.bots[gi.bots.length - 1])
for (let i = 0; i < 200; i++) gi.update(DT)   // warm
const N = 4000
const t0 = process.hrtime.bigint()
for (let i = 0; i < N; i++) gi.update(DT)
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log(`@@ ${N} ticks in ${ms.toFixed(1)}ms -> ${(ms / N).toFixed(3)} ms/tick at ${gi.bots.length} bodies`)
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
