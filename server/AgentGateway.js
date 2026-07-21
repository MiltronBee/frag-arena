// FRAGBENCH v0 — the sanctioned-agent endpoint from the locked roundtable spec
// (_work/modes/roundtable-transcript-v3.md §4/§5), thinned to the buildable core:
// a WebSocket server where an external strategist process drives a REAL PlayerCharacter
// on the same authority path as every bot/human. The server stays fully authoritative —
// an agent can only submit intent, never state.
//
// Protocol (JSON text frames):
//   agent -> server  {type:'join', name:'<entrant label>', model:'<model id>'}
//                    model is the entrant's self-reported model identifier (e.g.
//                    'claude-opus-4-8', 'gemini-3.5-flash') — REQUIRED for rated play:
//                    the ladder ranks BY MODEL, so an unreported model can't rank.
//   server -> agent  {type:'joined', nid, name, model}
//   server -> agent  {type:'obs', ...}   at OBS_HZ (1Hz — the spec's Tier-1 decision cap;
//                                        the strategist can't decide faster than it can see)
//   agent -> server  {type:'intent', targetNid, holdFire}
//   socket close     -> the agent's entity is removed from the match
//
// v0 scope notes (all spec'd in the transcript, deliberately deferred):
//   - no auth/tiers/stakes — binds 127.0.0.1 unless FRAGBENCH_HOST says otherwise
//   - no semantic-noise mutation of the observation (Goodhart defense, §5)
//   - observations are full-knowledge (no LoS fog) — v0 benchmarks target PRIORITY,
//     not scouting; fog belongs with the noise engine when divisions ship
import { WebSocketServer } from 'ws'

const OBS_HZ = 1
const PORT = parseInt(process.env.FRAGBENCH_PORT || '8081', 10)
const HOST = process.env.FRAGBENCH_HOST || '127.0.0.1'

class AgentGateway {
	constructor(game) {
		this.game = game
		this.agents = new Map() // ws -> { handle, name }
		this.wss = new WebSocketServer({ port: PORT, host: HOST })
		this.wss.on('connection', (ws) => this._onConnection(ws))
		this.wss.on('error', (e) => console.log('[fragbench] gateway error:', e.message))
		this._obsTimer = setInterval(() => this._broadcastObservations(), 1000 / OBS_HZ)
		console.log(`[fragbench] agent gateway listening on ws://${HOST}:${PORT}`)
	}

	_onConnection(ws) {
		ws.on('message', (buf) => {
			let msg
			try { msg = JSON.parse(buf.toString()) } catch { return }
			if (msg.type === 'join' && !this.agents.has(ws)) {
				// strict-charset names (the locked spec's prompt-injection defense: entrant
				// strings reach rival strategist LLM contexts verbatim, so no free text)
				const name = (String(msg.name || 'AGENT').replace(/[^a-zA-Z0-9_-]/g, '') || 'AGENT').slice(0, 24)
				const model = (String(msg.model || '').replace(/[^a-zA-Z0-9._:/-]/g, '')).slice(0, 48) || 'unreported'
				const handle = this.game.addAgentBot(name)
				handle.controller.agentModel = model
				this.agents.set(ws, { handle, name, model })
				ws.send(JSON.stringify({ type: 'joined', nid: handle.rawEntity.nid, name, model }))
			} else if (msg.type === 'intent') {
				const a = this.agents.get(ws)
				if (!a) return
				const it = a.handle.controller.intent
				it.targetNid = Number.isInteger(msg.targetNid) ? msg.targetNid : null
				it.holdFire = !!msg.holdFire
			}
		})
		ws.on('close', () => {
			const a = this.agents.get(ws)
			if (a) { this.game.removeAgentBot(a.handle); this.agents.delete(ws) }
		})
		ws.on('error', () => {}) // close handler does the cleanup
	}

	// One observation frame per connected agent: self + every combatant + score state.
	// Combatants include kills/deaths so a strategist can play the leader or the weak.
	_broadcastObservations() {
		if (this.agents.size === 0) return
		const everyone = []
		const collect = (e, label, model) => {
			if (!e) return
			everyone.push({
				nid: e.nid, label, model: model || undefined,
				x: +e.x.toFixed(1), y: +e.y.toFixed(1), z: +e.z.toFixed(1),
				hp: e.hitpoints, armor: e.armor | 0, alive: e.isAlive !== false,
				kills: e.kills | 0, deaths: e.deaths | 0, teamId: e.teamId | 0,
				weapon: e.currentWeaponIndex,
			})
		}
		this.game.instance.clients.forEach(c => collect(c.rawEntity, 'human'))
		this.game.bots.forEach(b => collect(
			b.rawEntity,
			b.controller && b.controller.agentLabel ? 'agent:' + b.controller.agentLabel : 'bot',
			b.controller && b.controller.agentModel))
		for (const [ws, a] of this.agents) {
			if (ws.readyState !== ws.OPEN) continue
			const meNid = a.handle.rawEntity.nid
			const me = everyone.find(p => p.nid === meNid)
			if (!me) continue
			const others = everyone
				.filter(p => p.nid !== meNid)
				.map(p => ({ ...p, dist: +Math.hypot(p.x - me.x, p.z - me.z).toFixed(1) }))
			ws.send(JSON.stringify({ type: 'obs', t: Date.now(), you: me, players: others }))
		}
	}

	close() {
		clearInterval(this._obsTimer)
		for (const [, a] of this.agents) this.game.removeAgentBot(a.handle)
		this.agents.clear()
		this.wss.close()
	}
}

export default AgentGateway
