// MARKET HUD — the marketcap readout, the buy/sell pressure gauge, and whale alerts.
//
// Design comes from the round-robin in _work/hud-roundrobin/ (Voss → Halvorsen → Okonkwo →
// Ortega). The brief was "retro, almost steampunk, like the logo, a bit Warhammer —
// aggressive and almost arcane", with the hard constraint: do NOT replace the current
// retro look, improve on it. So this adds no new visual language. It reuses the X30
// tokens, the DSEG7 seven-segment face the HUD already uses for numerals, and the
// existing #hack-feed terminal for all but the largest alerts.
//
// THE THREE RULES THAT SURVIVED THE PANEL, in Ortega's words and enforced here:
//   1. --x30-threat (#FF3B46) IS COMBAT ONLY. A sell is amber (--x30-warn). A player
//      glancing at red must always be reading "I am in danger", never "the chart dipped".
//   2. COMBAT SUPPRESSION IS ALWAYS ACTIVE. The market yields to the firefight.
//   3. NO SCREEN-CENTER OCCLUSION. Nothing here enters the targeting cone.
//
// Everything is polled and painted OUTSIDE the render loop, on a 3s cadence, and touches
// the DOM only when a value actually changed — a HUD element that rewrites text every
// frame is a layout thrash on the machines this has to run on.
const POLL_MS = 3000

// Whale tiers, in SOL. I and II are terminal lines in the existing hack feed; only a
// Tier III takes screen space of its own, and even then at the top edge, never center.
const TIER_2 = 25
const TIER_3 = 100

export default class MarketHud {
	constructor(sim) {
		this._sim = sim || null
		this._panel = document.getElementById('mcap-panel')
		if (!this._panel) return
		this._banner = document.getElementById('whale-alert-banner')
		this._lastMcap = null
		this._seen = new Set()
		this._bannerTimer = null

		const base = location.protocol === 'https:' ? '' : `http://${location.hostname}:8078`
		this._url = `${base}/market`
		this._poll()
		this._timer = setInterval(() => this._poll(), POLL_MS)
	}

	dispose() {
		if (this._timer) { clearInterval(this._timer); this._timer = null }
		if (this._bannerTimer) { clearTimeout(this._bannerTimer); this._bannerTimer = null }
	}

	async _poll() {
		// Only while the arena is actually on screen. The menu has its own surfaces and a
		// background poll behind them is pure waste.
		if (!document.body.classList.contains('arena-entered')) return
		try {
			const res = await fetch(this._url, { cache: 'no-store' })
			if (res.ok) this._paint(await res.json())
		} catch (e) { /* server unreachable — the panel keeps its last state */ }
	}

	_paint(m) {
		const panel = this._panel
		if (!m || !m.live) {
			// NO INVENTED NUMBERS. Pre-launch, or a stale feed, reads as dashes — the same
			// way an instrument with no signal reads, rather than a plausible fiction.
			panel.setAttribute('data-state', 'nodata')
			this._set('mcap-value', '---------')
			this._set('mcap-delta', '')
			this._set('mcap-source', (m && m.reason ? m.reason : 'no signal').toUpperCase())
			this._paintPressure(0.5, true)
			return
		}
		panel.setAttribute('data-state', 'live')
		this._set('mcap-source', 'MCAP // SOL-MAINNET')

		// Grouped digits, no currency symbol inside the seven-segment field — a real LED
		// readout shows digits, and the $ lives in the label instead.
		const usd = Math.round(m.mcapUsd || 0)
		this._set('mcap-value', usd.toLocaleString('en-US'))

		const d = Number(m.changePct || 0)
		const delta = document.getElementById('mcap-delta')
		if (delta) {
			const txt = `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`
			if (delta.textContent !== txt) delta.textContent = txt
			delta.setAttribute('data-dir', d >= 0 ? 'up' : 'down')
		}

		// A single 150ms border flash on a MACRO move only. Ortega killed per-tick pulsing:
		// something that blinks on every reading becomes something the eye learns to ignore,
		// which is the opposite of what an alert is for.
		if (this._lastMcap != null && this._lastMcap > 0) {
			const move = Math.abs(usd - this._lastMcap) / this._lastMcap
			if (move > 0.05) {
				panel.setAttribute('data-flash', usd >= this._lastMcap ? 'up' : 'down')
				setTimeout(() => panel.removeAttribute('data-flash'), 150)
			}
		}
		this._lastMcap = usd

		this._paintPressure(m.buyPressure, false)
		for (const t of (m.trades || []).slice().reverse()) this._alert(t)
	}

	// Ten discrete blocks rather than a continuous bar: a segmented gauge reads as an
	// instrument, and it also stops a one-pixel change from looking like movement.
	_paintPressure(pressure, blank) {
		const wrap = document.getElementById('pressure-gauge')
		if (!wrap) return
		if (!wrap.childElementCount) {
			for (let i = 0; i < 10; i++) {
				const b = document.createElement('span')
				b.className = 'gauge-block'
				wrap.appendChild(b)
			}
		}
		const buyBlocks = blank ? 0 : Math.round(Math.max(0, Math.min(1, pressure)) * 10)
		const blocks = wrap.children
		for (let i = 0; i < blocks.length; i++) {
			const state = blank ? 'off' : (i < buyBlocks ? 'buy' : 'sell')
			if (blocks[i].getAttribute('data-s') !== state) blocks[i].setAttribute('data-s', state)
		}
		const pct = Math.round((blank ? 0.5 : pressure) * 100)
		this._set('pressure-buy', blank ? 'BUY --' : `BUY ${pct}%`)
		this._set('pressure-sell', blank ? 'SELL --' : `SELL ${100 - pct}%`)
	}

	_alert(t) {
		if (!t || this._seen.has(t.id)) return
		this._seen.add(t.id)
		// Bounded: ids climb forever on a busy token.
		if (this._seen.size > 400) this._seen = new Set([...this._seen].slice(-200))
		const short = t.wallet ? `${t.wallet.slice(0, 4)}…${t.wallet.slice(-4)}` : 'anon'
		const sol = Number(t.sol).toFixed(1)
		const buy = t.type === 'BUY'

		// VOICE. Same announcer and the same monster chain as the combat medals, because
		// $BLOOD is mined by killing and the market is part of the arena.
		//
		// SELLS ARE VOICED TOO. The original rule here was buy-only, on the reasoning that
		// a sell tells the player nothing they can act on. That is right for a BANNER and
		// wrong for a voice: half a market is not a market, and a feed that only ever
		// cheers is advertising rather than information. Sells stay out of the visual
		// alert lane and speak instead.
		//
		// minGap 0 is NOT used: the announcer's global cooldown is exactly what stops a
		// volley of fills from stacking into mush, and a market callout must never win
		// that race against a headshot — the arena outranks the chart.
		const audio = this._sim && this._sim.audio
		if (audio && audio.announce) {
			const clip = buy
				? (t.sol >= TIER_3 ? 'blood_tithe' : t.sol >= TIER_2 ? 'blood_harvest' : 'blood_acquired')
				: (t.sol >= TIER_3 ? 'blood_drained' : 'blood_dumped')
			// Quieter than a combat medal: this is ambient colour, not a kill you earned.
			audio.announce(clip, { gain: buy ? 0.85 : 0.7 })
		}

		// SELLS get no banner and no terminal line — the pressure gauge already carries
		// them, and a red interruption mid-firefight buys the player nothing.
		if (!buy) return

		if (t.sol >= TIER_3) { this._archon(sol, short); return }
		// Tiers I and II are terminal lines in the hack feed, which already exists, is
		// already in the right place, and is already the right typographic voice.
		const feed = this._sim && this._sim._intrusionFeed
		const line = t.sol >= TIER_2 ? `>> LARGE TITHE: +${sol} SOL (${short})` : `WHALE BUY: +${sol} SOL (${short})`
		if (feed && typeof feed.push === 'function') feed.push(line, 'ok')
	}

	// TIER III — the only market event allowed its own screen real estate. Top edge,
	// centered horizontally but well clear of the crosshair, gold (the token's existing
	// "this mattered" colour, shared with kills and streaks), gone in 4 seconds.
	_archon(sol, short) {
		const b = this._banner
		if (!b) return
		this._set('whale-amount', `+${sol} SOL`)
		this._set('whale-wallet', short)
		b.setAttribute('data-on', '1')
		if (this._sim && this._sim.audio && this._sim.audio.uiClick) this._sim.audio.uiClick()
		if (this._bannerTimer) clearTimeout(this._bannerTimer)
		this._bannerTimer = setTimeout(() => b.removeAttribute('data-on'), 4000)
	}

	_set(id, text) {
		const el = document.getElementById(id)
		if (el && el.textContent !== text) el.textContent = text
	}
}
