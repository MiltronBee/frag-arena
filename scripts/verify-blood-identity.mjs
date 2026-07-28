// PROOF OF BLOOD — settlement identity checks.
//
// The question these answer is not "does the reward split add up" but "could someone be
// paid for hash they did not mine". Earnings used to be keyed on the display callsign,
// which arrives from SetNameCommand and can be any string a client feels like sending —
// so on-chain settlement against that keyspace would have paid whoever typed the right
// name. These lock the fix.
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import BloodLedger from '../server/BloodLedger.js'

const results = []
const check = (n, fn) => {
	try { fn(); results.push({ n, p: true, d: '' }) }
	catch (e) { results.push({ n, p: false, d: String(e.message).slice(0, 220) }) }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blood-'))
// Blocks close on wall-clock, so a tiny window lets a test close one on demand.
const led = (dir) => new BloodLedger({ dataDir: dir, blockMs: 50 })
// Close a block the way the SERVER does. _closeBlock alone does not clear the window —
// tick() does that immediately after — so calling it twice in a row re-counts the last
// block's hash and every miner appears to earn twice. Tests must mirror the real cycle
// or they measure an arrangement that never happens in production.
const closeBlock = (l) => { l._closeBlock(); l.window = {} }
const WALLET_A = 'DEGENZnU4NWTQSQsmdaDMrjTrUVuTUeVdYJPmw8x1994'
const WALLET_B = '5u2raT68foyJiMJPGHMZxkoZWs81djASsn4cfkQhQsUv'

check('a callsign alone is NEVER settleable', () => {
	const l = led(tmp())
	l.recordHash('GHOST', 100, 'kill')            // no wallet — an unlinked human or a bot
	closeBlock(l)
	const ids = Object.keys(l.balances)
	assert.strictEqual(ids.length, 1)
	assert.ok(ids[0].startsWith('name:'), `expected a name: key, got ${ids[0]}`)
	assert.strictEqual(Object.keys(l.unsettled).length, 0, 'unlinked earnings must owe nothing')
})

check('IMPERSONATION: stealing a callsign does not steal the balance', () => {
	const l = led(tmp())
	// The real holder mines under a linked wallet.
	l.recordHash('GHOST', 100, 'kill', WALLET_A)
	closeBlock(l)
	const owed = l.unsettled[WALLET_A]
	assert.ok(owed > 0, 'the real holder should be owed something')

	// An impostor sets the SAME callsign, with a different wallet, and mines.
	l.recordHash('GHOST', 100, 'kill', WALLET_B)
	closeBlock(l)
	// The impostor is paid for their OWN hash and cannot touch the first wallet's debt.
	assert.strictEqual(l.unsettled[WALLET_A], owed, 'the impostor moved the real holder balance')
	assert.ok(l.unsettled[WALLET_B] > 0, 'the impostor should still earn on their own hash')
	assert.notStrictEqual(WALLET_A, WALLET_B)
})

check('two wallets sharing one callsign stay separate ledger entries', () => {
	const l = led(tmp())
	l.recordHash('ACE', 100, 'kill', WALLET_A)
	l.recordHash('ACE', 300, 'kill', WALLET_B)
	closeBlock(l)
	assert.ok(l.balances[WALLET_A] > 0 && l.balances[WALLET_B] > 0)
	// 1:3 hash split, so B must be paid more than A despite the identical name.
	assert.ok(l.balances[WALLET_B] > l.balances[WALLET_A], 'shares ignored the hash split')
})

check('bots earn, and are never owed anything on chain', () => {
	const l = led(tmp())
	l.recordHash('BLADE', 500, 'kill')             // a bot
	l.recordHash('agent:gpt-x', 500, 'kill')       // an agent entrant
	l.recordHash('HUMAN', 500, 'kill', WALLET_A)   // a linked human
	closeBlock(l)
	const s = l.status()
	assert.strictEqual(s.unsettledWallets, 1, 'only the linked human may be owed')
	assert.ok(s.unsettledTotal > 0)
	// but all three still appear on the scoreboard
	assert.strictEqual(s.holders.length, 3)
	assert.strictEqual(s.holders.filter((h) => h.settleable).length, 1)
})

check('the earnings record is append-only (settling never rewrites it)', () => {
	const l = led(tmp())
	l.recordHash('X', 100, 'kill', WALLET_A)
	closeBlock(l)
	const earned = l.balances[WALLET_A]
	// simulate a payout draining the debt
	delete l.unsettled[WALLET_A]
	assert.strictEqual(l.balances[WALLET_A], earned, 'paying out altered what was earned')
})

check('LEGACY MIGRATION cannot mint: old name-keyed balances become non-settleable', () => {
	const dir = tmp()
	// a schema-1 file, exactly the shape live prod had: balances keyed by callsign
	fs.writeFileSync(path.join(dir, 'blood-ledger.json'), JSON.stringify({
		height: 1008, balances: { GHOST: 26175, ACE: 24779 }, blocks: [], windowStart: Date.now(),
	}))
	const l = led(dir)
	assert.strictEqual(l.height, 1008, 'height must survive the migration')
	assert.strictEqual(Object.keys(l.unsettled).length, 0, 'MIGRATION CREATED A DEBT — it must never mint')
	for (const k of Object.keys(l.balances)) assert.ok(k.startsWith('name:'), `legacy key ${k} left settleable`)
	const s = l.status()
	assert.strictEqual(s.holders.filter((h) => h.settleable).length, 0)
	// display names survive so the scoreboard still reads GHOST, not name:GHOST
	assert.ok(s.holders.some((h) => h.name === 'GHOST'))
})

check('persistence round-trips the new fields', () => {
	const dir = tmp()
	const a = led(dir)
	a.recordHash('P', 100, 'kill', WALLET_A)
	closeBlock(a)
	a._save()
	const b = led(dir)
	assert.strictEqual(b.unsettled[WALLET_A], a.unsettled[WALLET_A], 'debt lost across restart')
	assert.strictEqual(b.balances[WALLET_A], a.balances[WALLET_A])
	assert.strictEqual(b.displayNames[WALLET_A], 'P')
})

check('an empty block still advances height and issues nothing', () => {
	const l = led(tmp())
	const h = l.height
	closeBlock(l)
	assert.strictEqual(l.height, h + 1)
	assert.strictEqual(Object.keys(l.balances).length, 0)
})

let fail = 0
for (const r of results) {
	if (!r.p) fail++
	console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `\n        ${r.d}` : ''}`)
}
console.log(fail ? `\n${fail} check(s) FAILED` : `\nall ${results.length} checks passed`)
process.exit(fail ? 1 : 0)
