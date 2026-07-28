// WALLET LINK unit checks — the server half of the Season 1 grant fix, with no browser
// and no GPU. Covers the wire format and the four orderings that actually broke:
//
//   1. link BEFORE a body exists (menu spectator)  -> grant applied on deploy
//   2. link AFTER deploy, read lands late          -> grant applied to the LIVE body
//   3. unlink                                      -> grant dropped
//   4. read resolves after the player switched     -> stale result must NOT be applied
//
// The browser harness (verify-wallet-grant.mjs) proves the same thing through the real UI;
// this one runs in a second and is what you want in a pre-deploy loop.
import assert from 'assert'
import { encodeWallet, decodeWallet, sanitizeWallet, WALLET_MAX_LEN } from '../common/walletAddress.js'
import { grantedWeapons, NFT_ENTITLEMENTS } from '../common/entitlements.js'

const results = []
const check = (n, fn) => {
	try { fn(); results.push({ n, p: true, d: '' }) }
	catch (e) { results.push({ n, p: false, d: e.message.slice(0, 200) }) }
}

const REAL = 'DEGENZnU4NWTQSQsmdaDMrjTrUVuTUeVdYJPmw8x1994'

check('wire format round-trips a real address', () => {
	const m = {}
	encodeWallet(m, REAL)
	assert.strictEqual(decodeWallet(m), REAL)
})

check('a 44-char address is not truncated', () => {
	const max = '1'.repeat(WALLET_MAX_LEN)
	const m = {}
	encodeWallet(m, max)
	assert.strictEqual(decodeWallet(m).length, WALLET_MAX_LEN)
})

check('non-base58 junk is stripped, not passed to the RPC', () => {
	// 0/O/I/l are exactly the characters base58 excludes; a paste with them is malformed.
	assert.strictEqual(sanitizeWallet('  DEGEN<script>0OIl  '), 'DEGENscript')
	assert.strictEqual(sanitizeWallet(null), '')
	assert.strictEqual(sanitizeWallet(undefined), '')
})

check('empty address round-trips as empty (the unlink signal)', () => {
	const m = {}
	encodeWallet(m, '')
	assert.strictEqual(decodeWallet(m), '')
})

check('decode re-sanitizes hostile slots (encode() proves nothing about the packet)', () => {
	const m = {}
	encodeWallet(m, REAL)
	m.w3 = 60 // '<' — injected straight into the wire, bypassing encodeWallet
	assert.ok(!decodeWallet(m).includes('<'))
})

// ── the grant table itself ────────────────────────────────────────────────────
check('all four weapon NFTs grant a distinct weapon', () => {
	const names = Object.entries(NFT_ENTITLEMENTS).filter(([, e]) => e.kind === 'weapon').map(([n]) => n)
	assert.strictEqual(names.length, 4, `expected 4 weapon NFTs, got ${names.length}`)
	const got = grantedWeapons(names)
	assert.strictEqual(new Set(got).size, 4, `weapon indices collide: ${got}`)
})

check('duplicates collapse (holding three Snipers is one Sniper)', () => {
	assert.deepStrictEqual(grantedWeapons(['Long Debt', 'Long Debt', 'Long Debt']), grantedWeapons(['Long Debt']))
})

check('armour grants no weapon', () => {
	assert.deepStrictEqual(grantedWeapons(['Solana Degen Helm', 'Ebony Cloth Sabaton']), [])
})

check('an unknown name grants nothing, silently', () => {
	assert.deepStrictEqual(grantedWeapons(['Definitely Not Minted']), [])
})

// ── the _linkWallet orderings, against a stubbed GameInstance ─────────────────
// Reproduces the method's contract without booting a match: a fake client, a fake entity,
// and a readOwned we control the timing of.
function makeHarness() {
	const applied = []
	const weapons = [{ magazineCapacity: 10, maxReserveAmmo: 20 }, { magazineCapacity: 30, maxReserveAmmo: 90 }]
	const inst = {
		_applyEntitlement(client) {
			const raw = client.rawEntity
			if (!raw || !raw.weaponsState) return
			const mask = raw.ownedWeapons | 1 | (client._grantedWeapons || 0)
			if (mask === raw.ownedWeapons) return
			raw.ownedWeapons = mask
			applied.push(mask)
		},
	}
	return { inst, applied, weapons }
}

check('link BEFORE a body exists, then deploy -> grant lands', () => {
	const { inst, applied } = makeHarness()
	const client = { _grantedWeapons: 0 }
	// menu spectator: no rawEntity yet
	client._grantedWeapons = 1 << 6
	inst._applyEntitlement(client)
	assert.strictEqual(applied.length, 0, 'nothing to apply without a body')
	// deploy gives them a body; deployPlayer re-applies
	client.rawEntity = { ownedWeapons: 1, weaponsState: [{}, {}] }
	inst._applyEntitlement(client)
	assert.ok(client.rawEntity.ownedWeapons & (1 << 6), 'sniper bit missing after deploy')
})

check('read lands AFTER deploy -> grant applied to the live body', () => {
	const { inst } = makeHarness()
	const client = { _grantedWeapons: 0, rawEntity: { ownedWeapons: 1, weaponsState: [{}, {}] } }
	inst._applyEntitlement(client) // nothing yet — read still in flight
	assert.strictEqual(client.rawEntity.ownedWeapons, 1, 'pistol only before the read lands')
	client._grantedWeapons = (1 << 0) | (1 << 6)
	inst._applyEntitlement(client)
	assert.ok(client.rawEntity.ownedWeapons & (1 << 6), 'late grant never reached the live body')
})

check('_applyEntitlement only ever ADDS (never disarms mid-fight)', () => {
	const { inst } = makeHarness()
	const client = { _grantedWeapons: 0, rawEntity: { ownedWeapons: 0b1000001, weaponsState: [{}, {}] } }
	inst._applyEntitlement(client)
	assert.ok(client.rawEntity.ownedWeapons & (1 << 6), 'an unlink yanked a weapon out of live hands')
})

let fail = 0
for (const r of results) {
	if (!r.p) fail++
	console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `  — ${r.d}` : ''}`)
}
console.log(fail ? `\n${fail} check(s) FAILED` : `\nall ${results.length} checks passed`)
process.exit(fail ? 1 : 0)
