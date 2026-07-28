import fs from 'fs'
import path from 'path'

/* PROOF OF BLOOD — a Bitcoin-mirror block engine, calculated live server-side
 * (nothing on-chain yet). Wall-clock blocks (default 10 min); players accumulate
 * HASHPOWER inside the current window (kills, and later objective events); at
 * block close the block reward splits proportionally to hash share (integer
 * floor per share). Halving every 2160 blocks (~15 days at 10 min/block):
 * reward = floor(5000 / 2^floor(height/2160)). An empty block (no hash) issues
 * no reward, but height ALWAYS advances — exactly like an empty BTC block.
 *
 * No external deps. State persists at <dataDir>/blood-ledger.json via atomic
 * write (tmp + rename). Corrupt/missing state starts fresh with a warning.
 */

const GENESIS_REWARD = 5000
const HALVING_INTERVAL = 2160
const MAX_BLOCK_SUMMARIES = 50
const DEFAULT_BLOCK_MS = 600000 // 10 minutes

export default class BloodLedger {
	constructor({ dataDir, blockMs } = {}) {
		// env override exists ONLY for testing (e.g. BLOOD_BLOCK_MS=15000)
		this.blockMs = blockMs
			|| parseInt(process.env.BLOOD_BLOCK_MS, 10)
			|| DEFAULT_BLOCK_MS
		this.dataDir = dataDir || 'data'
		this.filePath = path.join(this.dataDir, 'blood-ledger.json')

		// persistent state
		this.height = 0
		this.balances = {} // name -> total $BLOOD earned
		this.blocks = [] // last ~50 block summaries {height, reward, totalHash, winners}
		this.windowStart = Date.now()

		// in-flight window (NOT persisted — hash mined mid-window is lost on a
		// restart, same way a BTC miner loses in-progress work on a power cut)
		this.window = {} // name -> hashpower accumulated this window

		try {
			fs.mkdirSync(this.dataDir, { recursive: true })
		} catch (err) {
			console.warn(`[blood] could not create data dir "${this.dataDir}": ${err.message}`)
		}
		this._load()
	}

	/**
	 * Read-only snapshot for the ISSUANCE screen (/blood in serverMain).
	 *
	 * Everything here is DERIVED, never stored: the mined total and the cap are sums over
	 * the schedule rather than running counters, so a hand-edited or partially-restored
	 * ledger file cannot quietly invent supply. The screen is a claim about issuance, and
	 * a claim about issuance that drifts from the schedule is worse than no screen.
	 *
	 * `mined` is the exact issued total (sum of every recorded winner share), which is
	 * NOT the same as "reward x height" — empty blocks issue nothing, and per-share
	 * flooring burns dust. Only the last MAX_BLOCK_SUMMARIES blocks are retained though,
	 * so this sums BALANCES, the one complete record of what was actually handed out.
	 */
	status(now = Date.now()) {
		const height = this.height
		const reward = this.blockReward(height)
		const holders = Object.entries(this.balances)
			.map(([name, amount]) => ({ name, amount }))
			.sort((a, b) => b.amount - a.amount)
		let mined = 0
		for (const h of holders) mined += h.amount

		// hash mined so far in the window nobody has been paid for yet
		const window = Object.entries(this.window)
			.map(([name, hash]) => ({ name, hash }))
			.sort((a, b) => b.hash - a.hash)
		let windowHash = 0
		for (const w of window) windowHash += w.hash

		const halvings = Math.floor(height / HALVING_INTERVAL)
		const nextHalvingHeight = (halvings + 1) * HALVING_INTERVAL

		return {
			height,
			reward,
			// Total that WILL ever exist, summed straight off the schedule rather than
			// hardcoded: the "~21.6M" in the whitepaper is a rounded restatement of this,
			// and if the two ever disagree this one is right.
			cap: BloodLedger.mintedCap(),
			mined,
			holders: holders.slice(0, 25),
			holderCount: holders.length,
			halvings,
			nextHalvingHeight,
			blocksToHalving: nextHalvingHeight - height,
			blockMs: this.blockMs,
			// where we are inside the open block — what makes the screen feel live
			windowMs: Math.max(0, now - this.windowStart),
			windowRemainingMs: Math.max(0, this.windowStart + this.blockMs - now),
			windowHash,
			window: window.slice(0, 10),
			recent: this.blocks.slice(-10).reverse(),
		}
	}

	/**
	 * The mined cap: sum over every halving era of (interval x that era's reward), until
	 * the reward floors to zero. Bitcoin's 21M is the same sum with different constants.
	 * Computed rather than written down so the constants above stay the single source of
	 * truth — change GENESIS_REWARD and this follows.
	 */
	static mintedCap() {
		let total = 0
		for (let era = 0; ; era++) {
			const reward = Math.floor(GENESIS_REWARD / Math.pow(2, era))
			if (reward <= 0) break
			total += reward * HALVING_INTERVAL
		}
		return total
	}

	// reward = floor(5000 / 2^floor(height/2160)); hits 0 after enough halvings
	blockReward(height) {
		const halvings = Math.floor(height / HALVING_INTERVAL)
		return Math.floor(GENESIS_REWARD / Math.pow(2, halvings))
	}

	// Accumulate hashpower into the current window. `reason` is advisory
	// (kill/assist/flag_cap/...) — kept for future audit logging.
	recordHash(name, amount, reason) { // eslint-disable-line no-unused-vars
		if (!name || typeof name !== 'string') return
		if (!Number.isFinite(amount) || amount <= 0) return
		this.window[name] = (this.window[name] || 0) + amount
	}

	// Called every server tick. Closes the block when the window has run its
	// course. Multi-block gaps (long sleeps / downtime carried in via persisted
	// windowStart): only the CURRENT window's hash mines the ONE block it
	// closes; every additional elapsed block is empty — height advances, no
	// reward issued. Block boundaries stay on the fixed windowStart grid.
	tick(now) {
		const elapsedMs = now - this.windowStart
		if (elapsedMs < this.blockMs) return
		const elapsedBlocks = Math.floor(elapsedMs / this.blockMs)

		// the block the current window closes — the only one its hash mines
		this._closeBlock()

		// remaining elapsed blocks (if any) were empty: advance height only
		const skipped = elapsedBlocks - 1
		if (skipped > 0) {
			this.height += skipped
			console.log(`[blood] advanced ${skipped} empty block(s) after gap -> height ${this.height}`)
		}

		this.windowStart += elapsedBlocks * this.blockMs
		this.window = {}
		this._save()
	}

	// Close the block at the current height using the current window's hash.
	// Reward splits proportionally to hash share, integer floor per share
	// (dust from flooring is burned, like BTC fee rounding). Empty window or
	// zero reward -> no issuance; height still advances.
	_closeBlock() {
		const height = this.height
		const reward = this.blockReward(height)
		const names = Object.keys(this.window)
		let totalHash = 0
		for (const name of names) totalHash += this.window[name]

		const winners = {}
		let topName = null
		let topHash = 0
		if (totalHash > 0 && reward > 0) {
			for (const name of names) {
				const hash = this.window[name]
				const share = Math.floor((reward * hash) / totalHash)
				if (share > 0) {
					winners[name] = share
					this.balances[name] = (this.balances[name] || 0) + share
				}
				if (hash > topHash) { topHash = hash; topName = name }
			}
		}

		this.blocks.push({ height, reward, totalHash, winners })
		if (this.blocks.length > MAX_BLOCK_SUMMARIES) {
			this.blocks.splice(0, this.blocks.length - MAX_BLOCK_SUMMARIES)
		}
		this.height = height + 1

		const top = topName ? `${topName} (${topHash} hash, +${winners[topName] || 0} BLOOD)` : 'none'
		console.log(`[blood] block #${height} closed: reward=${reward} totalHash=${totalHash} top=${top}`)
	}

	_load() {
		let rawText
		try {
			rawText = fs.readFileSync(this.filePath, 'utf8')
		} catch (err) {
			if (err.code !== 'ENOENT') {
				console.warn(`[blood] could not read ${this.filePath} (${err.message}) — starting fresh`)
			}
			return // missing file: fresh genesis state, no warning needed
		}
		try {
			const state = JSON.parse(rawText)
			if (typeof state !== 'object' || state === null) throw new Error('not an object')
			if (Number.isFinite(state.height) && state.height >= 0) this.height = Math.floor(state.height)
			if (state.balances && typeof state.balances === 'object') this.balances = state.balances
			if (Array.isArray(state.blocks)) this.blocks = state.blocks.slice(-MAX_BLOCK_SUMMARIES)
			if (Number.isFinite(state.windowStart) && state.windowStart > 0) this.windowStart = state.windowStart
			console.log(`[blood] ledger loaded: height=${this.height} holders=${Object.keys(this.balances).length}`)
		} catch (err) {
			console.warn(`[blood] corrupt ledger at ${this.filePath} (${err.message}) — starting fresh`)
			this.height = 0
			this.balances = {}
			this.blocks = []
			this.windowStart = Date.now()
		}
	}

	// atomic persist: write a sibling tmp file then rename over the target
	_save() {
		const state = {
			height: this.height,
			balances: this.balances,
			blocks: this.blocks,
			windowStart: this.windowStart,
		}
		const tmpPath = this.filePath + '.tmp'
		try {
			fs.writeFileSync(tmpPath, JSON.stringify(state))
			fs.renameSync(tmpPath, this.filePath)
		} catch (err) {
			console.warn(`[blood] persist failed: ${err.message}`)
		}
	}
}
