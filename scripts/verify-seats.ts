// FRAGBENCH seat-priority regression. Exercises _rebalanceBots / agentSeatsFree /
// removeAgentBot against a minimal stand-in instance — the real GameInstance ctor
// boots a Babylon NullEngine and a live map, none of which this rule touches.
//
// The rule under test: HUMANS ALWAYS WIN THE SEAT. Fill bots yield first, agents
// yield second (newest first), and a human never waits behind silicon.
import GameInstance from '../server/GameInstance'

let pass = 0, fail = 0
const check = (name: string, got: any, want: any) => {
	const ok = JSON.stringify(got) === JSON.stringify(want)
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
	ok ? pass++ : fail++
}

// A stand-in with only the state the seat rule reads/writes.
function makeGame(humans: number, fill: number, agents: number, target = 8) {
	const g: any = Object.create(GameInstance.prototype)
	g._humanCount = humans
	g._botFillTarget = target
	g._rebalancing = false
	g.agentGateway = null
	g.evicted = []
	g.bots = []
	let nid = 100
	for (let i = 0; i < fill; i++) {
		g.bots.push({ bot: true, agent: false, rawEntity: { nid: nid++, teamId: i % 2, isAlive: true, kills: 0 } })
	}
	for (let i = 0; i < agents; i++) {
		g.bots.push({
			bot: true, agent: true, order: i,
			rawEntity: { nid: nid++, teamId: i % 2, isAlive: true, kills: 0 },
			controller: { agentLabel: `AGENT${i}` },
		})
	}
	// stubs for the engine calls the rule makes
	g.addBot = (i: number) => g.bots.push({ bot: true, agent: false, rawEntity: { nid: nid++, teamId: i % 2, isAlive: true, kills: 0 } })
	g.removeBot = (h: any) => { const i = g.bots.indexOf(h); if (i !== -1) g.bots.splice(i, 1) }
	g.countTeams = () => {
		const n = [0, 0]
		g.bots.forEach((b: any) => n[b.rawEntity.teamId]++)
		return n
	}
	g.instance = { removeEntity: () => {} }
	return g
}

const counts = (g: any) => ({
	fill: g.bots.filter((b: any) => !b.agent).length,
	agents: g.bots.filter((b: any) => b.agent).length,
	total: g._humanCount + g.bots.length,
})

// ── 1. empty arena: bots fill every seat, agents may take up to their cap ──────
{
	const g = makeGame(0, 8, 0)
	check('empty arena is 8 fill bots', counts(g), { fill: 8, agents: 0, total: 8 })
	check('4 agent seats free when arena is empty of humans', g.agentSeatsFree(), 4)
}

// ── 2. an agent joining retires a fill bot — the arena does NOT grow ──────────
{
	const g = makeGame(0, 8, 0)
	g.bots.push({ bot: true, agent: true, rawEntity: { nid: 900, teamId: 0, isAlive: true, kills: 0 }, controller: { agentLabel: 'A0' } })
	g._rebalanceBots()
	check('agent joins -> fill bot retires, roster stays 8', counts(g), { fill: 7, agents: 1, total: 8 })
}

// ── 3. the agent cap holds even in an empty arena ─────────────────────────────
{
	const g = makeGame(0, 4, 4)
	g._rebalanceBots()
	check('4 agents seated -> no seats left for a 5th', g.agentSeatsFree(), 0)
	check('roster still 8 with 4 agents', counts(g), { fill: 4, agents: 4, total: 8 })
}

// ── 4. THE RULE: humans arrive, fill bots go first, then agents (newest first) ─
{
	const g = makeGame(0, 4, 4)
	g._rebalanceBots()
	g._humanCount = 6      // six humans deploy into a 4-agent arena
	g._rebalanceBots()
	const c = counts(g)
	check('6 humans + 4 agents -> fill bots all gone, 2 agents evicted', c, { fill: 0, agents: 2, total: 8 })
	const survivors = g.bots.filter((b: any) => b.agent).map((b: any) => b.controller.agentLabel)
	check('eviction takes the NEWEST agents, oldest keep their seats', survivors, ['AGENT0', 'AGENT1'])
}

// ── 5. a full house of humans leaves no seat for silicon at all ───────────────
{
	const g = makeGame(0, 4, 4)
	g._rebalanceBots()
	g._humanCount = 8
	g._rebalanceBots()
	check('8 humans -> every bot and agent yields', counts(g), { fill: 0, agents: 0, total: 8 })
	check('no agent seats offered while humans hold the arena', g.agentSeatsFree(), 0)
}

// ── 6. humans leave -> fill bots come back, seats reopen for agents ───────────
{
	const g = makeGame(8, 0, 0)
	g._humanCount = 1
	g._rebalanceBots()
	check('humans leave -> fill bots restore the 8-body arena', counts(g), { fill: 7, agents: 0, total: 8 })
	check('agent seats reopen', g.agentSeatsFree(), 4)
}

// ── 7. an agent leaving hands the seat back to a fill bot ─────────────────────
{
	const g = makeGame(0, 7, 1)
	const agent = g.bots.find((b: any) => b.agent)
	g.removeAgentBot(agent)
	check('agent leaves -> fill bot backfills, roster stays 8', counts(g), { fill: 8, agents: 0, total: 8 })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
