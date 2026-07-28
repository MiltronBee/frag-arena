import { CODEX_CATEGORIES, CODEX_ENTRIES, codexEntry, codexNarration } from '../config/codex'
import { ARMORY_ITEMS, armoryArt, tensorItem, magicEdenItem } from '../config/armory'
import { FINISHES } from '../../common/entitlements.js'

// FULL SCREENS, not modals.
//
// Everything used to be a .info-modal floating over the same menu — whitepaper, loadout,
// issuance, roadmap, wallet — which made the whole product read as one big menu with
// panels stacked on it. A loadout is a place you go, not a dialog you dismiss.
//
// A screen differs from a modal in three ways that matter:
//   - it REPLACES the menu rather than covering it, so there is one surface at a time
//   - it is ROUTED (`#/character`), so it can be linked, bookmarked, and backed out of
//     with the browser's own back button — which on mobile is the button people actually use
//   - it owns its own lifecycle: entering builds what it needs, leaving tears it down
//
// The modals that remain (how-to, settings, wallet) stay modals on purpose: they are
// interruptions you return from, not destinations.
export default class MenuScreens {
	constructor(sim, menu) {
		this._sim = sim || null
		this._menu = menu || null
		this._current = null
		this._narrator = null
		this._codexId = null

		this._root = document.getElementById('menu-screens')
		if (!this._root) return

		this._screens = new Map()
		for (const el of this._root.querySelectorAll('[data-screen]')) {
			this._screens.set(el.getAttribute('data-screen'), el)
		}

		for (const btn of this._root.querySelectorAll('[data-screen-back]')) {
			btn.addEventListener('click', () => this.leave())
		}

		// Escape leaves the screen. Registered in CAPTURE so it runs before the modal
		// Escape handler in MenuControls — otherwise the two fight over one key press and
		// which one wins depends on listener registration order.
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape' || !this._current) return
			this.leave()
			e.stopPropagation()
		}, true)

		window.addEventListener('hashchange', () => this._syncFromHash())
		this._buildCodex()
		this._syncFromHash()
	}

	// ── routing ────────────────────────────────────────────────────────────────
	// The hash is the source of truth; enter()/leave() only ever write to it and let the
	// hashchange handler do the work. Two paths into one state means the back button and
	// the ✕ can never disagree about what is open.
	_syncFromHash() {
		const m = /^#\/([a-z-]+)(?:\/([a-z0-9-]+))?/i.exec(location.hash || '')
		const name = m && this._screens.has(m[1]) ? m[1] : null
		if (name === 'codex' && m[2]) this._selectCodex(m[2], false)
		if (name === this._current) return
		this._show(name)
	}

	enter(name) {
		if (!this._screens || !this._screens.has(name)) return
		location.hash = `#/${name}`
	}

	leave() {
		// Back out through history when we arrived by navigation, so the back stack does
		// not grow a chain of dead screen entries as the player browses around.
		if (this._enteredByRoute) { this._enteredByRoute = false; history.back(); return }
		location.hash = ''
	}

	_show(name) {
		const prev = this._current
		if (prev && this._screens.get(prev)) {
			this._screens.get(prev).classList.add('screen-closed')
			this._onLeave(prev)
		}
		this._current = name
		document.body.classList.toggle('screen-open', !!name)
		if (!name) { this._stopNarration(); return }
		const el = this._screens.get(name)
		el.classList.remove('screen-closed')
		this._enteredByRoute = !prev
		this._onEnter(name, el)
		if (this._sim && this._sim.audio) this._sim.audio.menuOpen()
		// Move focus to the screen so keyboard and screen readers follow the surface
		// change; without it, tab order stays behind on the menu the player just left.
		const focus = el.querySelector('[data-screen-focus]') || el
		try { focus.focus({ preventScroll: true }) } catch (e) { /* older browsers */ }
	}

	_onEnter(name, el) {
		if (name === 'character') this._menu && this._menu.onCharacterScreenEnter(el)
		if (name === 'issuance') this._startBloodPoll()
		if (name === 'codex' && !this._codexId) this._selectCodex(CODEX_ENTRIES[0].id, false)
		// Repaint on every entry rather than once: the OWNED badges come from the wallet
		// panel's last chain read, which may have landed since the player was last here.
		if (name === 'armory') this._renderArmory()
		if (name === 'fragbench') this._startBenchPoll()
	}

	_onLeave(name) {
		if (name === 'character') this._menu && this._menu.onCharacterScreenLeave()
		if (name === 'issuance') this._stopBloodPoll()
		if (name === 'codex') this._stopNarration()
		if (name === 'fragbench') this._stopBenchPoll()
	}

	// ── FRAGBENCH: the way back to the other door ─────────────────────────────
	// The identity gate wrote its answer to localStorage and never offered a way to
	// change it. Answer "human" once — which is what a curious person does on their first
	// visit — and the agent entrant path became unreachable for good, except by knowing
	// to type ?whoami=1. That is a one-way latch on the half of the product that is
	// supposed to be open to programs.
	//
	// The fix follows what agent-first services settled on: a stable, machine-readable doc
	// at a known URL (/frag.md, already advertised in <head>), and BOTH doors permanently
	// open rather than a single question asked once. The gate can still remember — being
	// asked every visit is its own annoyance — but remembering is now reversible, and the
	// spec has a permanent home in the menu that never depended on the answer.
	_startBenchPoll() {
		const base = location.protocol === 'https:' ? '' : `http://${location.hostname}:8078`
		const poll = async () => {
			try {
				const res = await fetch(`${base}/fragbench`, { cache: 'no-store' })
				if (res.ok) this._paintBench(await res.json())
			} catch (e) { /* server down — keep the last good census */ }
		}
		poll()
		this._benchTimer = setInterval(poll, 5000)
		this._wireBenchReset()
	}

	_stopBenchPoll() {
		if (this._benchTimer) { clearInterval(this._benchTimer); this._benchTimer = null }
	}

	_paintBench(s) {
		const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v }
		if (!s || !s.enabled) {
			set('bench-state', 'GATEWAY OFF')
			set('bench-seats', '—')
			set('bench-agents', '—')
			return
		}
		set('bench-state', 'OPEN')
		// Shape comes from AgentGateway.status(). Tolerate a field being absent rather
		// than printing "undefined" at a would-be entrant.
		const n = (v) => (Number.isFinite(v) ? String(v) : '—')
		set('bench-seats', `${n(s.seatsFree)} / ${n(s.maxAgents)}`)
		set('bench-agents', n(s.agents))
		set('bench-humans', n(s.humans))
		set('bench-map', (s.map && s.map.mapName) || '—')
		set('bench-protocol', s.protocol || 'fragbench/0')
		set('bench-obs', s.obsHz ? s.obsHz + ' Hz' : '—')

		// Who is on the board right now, by MODEL — the ladder ranks models, not
		// nicknames, so the model is the column that means something.
		this._paintRows('bench-entrant-rows', s.entrants || [],
			(e) => [`${e.name || 'agent'}${e.model ? ' · ' + e.model : ''}`, `${e.kills | 0}/${e.deaths | 0}`],
			'no agents connected right now')
	}

	// "I am actually an agent" / "ask me again". Clearing the stored answer is the whole
	// escape hatch — the gate re-asks on the next load, and the other door is reachable
	// again without anyone needing to know a query string.
	_wireBenchReset() {
		const btn = document.getElementById('bench-reset')
		if (!btn || btn._wired) return
		btn._wired = true
		btn.addEventListener('click', () => {
			try { localStorage.removeItem('fa-whoami') } catch (e) { /* private mode */ }
			const note = document.getElementById('bench-reset-note')
			if (note) note.textContent = 'cleared — the identity question returns on your next visit.'
			btn.disabled = true
		})
	}

	// ── ISSUANCE: live Proof of Blood ─────────────────────────────────────────
	// Polls /blood while the screen is up and stops the moment it is not. The numbers are
	// the ledger's own derived state (BloodLedger.status), never restated here — a screen
	// that recomputes issuance is a screen that can disagree with the chain it describes.
	_startBloodPoll() {
		const base = location.protocol === 'https:' ? '' : `http://${location.hostname}:8078`
		const poll = async () => {
			try {
				const res = await fetch(`${base}/blood`, { cache: 'no-store' })
				if (res.ok) this._paintBlood(await res.json())
			} catch (e) { /* server down — the screen keeps its last good numbers */ }
		}
		poll()
		this._bloodTimer = setInterval(poll, 5000)
	}

	_stopBloodPoll() {
		if (this._bloodTimer) { clearInterval(this._bloodTimer); this._bloodTimer = null }
	}

	_paintBlood(s) {
		const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v }
		const num = (n) => (n | 0).toLocaleString()
		if (!s || !s.enabled) { set('blood-height', '—'); set('blood-state', 'LEDGER OFFLINE'); return }

		set('blood-state', 'MINING')
		set('blood-height', '#' + num(s.height))
		set('blood-reward', num(s.reward) + ' ' + s.symbol)
		set('blood-mined', num(s.mined))
		set('blood-cap', num(s.cap))
		set('blood-holders', num(s.holderCount))
		set('blood-halving', num(s.blocksToHalving) + ' BLOCKS')
		set('blood-halvings', num(s.halvings))

		// Percent of the CAP, not of what has been mined — the honest denominator. At
		// height ~1000 of 2160 this is a fraction of a percent, and it should look like it.
		const pct = s.cap > 0 ? (s.mined / s.cap) * 100 : 0
		set('blood-pct', pct < 0.01 ? '<0.01%' : pct.toFixed(2) + '%')
		const bar = document.getElementById('blood-bar-fill')
		// Floor the visible width so a real but tiny supply is still a visible sliver
		// rather than nothing — "mined: 104,975" next to an empty bar reads as broken.
		if (bar) bar.style.width = Math.max(0.4, Math.min(100, pct)) + '%'

		// the open block: how far through the window, and who is mining it
		const total = s.blockMs || 1
		const through = Math.max(0, Math.min(1, (s.windowMs || 0) / total))
		const wbar = document.getElementById('blood-window-fill')
		if (wbar) wbar.style.width = (through * 100).toFixed(1) + '%'
		const secs = Math.max(0, Math.round((s.windowRemainingMs || 0) / 1000))
		set('blood-window-left', `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`)
		set('blood-window-hash', num(s.windowHash) + ' HASH')

		this._paintRows('blood-window-rows', (s.window || []), (w) => [w.name, num(w.hash) + ' hash'],
			'nothing mined in this block yet')
		this._paintRows('blood-holder-rows', (s.holders || []), (h) => [h.name, num(h.amount)],
			'no balances yet')
	}

	_paintRows(id, items, fmt, emptyText) {
		const ul = document.getElementById(id)
		if (!ul) return
		ul.innerHTML = ''
		if (!items.length) {
			const li = document.createElement('li')
			li.className = 'rows-empty'
			li.textContent = emptyText
			ul.appendChild(li)
			return
		}
		for (const item of items) {
			const [left, right] = fmt(item)
			const li = document.createElement('li')
			const a = document.createElement('span'); a.textContent = left
			const b = document.createElement('b'); b.textContent = right
			li.appendChild(a); li.appendChild(b); ul.appendChild(li)
		}
	}

	// ── ARMORY: the catalogue, and the way out to a marketplace ───────────────
	// The collection is listed on Tensor and Magic Eden, and until now the game said so
	// nowhere — a player who wanted the sniper had no path from "I want it" to "I own it".
	//
	// The filtering is the point. Eighty mints across twenty-four types is a wall, and the
	// two questions anyone actually arrives with are "what weapons are there" and "what
	// does a full set of one finish cost me". So: kind first, finish second.
	_wireArmory() {
		const bar = document.getElementById('armory-filters')
		if (!bar) return
		this._armoryKind = 'all'
		this._armoryFinish = 'all'
		bar.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-filter]')
			if (!btn) return
			const [group, value] = btn.getAttribute('data-filter').split(':')
			if (group === 'kind') {
				this._armoryKind = value
				// Leaving armour makes the finish filter meaningless; carrying a stale one
				// over would silently hide most of the weapons behind an invisible rule.
				if (value !== 'armor') this._armoryFinish = 'all'
			}
			if (group === 'finish') this._armoryFinish = value
			if (this._sim && this._sim.audio) this._sim.audio.uiClick()
			this._renderArmory()
		})
	}

	_renderArmory() {
		const grid = document.getElementById('armory-grid')
		if (!grid) return
		if (!this._armoryWired) { this._armoryWired = true; this._wireArmory() }

		const owned = new Set((this._menu && this._menu._lastHoldings) || [])
		const kind = this._armoryKind || 'all'
		const finish = this._armoryFinish || 'all'

		// The finish row only means anything for armour — weapons have no finish.
		const finishRow = document.getElementById('armory-finishes')
		if (finishRow) finishRow.hidden = kind === 'weapon'

		for (const btn of document.querySelectorAll('#armory-filters [data-filter]')) {
			const [g, v] = btn.getAttribute('data-filter').split(':')
			btn.classList.toggle('is-active', (g === 'kind' && v === kind) || (g === 'finish' && v === finish))
		}

		const items = ARMORY_ITEMS.filter((it) => {
			if (kind !== 'all' && it.kind !== kind) return false
			if (finish !== 'all' && it.finish !== finish) return false
			return true
		})

		const count = document.getElementById('armory-count')
		if (count) {
			const mints = items.reduce((n, i) => n + i.supply, 0)
			count.textContent = `${items.length} TYPE${items.length === 1 ? '' : 'S'} · ${mints} MINTED`
		}

		grid.innerHTML = ''
		for (const it of items) grid.appendChild(this._armoryCard(it, owned.has(it.name)))
	}

	_armoryCard(it, isOwned) {
		const card = document.createElement('article')
		card.className = 'armory-card'
		card.setAttribute('data-rarity', (it.rarity || '').toLowerCase())
		if (isOwned) card.classList.add('is-owned')

		const fig = document.createElement('div')
		fig.className = 'armory-art'
		const img = document.createElement('img')
		img.src = armoryArt(it.slug)
		img.alt = it.name
		// Off-screen cards are most of this grid on first paint; nothing here is above the
		// fold except the first row, and the art is ~190kB apiece.
		img.loading = 'lazy'
		img.decoding = 'async'
		fig.appendChild(img)
		if (isOwned) {
			const badge = document.createElement('span')
			badge.className = 'armory-owned'
			badge.textContent = 'OWNED'
			fig.appendChild(badge)
		}
		card.appendChild(fig)

		const head = document.createElement('div')
		head.className = 'armory-card-head'
		const h4 = document.createElement('h4')
		h4.textContent = it.name
		const rar = document.createElement('span')
		rar.className = 'armory-rarity'
		rar.textContent = it.rarity
		head.appendChild(h4)
		head.appendChild(rar)
		card.appendChild(head)

		const meta = document.createElement('div')
		meta.className = 'armory-meta'
		// Weapons say what they unlock, because that is the reason to buy one. Armour says
		// where it sits and in which finish, because a set is assembled slot by slot.
		meta.textContent = it.kind === 'weapon'
			? `UNLOCKS THE ${String(it.label).toUpperCase()}`
			: `${String(it.finish).toUpperCase()} · ${String(it.label).toUpperCase()}`
		card.appendChild(meta)

		const buy = document.createElement('div')
		buy.className = 'armory-buy'
		for (const [label, href] of [['TENSOR', tensorItem(it.mint)], ['MAGIC EDEN', magicEdenItem(it.mint)]]) {
			const a = document.createElement('a')
			a.className = 'armory-buy-btn'
			a.href = href
			a.target = '_blank'
			// noopener: these are third-party tabs and window.opener would hand them a
			// handle back into the game's window.
			a.rel = 'noopener noreferrer'
			a.textContent = label
			buy.appendChild(a)
		}
		card.appendChild(buy)

		const supply = document.createElement('div')
		supply.className = 'armory-supply'
		supply.textContent = `SUPPLY ${it.supply}`
		card.appendChild(supply)
		return card
	}

	// ── CODEX: the narrated whitepaper ────────────────────────────────────────
	_buildCodex() {
		const list = document.getElementById('codex-list')
		if (!list) return
		list.innerHTML = ''
		for (const cat of CODEX_CATEGORIES) {
			const entries = CODEX_ENTRIES.filter((e) => e.category === cat.id)
			if (!entries.length) continue
			const head = document.createElement('div')
			head.className = 'codex-cat'
			head.textContent = cat.label
			list.appendChild(head)
			for (const entry of entries) {
				const btn = document.createElement('button')
				btn.type = 'button'
				btn.className = 'codex-item'
				btn.setAttribute('data-codex-id', entry.id)
				const t = document.createElement('span'); t.className = 'codex-item-title'; t.textContent = entry.title
				const k = document.createElement('span'); k.className = 'codex-item-kicker'; k.textContent = entry.kicker
				btn.appendChild(t); btn.appendChild(k)
				btn.addEventListener('click', () => this._selectCodex(entry.id, true))
				list.appendChild(btn)
			}
		}
		const play = document.getElementById('codex-narrate')
		if (play) play.addEventListener('click', () => this._toggleNarration())
	}

	_selectCodex(id, route) {
		const entry = codexEntry(id)
		if (!entry) return
		this._stopNarration()
		this._codexId = id
		if (route) location.hash = `#/codex/${id}`

		for (const btn of document.querySelectorAll('[data-codex-id]')) {
			btn.classList.toggle('is-active', btn.getAttribute('data-codex-id') === id)
		}
		const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text }
		set('#codex-kicker', entry.kicker)
		set('#codex-title', entry.title)
		const body = document.getElementById('codex-body')
		if (body) {
			body.innerHTML = ''
			for (const para of entry.body) {
				const p = document.createElement('p')
				p.textContent = para
				body.appendChild(p)
			}
			body.scrollTop = 0
		}
	}

	// NARRATION. Prefers a recorded read (entry.vo) and falls back to the browser's speech
	// synthesis, which is the difference between a codex that talks and one that does not.
	// Guarded on availability throughout: speechSynthesis is missing or mute in enough
	// environments (older iOS Safari, locked-down embeds) that treating it as present is a
	// crash waiting to happen.
	_toggleNarration() {
		if (this._narrator) { this._stopNarration(); return }
		const entry = codexEntry(this._codexId)
		if (!entry) return

		const btn = document.getElementById('codex-narrate')
		const done = () => { this._narrator = null; if (btn) btn.classList.remove('is-playing') }

		if (entry.vo) {
			const audio = new Audio(entry.vo)
			audio.addEventListener('ended', done)
			audio.addEventListener('error', done)
			// Recorded VO rides the same bus as the rest of the mix, so the settings
			// volume slider governs it rather than it playing at full tilt over the music.
			if (this._sim && this._sim.audio && this._sim.audio.voiceVolume !== undefined) {
				audio.volume = this._sim.audio.voiceVolume
			}
			audio.play().catch(done)
			this._narrator = { stop: () => { try { audio.pause() } catch (e) {} } }
			if (btn) btn.classList.add('is-playing')
			return
		}

		const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
		if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return
		const u = new SpeechSynthesisUtterance(codexNarration(entry))
		// Slightly under default: this is a briefing, not a disclaimer.
		u.rate = 0.92
		u.pitch = 0.9
		u.addEventListener('end', done)
		u.addEventListener('error', done)
		synth.cancel()
		synth.speak(u)
		this._narrator = { stop: () => { try { synth.cancel() } catch (e) {} } }
		if (btn) btn.classList.add('is-playing')
	}

	_stopNarration() {
		if (this._narrator) { this._narrator.stop(); this._narrator = null }
		const btn = document.getElementById('codex-narrate')
		if (btn) btn.classList.remove('is-playing')
	}
}
