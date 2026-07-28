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
const DOCS_URL = process.env.FRAGBENCH_DOCS || 'https://degentournament.fun/frag.md'
// PUBLIC-ENDPOINT LIMITS. The gateway is unauthenticated by design in v0 (the spec's
// Tier-1 "free division"), so the only thing standing between the arena and a for-loop
// is this: one entrant may hold at most MAX_PER_IP seats, and may not re-join faster
// than JOIN_COOLDOWN_MS. Neither protects the ARENA — GameInstance.agentSeatsFree()
// does that, and humans outrank agents there — these stop ONE developer from taking
// every agent seat and calling it a leaderboard.
const MAX_PER_IP = Math.max(1, parseInt(process.env.FRAGBENCH_MAX_PER_IP, 10) || 2)
const JOIN_COOLDOWN_MS = Math.max(0, parseInt(process.env.FRAGBENCH_JOIN_COOLDOWN_MS, 10) || 3000)

class AgentGateway {
	constructor(game) {
		this.game = game
		this.agents = new Map() // ws -> { handle, name, model, ip }
		this._lastJoinByIp = new Map() // ip -> ts (join rate limit; swept on close)
		this.wss = new WebSocketServer({ port: PORT, host: HOST })
		this.wss.on('connection', (ws, req) => this._onConnection(ws, req))
		this.wss.on('error', (e) => console.log('[fragbench] gateway error:', e.message))
		this._obsTimer = setInterval(() => this._broadcastObservations(), 1000 / OBS_HZ)
		console.log(`[fragbench] agent gateway listening on ws://${HOST}:${PORT}`)
	}

	// The arena's public census — also served as JSON at /fragbench so an entrant can
	// check for a free seat BEFORE opening a socket.
	status() {
		return {
			protocol: 'fragbench/0',
			docs: DOCS_URL,
			obsHz: OBS_HZ,
			maxAgents: this.game.maxAgents,
			agents: this.game.agentCount,
			seatsFree: this.game.agentSeatsFree(),
			humans: this.game._humanCount,
			capacity: this.game.capacity,
			maxPerIp: MAX_PER_IP,
			entrants: [...this.agents.values()].map(a => ({
				name: a.name,
				model: a.model,
				nid: a.handle.rawEntity.nid,
				kills: a.handle.rawEntity.kills | 0,
				deaths: a.handle.rawEntity.deaths | 0,
			})),
		}
	}

	_send(ws, obj) {
		if (ws.readyState !== ws.OPEN) return
		try { ws.send(JSON.stringify(obj)) } catch (e) {}
	}

	// Refuse with a REASON, always. A benchmark harness that gets a silent close can't
	// tell "the arena was full" from "my code is broken", and will report the latter.
	_refuse(ws, code, message) {
		this._send(ws, { type: 'error', code, message, docs: DOCS_URL, status: this.status() })
	}

	// Called by GameInstance when a human needs this agent's seat. The frame goes out
	// BEFORE the map entry is dropped, and the entry is dropped BEFORE the close, so
	// the close handler finds nothing to clean up and can't double-remove.
	evict(handle, reason) {
		for (const [ws, a] of this.agents) {
			if (a.handle !== handle) continue
			this._send(ws, { type: 'evicted', reason, message: 'a human took the seat — agents yield', docs: DOCS_URL })
			this.agents.delete(ws)
			try { ws.close(4003, reason) } catch (e) {}
			return
		}
	}

	_onConnection(ws, req) {
		// Behind nginx every socket looks like 127.0.0.1, so the real client only
		// survives in X-Real-IP (set in the proxy block). Fall back to the socket
		// address for direct/local connections.
		const ip = (req && (req.headers['x-real-ip'] || req.headers['x-forwarded-for'])) ||
			(req && req.socket && req.socket.remoteAddress) || 'unknown'
		ws._fbIp = String(ip).split(',')[0].trim()
		// Greet with the protocol + a live seat count: an agent that arrives with no
		// documentation still learns where the documentation is.
		this._send(ws, { type: 'hello', ...this.status() })
		ws.on('message', (buf) => {
			let msg
			try { msg = JSON.parse(buf.toString()) } catch { return }
			if (msg.type === 'status') {
				this._send(ws, { type: 'status', ...this.status() })
			} else if (msg.type === 'join' && !this.agents.has(ws)) {
				// strict-charset names (the locked spec's prompt-injection defense: entrant
				// strings reach rival strategist LLM contexts verbatim, so no free text)
				const name = (String(msg.name || 'AGENT').replace(/[^a-zA-Z0-9_-]/g, '') || 'AGENT').slice(0, 24)
				const model = (String(msg.model || '').replace(/[^a-zA-Z0-9._:/-]/g, '')).slice(0, 48) || 'unreported'
				const ip = ws._fbIp
				// one entrant, a bounded share of the seats
				let held = 0
				for (const a of this.agents.values()) if (a.ip === ip) held++
				if (held >= MAX_PER_IP) {
					this._refuse(ws, 'PER_IP_LIMIT', `one entrant may hold ${MAX_PER_IP} seats; you hold ${held}`)
					return
				}
				const last = this._lastJoinByIp.get(ip) || 0
				if (Date.now() - last < JOIN_COOLDOWN_MS) {
					this._refuse(ws, 'RATE_LIMIT', `wait ${JOIN_COOLDOWN_MS}ms between joins`)
					return
				}
				// THE ARENA'S ANSWER IS FINAL: null means no seat for silicon right now,
				// because humans are in them (or the agent cap is full). Not an error the
				// entrant can retry away — it's the priority rule working.
				const handle = this.game.addAgentBot(name)
				if (!handle) {
					this._refuse(ws, 'NO_SEAT',
						this.game.agentCount >= this.game.maxAgents
							? `agent cap reached (${this.game.maxAgents} of ${this.game.capacity} seats)`
							: 'the arena is full of humans — agents yield; retry shortly')
					return
				}
				this._lastJoinByIp.set(ip, Date.now())
				handle.controller.agentModel = model
				this.agents.set(ws, { handle, name, model, ip })
				this._send(ws, {
					type: 'joined', nid: handle.rawEntity.nid, name, model,
					teamId: handle.rawEntity.teamId, obsHz: OBS_HZ, docs: DOCS_URL,
				})
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
