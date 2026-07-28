// LIVE MARKET FEED for the in-game HUD. Ported from solMTG (api/src/lib/market.js) and
// trimmed to what a game server should carry: read-only, no keys that can move money, no
// Telegram posting from inside the arena process.
//
// HONEST BY CONSTRUCTION. With no DEGEN_CA configured this reports { live: false } and the
// HUD shows a dashed no-data state. We never display invented market numbers — a fake
// marketcap on a screen next to a real token is the one bug here that costs trust rather
// than a life.
//
// Sources, best available first:
//   DexScreener   — mcap + 5m buy/sell counts. Free, no key. Always used when a CA is set.
//   Helius        — per-trade whale feed via enhanced transactions. Needs HELIUS_API_KEY.
// The two are complementary rather than alternatives: DexScreener gives the aggregates
// accurately and cheaply, Helius gives the individual fills the whale alerts need.
//
// Everything is polled on a timer OUTSIDE the game tick and served from memory, so the
// 40Hz simulation never waits on a network call.

const CA = process.env.DEGEN_CA || process.env.PUMP_CA || process.env.CA || ''
const HELIUS_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS || ''
const DEX_POLL_MS = Number(process.env.MARKET_POLL_MS || 15000)
const TRADE_POLL_MS = Number(process.env.MARKET_TRADE_POLL_MS || 20000)
// pump.fun standard. Only used if DexScreener has no marketCap of its own.
const SUPPLY = 1_000_000_000
// Below this a "whale alert" is just noise; the HUD tiering starts here.
const MIN_ALERT_SOL = Number(process.env.MARKET_MIN_ALERT_SOL || 5)
const MAX_TRADES = 40

const state = {
	live: false,
	ca: CA,
	mcapUsd: 0,
	changePct: 0,
	buys5m: 0,
	sells5m: 0,
	priceUsd: 0,
	trades: [],      // newest first: { id, type, sol, wallet, ts }
	updatedAt: 0,
	source: null,
}
let nextTradeId = 1
let timers = []
// Trades already emitted, so a poll that re-reports the same fill does not fire a second
// alert. Bounded: the key set is attacker-influenced only in the sense that anyone can
// trade, but it still must not grow without limit.
const seenSigs = new Set()

async function getJson(url, ms = 10000) {
	const ctrl = new AbortController()
	const t = setTimeout(() => ctrl.abort(), ms)
	try {
		const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
		if (!r.ok) throw new Error(`http ${r.status}`)
		return await r.json()
	} finally { clearTimeout(t) }
}

// ── DexScreener: the aggregates ───────────────────────────────────────────────
async function pollDex() {
	try {
		const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${CA}`)
		const all = Array.isArray(j?.pairs) ? j.pairs : []
		// OUR TOKEN MUST BE THE BASE. /tokens/<ca> also returns pairs where the token is
		// the QUOTE side, and in those `priceUsd` is the OTHER token's price — reading it
		// reports a number that has nothing to do with us. Caught testing against a real
		// token: it reported a $1.35T marketcap at a price 700x the true one.
		const ca = CA.toLowerCase()
		const mine = all.filter((p) => (p.baseToken?.address || '').toLowerCase() === ca)
		if (!mine.length) return

		// QUOTE IN A MAJOR, OR NOT AT ALL. A token trades against many things, and
		// DexScreener derives priceUsd through the QUOTE asset — so a pair quoted in some
		// thin altcoin inherits that altcoin's bad USD mark.
		//
		// This is not theoretical. Testing against a real token, the same CA returned
		// Bonk/SOL and Bonk/USDC at $0.0000030 (mcap $269M, correct) alongside Bonk/MET
		// and Bonk/RAY at $0.0151 (mcap $1.35 TRILLION, nonsense) — and the bad pairs had
		// the DEEPER liquidity, so picking by liquidity alone chose the wrong one and
		// would have put a $1.35T marketcap on the HUD.
		const MAJORS = new Set(['so11111111111111111111111111111111111111112']) // wSOL
		const MAJOR_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT'])
		const isMajor = (p) => MAJORS.has((p.quoteToken?.address || '').toLowerCase())
			|| MAJOR_SYMBOLS.has((p.quoteToken?.symbol || '').toUpperCase())
		const trusted = mine.filter(isMajor)
		// Fall back to all pairs only if nothing is quoted in a major — a brand-new token
		// with one odd pool is still better represented than by nothing.
		const pairs = trusted.length ? trusted : mine
		// Among trusted pairs, deepest liquidity is the one whose price a chart shows.
		const p = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a))
		const priceUsd = Number(p.priceUsd) || 0
		state.priceUsd = priceUsd
		state.mcapUsd = Number(p.marketCap) || Number(p.fdv) || priceUsd * SUPPLY
		state.changePct = Number(p.priceChange?.m5) || 0
		state.buys5m = Number(p.txns?.m5?.buys) || 0
		state.sells5m = Number(p.txns?.m5?.sells) || 0
		state.updatedAt = Date.now()
		state.live = true
		state.source = 'dexscreener'
	} catch (e) {
		// A failed poll keeps the last good numbers and the last good timestamp; the HUD
		// decides for itself when a reading is too stale to show (see isStale).
		console.log('[market] dexscreener poll failed:', e.message)
	}
}

// ── Helius: the individual fills the whale alerts are made of ─────────────────
async function pollTrades() {
	if (!HELIUS_KEY) return
	try {
		const url = `https://api.helius.xyz/v0/addresses/${CA}/transactions?api-key=${HELIUS_KEY}&type=SWAP&limit=25`
		const txs = await getJson(url, 15000)
		if (!Array.isArray(txs)) return
		const fresh = []
		// Oldest first so the ring buffer ends up newest-first after unshifting.
		for (const tx of txs.slice().reverse()) {
			const sig = tx.signature
			if (!sig || seenSigs.has(sig)) continue
			seenSigs.add(sig)
			const t = classifySwap(tx)
			if (t) fresh.push(t)
		}
		for (const t of fresh) {
			state.trades.unshift(t)
			if (state.trades.length > MAX_TRADES) state.trades.pop()
		}
		if (seenSigs.size > 500) {
			// cheap trim — drop the oldest half rather than tracking insertion order
			const keep = [...seenSigs].slice(-250)
			seenSigs.clear()
			for (const s of keep) seenSigs.add(s)
		}
	} catch (e) {
		console.log('[market] helius trade poll failed:', e.message)
	}
}

/**
 * Turn one Helius enhanced SWAP into { type, sol, wallet, ts } or null.
 *
 * Direction is read from the NATIVE SOL movement of the swapper: SOL leaving their
 * account is a buy of the token, SOL arriving is a sell. Reading it off the token
 * transfers instead breaks on routed swaps that hop through intermediate mints.
 */
function classifySwap(tx) {
	const swap = tx.events?.swap
	if (!swap) return null
	const inSol = Number(swap.nativeInput?.amount || 0) / 1e9
	const outSol = Number(swap.nativeOutput?.amount || 0) / 1e9
	const sol = Math.max(inSol, outSol)
	if (!(sol > 0)) return null
	const wallet = swap.nativeInput?.account || swap.nativeOutput?.account || tx.feePayer || ''
	return {
		id: nextTradeId++,
		type: inSol >= outSol ? 'BUY' : 'SELL',
		sol: Math.round(sol * 100) / 100,
		wallet,
		ts: (tx.timestamp || Math.floor(Date.now() / 1000)) * 1000,
		sig: tx.signature,
	}
}

// A reading older than this is not shown as current. Silence beats a stale marketcap
// presented as live.
const STALE_MS = 120000
const isStale = () => !state.updatedAt || Date.now() - state.updatedAt > STALE_MS

export function startMarketFeed() {
	if (!CA) {
		console.log('[market] no DEGEN_CA — market HUD off (no invented numbers)')
		return
	}
	console.log(`[market] tracking ${CA.slice(0, 8)}… via dexscreener${HELIUS_KEY ? ' + helius trades' : ' (no HELIUS_API_KEY — no whale feed)'}`)
	pollDex()
	pollTrades()
	timers.push(setInterval(pollDex, DEX_POLL_MS))
	timers.push(setInterval(pollTrades, TRADE_POLL_MS))
	// Never hold the process open on these: the server exits deliberately on map rotation
	// and a live interval would stall that exit.
	for (const t of timers) if (t.unref) t.unref()
}

export function stopMarketFeed() {
	for (const t of timers) clearInterval(t)
	timers = []
}

/** Read-only snapshot for /market. `live:false` is a real answer, not an error. */
export function marketStatus() {
	if (!CA) return { live: false, reason: 'no contract address configured' }
	if (!state.live || isStale()) {
		return { live: false, reason: state.live ? 'data stale' : 'awaiting first reading', ca: CA }
	}
	const total = state.buys5m + state.sells5m
	return {
		live: true,
		ca: CA,
		mcapUsd: Math.round(state.mcapUsd),
		priceUsd: state.priceUsd,
		changePct: Math.round(state.changePct * 10) / 10,
		buys5m: state.buys5m,
		sells5m: state.sells5m,
		// Pre-computed so the HUD is not deciding what "pressure" means; 0.5 with no
		// volume at all is the honest neutral rather than a divide-by-zero.
		buyPressure: total > 0 ? state.buys5m / total : 0.5,
		minAlertSol: MIN_ALERT_SOL,
		trades: state.trades.filter((t) => t.sol >= MIN_ALERT_SOL).slice(0, 12),
		updatedAt: state.updatedAt,
		source: state.source,
	}
}
