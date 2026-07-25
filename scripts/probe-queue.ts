// 4v4 capacity + spectator FIFO, against the REAL GameInstance.deployPlayer.
//
// Fakes only the socket: each "client" is the shape deployPlayer/disconnect actually
// touch, and instance.message is captured so we can assert what a waiting player is
// TOLD, not just what the server records.
//
//   npx tsx scripts/probe-queue.ts
import GameInstance from '../server/GameInstance'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
const gi = new GameInstance('dm_hex2', 'TDM')
for (let i = 0; i < 300 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never ready')

// capture per-client messages (QueueStatus / Identity) without a socket
const inbox = new Map()
const realMessage = gi.instance.message.bind(gi.instance)
gi.instance.message = (msg, client) => {
	if (!inbox.has(client)) inbox.set(client, [])
	inbox.get(client).push(msg)
	// Identity needs a real socket to serialise; QueueStatus we just record.
	if (msg && msg.constructor && msg.constructor.name === 'QueueStatus') return
	try { realMessage(msg, client) } catch (e) { /* no socket in this harness */ }
}

const cap = gi.capacity
console.log(`capacity = ${cap}  (bot fill target = ${gi._botFillTarget})`)
console.log(`bots at boot: ${gi.bots.length}\n`)

// the socket surface deployPlayer/Channel actually touch. Only these five members
// are exercised; everything else the real nengi Client carries is irrelevant here.
const mk = (n) => ({
	id: n, _session: 0, _lastDeployAt: 0, view: null,
	subscribe() {}, unsubscribe() {}, queueMessage() {}, _messages: [],
})
const clients = []
for (let i = 0; i < 12; i++) {
	const c = mk(i)
	clients.push(c)
	gi.instance.clients.add ? gi.instance.clients.add(c) : null
	gi.deployPlayer(c)
	const n = gi.countTeams()
	if (c._session === 1) console.log()
}

const deployed = clients.filter(c => c._session === 1)
const waiting = clients.filter(c => c._session === 0)
console.log(`asked to deploy: ${clients.length}`)
console.log(`  DEPLOYED : ${deployed.length}  (_humanCount=${gi._humanCount})`)
console.log(`  QUEUED   : ${waiting.length}  (queueLength=${gi.queueLength})`)
console.log(`  bots now : ${gi.bots.length}   total bodies = ${gi._humanCount + gi.bots.length}`)

const qOf = (c) => {
	const m = (inbox.get(c) || []).filter(x => x.constructor.name === 'QueueStatus')
	return m.length ? m[m.length - 1] : null
}
console.log('\nwhat each waiting client was told (latest QueueStatus):')
waiting.forEach(c => {
	const q = qOf(c)
	console.log(`  client#${c.id}  position=${q ? q.position : '(none)'} size=${q ? q.size : '-'} capacity=${q ? q.capacity : '-'}`)
})

// team split of the deployed 8
const t0 = deployed.filter(c => c.rawEntity && c.rawEntity.teamId === 0).length
const t1 = deployed.filter(c => c.rawEntity && c.rawEntity.teamId === 1).length
console.log(`\nteam split of the deployed humans: ${t0}v${t1}`)

// ---- a deployed player leaves: the front of the line must take the seat ----
const firstWaiting = waiting[0]
const victim = deployed[0]
console.log(`\nclient#${victim.id} disconnects...`)
gi.instance.emit('disconnect', victim); victim._gone = true

console.log(`  _humanCount=${gi._humanCount}  queueLength=${gi.queueLength}`)
console.log(`  client#${firstWaiting.id} (was #1 in line) session=${firstWaiting._session === 1 ? 'DEPLOYED' : 'still waiting'}`)
const promoted = qOf(firstWaiting)
console.log(`  its last QueueStatus position=${promoted ? promoted.position : '(none)'}  (0 = "you're in")`)
console.log('\n  remaining line after the promotion:')
clients.filter(c => c._session === 0 && !c._gone).forEach(c => {
	const q = qOf(c)
	console.log(`    client#${c.id}  position=${q ? q.position : '(none)'}`)
})

// ---- a WAITING player leaves: line must close up, nobody deployed ----
const stillWaiting = clients.filter(c => c._session === 0 && !c._gone)
const leaver = stillWaiting[0]
const hcBefore = gi._humanCount
console.log(`\nwaiting client#${leaver.id} disconnects (should NOT free a seat)...`)
gi.instance.emit('disconnect', leaver); leaver._gone = true
console.log(`  _humanCount ${hcBefore} -> ${gi._humanCount}   queueLength=${gi.queueLength}`)

const problems = []
if (deployed.length !== cap) problems.push(`expected exactly ${cap} deployed, got ${deployed.length}`)
if (waiting.length !== 12 - cap) problems.push(`expected ${12 - cap} queued, got ${waiting.length}`)
if (gi._humanCount + gi.bots.length > cap) problems.push(`total bodies ${gi._humanCount + gi.bots.length} exceeds capacity ${cap}`)
if (Math.abs(t0 - t1) > 1) problems.push(`teams unbalanced: ${t0}v${t1}`)
if (firstWaiting._session !== 1) problems.push('front of the queue was NOT promoted when a seat freed')
if (!promoted || promoted.position !== 0) problems.push('promoted client never got the position-0 exit signal')
if (gi._humanCount !== hcBefore) problems.push('a WAITING client disconnecting changed the deployed headcount')
const positions = clients.filter(c => c._session === 0 && !c._gone).map(c => { const q = qOf(c); return q ? q.position : -1 })
const expected = positions.map((_, i) => i + 1)
if (JSON.stringify(positions) !== JSON.stringify(expected)) problems.push(`queue positions not contiguous 1..n: got [${positions}]`)

console.log('\n' + (problems.length ? 'PROBLEMS:' : 'VERIFIED: caps at 4v4, overflow queues FIFO, seat frees -> front promoted, positions restated'))
problems.forEach(p => console.log('  ! ' + p))
process.exit(problems.length ? 1 : 0)
}
main().then(() => {}, e => { console.error('FAILED:', e); process.exit(1) })
