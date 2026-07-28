import { CODEX_CATEGORIES, CODEX_ENTRIES, codexEntry, codexNarration } from '../config/codex'

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
	}

	_onLeave(name) {
		if (name === 'character') this._menu && this._menu.onCharacterScreenLeave()
		if (name === 'issuance') this._stopBloodPoll()
		if (name === 'codex') this._stopNarration()
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
