import { PLAYER_NAMES, HUMAN_NAME_SENTINEL } from '../../common/playerNames'
import { MATCH_MODE, MATCH_WINNER } from '../../common/entity/MatchState'

// POST-MATCH OVERLAY — the 15 seconds between "RED WINS" and the map swap.
//
// WHY THIS EXISTS: the whole end-of-match presentation used to be a title and a
// two-number score, over a still-mounted combat HUD whose only live readouts were a
// countdown frozen at 0:00 and your own frags. A decided match told you nothing about
// how you had actually done, so there was no progress signal and nothing to read while
// you waited for the rotation.
//
// EVERYTHING HERE IS FREE ON THE WIRE. Not one byte was added to the protocol:
//   - kills / deaths / teamId / nameIndex already stream on PlayerCharacter, and the
//     nengi view AABB deliberately covers the WHOLE map (GameInstance.deriveViewBox),
//     so every client already holds every combatant's score. The ranking is a DOM
//     render over data in hand.
//   - HUMAN_NAME_SENTINEL (common/playerNames.js) already distinguishes humans from
//     bots: nameIndex === 30 means "human, real callsign arrives via PlayerName".
//     That is where the [AGENT] tag comes from — no isBot field needed.
//   - common/message/Killed already carries weaponIndex + isHeadshot and is broadcast
//     to everyone, so play-of-the-match, the headshot count and the nemesis line are
//     all derivable from a client-side log of a message we already receive.
//
// COST: one DOM build per match end (not per frame). update() touches the DOM only when
// a reveal stage changes, so the intermission costs a couple of integer compares per
// frame. No new render pass, no allocation in the steady state.

// Reveal beat sheet, ms after MATCH_END. Each stage adds one class to the root; CSS owns
// the actual transitions. Deliberately paced rather than dumped all at once: the score
// lands first, then how everyone did, then the flourish, then what's next.
const STAGE_AT = [0, 500, 1500, 3500, 6000, 10000]

// Play-of-the-match clustering: frags by the same attacker inside a rolling window count
// as one "play". 4s is long enough to hold a genuine multi-kill and short enough that a
// steady trickle of frags never merges into a fake highlight.
const CLUSTER_MS = 4000

export default class MatchEndOverlay {
	constructor(simulator) {
		this.sim = simulator
		this.root = document.getElementById('match-end')
		this._visible = false
		this._stage = -1
		this._shownAt = 0
		// cached element handles (the markup is static in index.html — query once)
		this._el = {}
		if (this.root) {
			const q = (id) => document.getElementById(id)
			this._el = {
				title: q('me-title'),
				score: q('me-score'),
				sub: q('me-sub'),
				rows: q('me-rows'),
				stats: q('me-stats'),
				nemesis: q('me-nemesis'),
				badges: q('me-badges'),
				session: q('me-session'),
				next: q('me-next'),
				clock: q('me-clock'),
			}
		}
	}

	// ---- match-long kill log ------------------------------------------------------
	// Fed from the Simulator's existing message::Killed handler. Bounded so a long
	// overtime can't grow it without limit; 512 frags is far past any real match.
	resetLog() {
		this._log = []
	}

	logKill(message, suicide) {
		if (!this._log) this._log = []
		if (this._log.length >= 512) return
		this._log.push({
			t: performance.now(),
			killer: message.killerNid,
			victim: message.victimNid,
			head: !!message.isHeadshot,
			suicide: !!suicide,
		})
	}

	// ---- name / identity resolution ----------------------------------------------
	// Bots carry a nameIndex into the shared PLAYER_NAMES table; humans carry the
	// sentinel and their real callsign arrives separately as a PlayerName message,
	// which the Simulator has already registered by nid.
	_nameOf(entity) {
		const idx = entity.nameIndex | 0
		if (idx === HUMAN_NAME_SENTINEL) {
			const real = this.sim._nameRegistry && this.sim._nameRegistry.get(entity.nid)
			return { name: real || 'PLAYER', isBot: false }
		}
		return { name: PLAYER_NAMES[idx] || 'PLAYER', isBot: true }
	}

	// Every combatant this client can see, ranked. Only player entities carry a numeric
	// `kills` (MatchState / Pickup / MegaHealth do not), which is the same discriminator
	// Simulator._ffaStanding() already relies on.
	_buildRows() {
		const rows = []
		const myNid = this.sim.mySmoothEntity ? this.sim.mySmoothEntity.nid : null
		const ents = this.sim.client && this.sim.client.entities
		if (ents && ents.forEach) {
			ents.forEach((e) => {
				if (!e || typeof e.kills !== 'number') return
				// SKIP THE LOCAL RAW ENTITY. The server replicates a raw+smooth PAIR for the
				// local player and BOTH land in client.entities (measured: nid 65507 smooth +
				// 65508 raw), so a bare "has a numeric kills" test lists you twice.
				// _updateHud's player count already excludes it with this same nid test;
				// _ffaStanding() only gets away without it because it takes a maximum.
				if (this.sim.myRawId != null && e.nid === this.sim.myRawId) return
				const id = this._nameOf(e)
				rows.push({
					nid: e.nid,
					name: id.name,
					isBot: id.isBot,
					teamId: e.teamId,
					kills: e.kills | 0,
					deaths: e.deaths | 0,
					isMe: myNid != null && e.nid === myNid,
				})
			})
		}
		// kills desc -> fewest deaths -> differential -> nid, so the order is total and
		// deterministic (two clients never disagree about who placed 4th).
		rows.sort((a, b) =>
			b.kills - a.kills
			|| a.deaths - b.deaths
			|| (b.kills - b.deaths) - (a.kills - a.deaths)
			|| a.nid - b.nid)
		let humanRank = 0
		rows.forEach((r, i) => {
			r.rank = i + 1
			if (!r.isBot) r.humanRank = ++humanRank
		})
		return rows
	}

	// ---- accolades ---------------------------------------------------------------
	// Scored over the broadcast Killed log. Scarce by construction: at most three badges
	// ship, and SOLO CARRIER can only go to someone on the LOSING side — the players most
	// at risk of leaving are the ones with something to be told.
	_accolades(rows, winner, ffa) {
		const log = this._log || []
		const nameByNid = new Map(rows.map(r => [r.nid, r]))
		const out = []

		// PLAY OF THE MATCH: best single cluster of frags by one attacker.
		let best = null
		const byKiller = new Map()
		for (const k of log) {
			if (k.suicide) continue
			if (!byKiller.has(k.killer)) byKiller.set(k.killer, [])
			byKiller.get(k.killer).push(k)
		}
		byKiller.forEach((kills, nid) => {
			let i = 0
			while (i < kills.length) {
				let j = i
				while (j + 1 < kills.length && kills[j + 1].t - kills[i].t <= CLUSTER_MS) j++
				const cluster = kills.slice(i, j + 1)
				if (cluster.length >= 2) {
					const span = cluster[cluster.length - 1].t - cluster[0].t
					const heads = cluster.filter(c => c.head).length
					// frags dominate; headshots and speed are the tiebreakers that make one
					// triple-kill read as better than another.
					const score = cluster.length * 100 + heads * 50
						+ Math.floor(200 * (1 - Math.min(1, span / CLUSTER_MS)))
					if (!best || score > best.score) {
						best = { score, nid, n: cluster.length, span, heads }
					}
				}
				i = j + 1
			}
		})
		if (best) {
			const who = nameByNid.get(best.nid)
			out.push({
				key: 'potg',
				label: 'PLAY OF THE MATCH',
				who: who ? who.name : 'PLAYER',
				agent: !!(who && who.isBot),
				detail: `${best.n} FRAGS IN ${(best.span / 1000).toFixed(1)}S${best.heads ? ` · ${best.heads} HS` : ''}`,
				mine: !!(who && who.isMe),
			})
		}

		// SHARPSHOOTER: most headshot frags, minimum three so it stays worth having.
		const heads = new Map()
		for (const k of log) {
			if (k.suicide || !k.head) continue
			heads.set(k.killer, (heads.get(k.killer) || 0) + 1)
		}
		let topHead = null
		heads.forEach((n, nid) => { if (!topHead || n > topHead.n) topHead = { nid, n } })
		if (topHead && topHead.n >= 3) {
			const who = nameByNid.get(topHead.nid)
			out.push({
				key: 'sharp',
				label: 'SHARPSHOOTER',
				who: who ? who.name : 'PLAYER',
				agent: !!(who && who.isBot),
				detail: `${topHead.n} HEADSHOT FRAGS`,
				mine: !!(who && who.isMe),
			})
		}

		// SOLO CARRIER: top scorer on the team that lost. Team modes only — in FFA there
		// is no losing side to carry.
		if (!ffa && (winner === MATCH_WINNER.TEAM0 || winner === MATCH_WINNER.TEAM1)) {
			const losing = winner === MATCH_WINNER.TEAM0 ? 1 : 0
			const top = rows.find(r => r.teamId === losing)
			if (top && top.kills > 0) {
				out.push({
					key: 'carrier',
					label: 'SOLO CARRIER',
					who: top.name,
					agent: top.isBot,
					detail: `${top.kills} FRAGS ON THE LOSING SIDE`,
					mine: top.isMe,
				})
			}
		}
		return out.slice(0, 3)
	}

	// Who killed the local player most. A person to beat next match is a better hook than
	// any number, and it costs one pass over a log we already have.
	_nemesis(rows) {
		const myNid = this.sim.mySmoothEntity ? this.sim.mySmoothEntity.nid : null
		if (myNid == null) return null
		const tally = new Map()
		let iKilledThem = new Map()
		for (const k of (this._log || [])) {
			if (k.suicide) continue
			if (k.victim === myNid) tally.set(k.killer, (tally.get(k.killer) || 0) + 1)
			if (k.killer === myNid) iKilledThem.set(k.victim, (iKilledThem.get(k.victim) || 0) + 1)
		}
		let worst = null
		tally.forEach((n, nid) => { if (nid !== myNid && (!worst || n > worst.n)) worst = { nid, n } })
		if (!worst) return null
		const who = rows.find(r => r.nid === worst.nid)
		return {
			name: who ? who.name : 'PLAYER',
			agent: !!(who && who.isBot),
			killedYou: worst.n,
			youKilled: iKilledThem.get(worst.nid) || 0,
		}
	}

	// Longest run of my own frags with no death in between, straight off the log.
	_bestStreak() {
		const myNid = this.sim.mySmoothEntity ? this.sim.mySmoothEntity.nid : null
		if (myNid == null) return 0
		let run = 0, best = 0
		for (const k of (this._log || [])) {
			if (k.victim === myNid) { run = 0; continue }
			if (k.killer === myNid && !k.suicide) { run++; if (run > best) best = run }
		}
		return best
	}

	// ---- session continuity ------------------------------------------------------
	// sessionStorage is the ONLY thing that survives the rotation's page reload, so the
	// running record is written here and read back by the swap interstitial. Versioned so
	// a stale schema from an older build can never throw on boot.
	static readSession() {
		try {
			const raw = sessionStorage.getItem('degen_session_v1')
			if (!raw) return null
			const s = JSON.parse(raw)
			return (s && s.v === 1) ? s : null
		} catch (e) { return null }
	}

	_writeSession(result, rows, nextInfo) {
		const me = rows.find(r => r.isMe)
		const prev = MatchEndOverlay.readSession() || { v: 1, m: 0, w: 0, l: 0, k: 0, d: 0, streak: 0 }
		const won = result === 'win'
		const s = {
			v: 1,
			m: (prev.m | 0) + 1,
			w: (prev.w | 0) + (won ? 1 : 0),
			l: (prev.l | 0) + (result === 'loss' ? 1 : 0),
			k: (prev.k | 0) + (me ? me.kills : 0),
			d: (prev.d | 0) + (me ? me.deaths : 0),
			// win streak: a loss or a draw both end it, so it never overstates a run
			streak: won ? (prev.streak | 0) + 1 : 0,
		}
		if (nextInfo && nextInfo.mapName) s.next = { mapName: nextInfo.mapName, modeName: nextInfo.modeName || '' }
		try { sessionStorage.setItem('degen_session_v1', JSON.stringify(s)) } catch (e) {}
		return s
	}

	// ---- show / hide -------------------------------------------------------------
	show({ ffa, winner, myTeam, s0, s1, mode }) {
		if (!this.root) return
		const rows = this._buildRows()
		const me = rows.find(r => r.isMe)

		// Outcome, from the same authority the banner uses: the server's winner in team
		// modes, my own placement in FFA (where `winner` is deliberately unused).
		let result, title
		if (ffa) {
			const top = rows.length ? rows[0].kills : 0
			const amTop = !!me && me.kills >= top
			result = amTop ? 'win' : 'loss'
			title = amTop ? 'VICTORY' : 'DEFEAT'
		} else if (winner === MATCH_WINNER.DRAW) {
			result = 'draw'; title = 'DRAW'
		} else {
			const won = (winner === MATCH_WINNER.TEAM0 && myTeam === 0)
				|| (winner === MATCH_WINNER.TEAM1 && myTeam === 1)
			// A spectator with no team gets the neutral team result, not a false DEFEAT.
			result = (myTeam === 0 || myTeam === 1) ? (won ? 'win' : 'loss') : 'draw'
			title = winner === MATCH_WINNER.TEAM0 ? 'RED WINS' : 'BLUE WINS'
		}

		const accolades = this._accolades(rows, winner, ffa)
		const nemesis = this._nemesis(rows)
		const streak = this._bestStreak()
		const nextInfo = this.sim._nextMapInfo || null
		const session = this._writeSession(result, rows, nextInfo)

		this.root.dataset.result = result
		this.root.dataset.mode = ffa ? 'ffa' : 'team'
		const E = this._el
		if (E.title) { E.title.textContent = title }
		if (E.score) E.score.textContent = ffa ? `${me ? me.kills : 0} FRAGS` : `${s0} — ${s1}`
		if (E.sub) {
			E.sub.textContent = ffa && me
				? `PLACED #${me.rank} OF ${rows.length}`
				: (me ? `#${me.rank} OF ${rows.length}` : 'SPECTATING')
		}

		// ranking table
		if (E.rows) {
			const frag = document.createDocumentFragment()
			for (const r of rows) {
				const li = document.createElement('div')
				li.className = 'me-row' + (r.isMe ? ' is-me' : '')
				if (r.teamId === 0 || r.teamId === 1) li.dataset.team = r.teamId === 0 ? 'red' : 'blue'
				// Placing behind bots is the point of this game, not something to bury —
				// so a human's human-only placement is shown alongside the overall rank.
				const humanTag = (!r.isBot && r.humanRank && r.rank !== r.humanRank)
					? `<span class="me-human">HUMAN #${r.humanRank}</span>` : ''
				li.innerHTML = `<span class="me-rank">${r.rank}</span>`
					+ `<span class="me-name">${r.name}`
					+ (r.isBot ? '<span class="me-agent">AGENT</span>' : '') + humanTag + '</span>'
					+ `<span class="me-k">${r.kills}</span>`
					+ `<span class="me-d">${r.deaths}</span>`
					+ `<span class="me-net">${r.kills - r.deaths > 0 ? '+' : ''}${r.kills - r.deaths}</span>`
				frag.appendChild(li)
			}
			E.rows.replaceChildren(frag)
		}

		// personal stats — every one of these is derived, none of it is new protocol
		if (E.stats) {
			const k = me ? me.kills : 0, d = me ? me.deaths : 0
			const kd = (k / Math.max(1, d)).toFixed(2)
			E.stats.replaceChildren()
			const add = (label, value) => {
				const cell = document.createElement('div')
				cell.className = 'me-stat'
				cell.innerHTML = `<span class="me-stat-v">${value}</span><span class="me-stat-l">${label}</span>`
				E.stats.appendChild(cell)
			}
			add('FRAGS', k)
			add('DEATHS', d)
			add('NET', `${k - d > 0 ? '+' : ''}${k - d}`)
			add('K/D', kd)
			add('BEST STREAK', streak)
		}

		if (E.nemesis) {
			if (nemesis) {
				E.nemesis.innerHTML = `<span class="me-nem-label">NEMESIS</span>`
					+ `<span class="me-nem-name">${nemesis.name}`
					+ (nemesis.agent ? '<span class="me-agent">AGENT</span>' : '') + '</span>'
					+ `<span class="me-nem-detail">KILLED YOU ${nemesis.killedYou}× · YOU GOT THEM ${nemesis.youKilled}×</span>`
				E.nemesis.hidden = false
			} else E.nemesis.hidden = true
		}

		if (E.badges) {
			E.badges.replaceChildren()
			for (const a of accolades) {
				const b = document.createElement('div')
				b.className = 'me-badge' + (a.mine ? ' is-mine' : '')
				b.dataset.kind = a.key
				b.innerHTML = `<span class="me-badge-label">${a.label}</span>`
					+ `<span class="me-badge-who">${a.who}`
					+ (a.agent ? '<span class="me-agent">AGENT</span>' : '') + '</span>'
					+ `<span class="me-badge-detail">${a.detail}</span>`
				E.badges.appendChild(b)
			}
			E.badges.hidden = accolades.length === 0
		}

		if (E.session) {
			const netK = (session.k | 0) - (session.d | 0)
			E.session.textContent = `SESSION ${session.w}W · ${session.l}L`
				+ `  ·  NET ${netK > 0 ? '+' : ''}${netK}`
				+ (session.streak > 1 ? `  ·  ${session.streak} WIN STREAK` : '')
		}

		if (E.next) {
			E.next.textContent = nextInfo && nextInfo.mapName
				? `NEXT ARENA — ${nextInfo.mapName}${nextInfo.modeName ? ` · ${nextInfo.modeName}` : ''}`
				: ''
			E.next.hidden = !(nextInfo && nextInfo.mapName)
		}

		this._visible = true
		this._stage = -1
		this._shownAt = performance.now()
		this.root.classList.add('is-visible')
		document.body.classList.add('match-ended')
	}

	hide() {
		if (!this.root || !this._visible) return
		this._visible = false
		this._stage = -1
		this.root.classList.remove('is-visible')
		for (let i = 0; i < STAGE_AT.length; i++) this.root.classList.remove(`stage-${i}`)
		if (this._el.clock) this._el.clock.textContent = ''
		document.body.classList.remove('match-ended')
	}

	// Per-frame while the intermission runs. Touches the DOM only when the reveal stage
	// advances or the whole displayed second changes.
	update() {
		if (!this._visible || !this.root) return
		const dt = performance.now() - this._shownAt
		let stage = 0
		while (stage + 1 < STAGE_AT.length && dt >= STAGE_AT[stage + 1]) stage++
		if (stage !== this._stage) {
			for (let i = this._stage + 1; i <= stage; i++) this.root.classList.add(`stage-${i}`)
			this._stage = stage
		}
		const E = this._el
		// The next-arena line waits on a /mapinfo fetch kicked off at MATCH_END, so it can
		// land after show() has already painted. Fill it in once, when it arrives.
		if (E.next && E.next.hidden && this.sim._nextMapInfo && this.sim._nextMapInfo.mapName) {
			const n = this.sim._nextMapInfo
			E.next.textContent = `NEXT ARENA — ${n.mapName}${n.modeName ? ` · ${n.modeName}` : ''}`
			E.next.hidden = false
		}
		// Honest countdown: the server publishes the real intermission remainder in
		// MatchState.timeRemainingMs during MATCH_END, so this is not a client guess.
		if (E.clock) {
			const ms = this.sim._matchState ? (this.sim._matchState.timeRemainingMs | 0) : 0
			const secs = Math.max(0, Math.ceil(ms / 1000))
			const text = secs > 0 ? `NEXT MATCH IN ${secs}S` : 'CHANGING ARENA…'
			if (E.clock.textContent !== text) E.clock.textContent = text
		}
	}
}
