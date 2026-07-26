// FRAGBENCH gateway end-to-end check. Boots against a RUNNING server
// (FRAGBENCH=1) and drives the real protocol over a real socket: hello, join,
// observation cadence, the rate limit, the per-entrant cap, and the census.
import WebSocket from 'ws'

const WS = process.env.FB_WS || 'ws://127.0.0.1:8081'
const HTTP = process.env.FB_HTTP || 'http://127.0.0.1:8078/fragbench'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   ${detail}`}`)
	ok ? pass++ : fail++
}

// One entrant: connects, optionally joins, and records every frame it receives.
function entrant(name) {
	const ws = new WebSocket(WS)
	const frames = []
	const got = (type, ms = 3000) => new Promise((resolve) => {
		const hit = frames.find(f => f.type === type)
		if (hit) return resolve(hit)
		const t = setTimeout(() => resolve(null), ms)
		ws.on('message', function h(buf) {
			const m = JSON.parse(buf)
			if (m.type !== type) return
			clearTimeout(t); ws.off('message', h); resolve(m)
		})
	})
	ws.on('message', (buf) => frames.push(JSON.parse(buf)))
	const open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
	return {
		ws, frames, got, open,
		join: (model = 'test-model') => ws.send(JSON.stringify({ type: 'join', name, model })),
		close: () => ws.close(),
		count: (type) => frames.filter(f => f.type === type).length,
	}
}

const census = async () => (await fetch(HTTP)).json()

// ── 1. hello on connect, before any join ─────────────────────────────────────
const a = entrant('ALPHA')
await a.open
const hello = await a.got('hello')
check('hello frame on connect', !!hello, JSON.stringify(a.frames))
check('hello names the protocol', hello?.protocol === 'fragbench/0', hello?.protocol)
check('hello links the docs', /frag\.md$/.test(hello?.docs || ''), hello?.docs)
check('hello reports the agent cap', hello?.maxAgents === 4, `maxAgents=${hello?.maxAgents}`)
check('hello reports seats free', hello?.seatsFree === 4, `seatsFree=${hello?.seatsFree}`)

// ── 2. join seats a real entity ──────────────────────────────────────────────
a.join('claude-opus-5')
const joined = await a.got('joined')
check('join is accepted', !!joined, JSON.stringify(a.frames.slice(-2)))
check('joined carries a network id', Number.isInteger(joined?.nid), `nid=${joined?.nid}`)
check('joined carries a team', joined?.teamId === 0 || joined?.teamId === 1, `teamId=${joined?.teamId}`)
check('joined echoes the reported model', joined?.model === 'claude-opus-5', joined?.model)

// ── 3. observations arrive at ~1Hz with a full arena in them ─────────────────
const obs = await a.got('obs', 3000)
check('observation frame arrives', !!obs)
check('observation carries self state', typeof obs?.you?.hp === 'number', JSON.stringify(obs?.you))
check('observation sees the other combatants', (obs?.players?.length || 0) >= 5, `players=${obs?.players?.length}`)
check('other combatants carry distance', typeof obs?.players?.[0]?.dist === 'number', JSON.stringify(obs?.players?.[0]))
check('self is labelled as this agent', obs?.you?.label === 'agent:ALPHA', obs?.you?.label)
await sleep(2200)
check('observations repeat at ~1Hz', a.count('obs') >= 2, `${a.count('obs')} frames in ~2.2s`)

// ── 4. the re-join rate limit ────────────────────────────────────────────────
const b = entrant('BRAVO')
await b.open
b.join()
const rl = await b.got('error', 2000)
check('a fast re-join is rate limited', rl?.code === 'RATE_LIMIT', JSON.stringify(rl))
check('the refusal explains itself', typeof rl?.message === 'string' && rl.message.length > 0, rl?.message)
check('the refusal carries the live census', typeof rl?.status?.seatsFree === 'number', JSON.stringify(rl?.status))
b.close()

// ── 5. a second seat for the same entrant is allowed ─────────────────────────
await sleep(3300)
const c = entrant('CHARLIE')
await c.open
c.join()
check('a second seat is granted', !!(await c.got('joined', 2000)))

// ── 6. a third is not — one entrant cannot own the arena ─────────────────────
await sleep(3300)
const d = entrant('DELTA')
await d.open
d.join()
const capped = await d.got('error', 2000)
check('a third concurrent seat is refused', capped?.code === 'PER_IP_LIMIT', JSON.stringify(capped))
d.close()

// ── 7. the public census reflects reality ────────────────────────────────────
const cen = await census()
check('census endpoint is enabled', cen.enabled === true, JSON.stringify(cen).slice(0, 160))
check('census counts both seated agents', cen.agents === 2, `agents=${cen.agents}`)
check('census subtracts them from seats free', cen.seatsFree === 2, `seatsFree=${cen.seatsFree}`)
check('census lists the entrants by model', cen.entrants?.some(e => e.model === 'claude-opus-5'), JSON.stringify(cen.entrants))
check('census names the current map', typeof cen.map?.mapName === 'string', JSON.stringify(cen.map))

// ── 8. leaving frees the seat ────────────────────────────────────────────────
a.close(); c.close()
await sleep(1200)
const after = await census()
check('seats are released on disconnect', after.agents === 0, `agents=${after.agents}`)
check('seats free returns to the cap', after.seatsFree === 4, `seatsFree=${after.seatsFree}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
