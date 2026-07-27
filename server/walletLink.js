// READ-ONLY wallet link. A player pastes a Solana address; we read which Degen
// Tournament NFTs it holds and grant the matching weapons. We never connect a wallet,
// never request a signature, never hold a key, and never send a transaction.
//
// WHY NOT HELIUS DAS (which solMTG's api/src/routes/wallet.js uses): DAS indexes
// arbitrary collections, which solMTG needs because it reads whatever a player happens to
// own. We only ever read OUR OWN collection, and a Core asset stores its owner and its
// collection at fixed byte offsets — so a single getProgramAccounts with two memcmp
// filters answers the question exactly, on the FREE public RPC, with no API key. (The
// Helius key in solMTG/.env is dead anyway — 401.)
//
// Dependency-free on purpose: the game server has no solana packages and this is on the
// join path, so it is raw JSON-RPC plus ~30 lines of base58 rather than pulling in web3.js.
//
// AssetV1 account layout (mpl-core):
//   0      u8      key (1 = AssetV1)
//   1..33  Pubkey  owner
//   33     u8      update authority kind (0 None, 1 Address, 2 Collection)
//   34..66 Pubkey  that authority (the COLLECTION, for our assets)
//   66     u32 LE  name length, then utf8 name
//   ...            uri, then the plugin tail (not parsed — we only need the name)
import { COLLECTION_MAINNET, MPL_CORE_PROGRAM, grantedWeapons } from '../common/entitlements.js'

// MAINNET IS THE DEFAULT as of 2026-07-26, when Season 1 minted for real. Both were
// devnet defaults before that; leaving them meant a live holder read the wrong chain,
// found nothing, and spawned with a pistol — a silent failure with no error anywhere.
// Defaulting to the live network means a forgotten env var cannot cause that.
// Override both together (they must agree) to point a dev server at devnet.
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
const COLLECTION = process.env.DEGEN_COLLECTION || COLLECTION_MAINNET
const TTL_MS = 60_000
const MAX_CACHE = 2000
// 6s was fine on devnet, where mpl-core holds a handful of accounts. On MAINNET the same
// getProgramAccounts scan is over millions of Core assets and measured ~24s on the public
// RPC — so the old timeout aborted every single read and no holder was ever granted
// anything. There was no error surfaced anywhere; they simply spawned with a pistol.
//
// A generous timeout is safe here precisely because this call is off the critical path:
// the socket is already accepted, nothing waits on it, and both the deploy path and this
// promise's own callback apply the grant whenever it lands. Slow costs a late grant, not
// a blocked join. Point SOLANA_RPC at a paid endpoint to make it fast.
const RPC_TIMEOUT_MS = Number(process.env.WALLET_RPC_TIMEOUT_MS || 45000)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function b58decode(str) {
  const bytes = [0]
  for (const ch of str) {
    const v = B58.indexOf(ch)
    if (v < 0) return null
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0)
  return Uint8Array.from(bytes.reverse())
}

function b58encode(bytes) {
  const digits = [0]
  for (const b of bytes) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = ''
  for (const b of bytes) { if (b) break; out += '1' }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]]
  return out
}

/** Cheap shape check. Rejects junk BEFORE it can become a cache key or burn an RPC call. */
export function isLikelyAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false
  const b = b58decode(s)
  return !!b && b.length === 32
}

// Bounded LRU-ish cache. Bounded because the address is attacker-chosen: an unbounded map
// keyed on arbitrary input is a memory-exhaustion vector, and each miss costs an RPC call.
const cache = new Map()
function cacheGet(k) {
  const hit = cache.get(k)
  if (!hit) return null
  if (Date.now() - hit.ts > TTL_MS) { cache.delete(k); return null }
  return hit.payload
}
function cacheSet(k, payload) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(k, { ts: Date.now(), payload })
}

// Per-IP token bucket — an unauthenticated GET that fans out to an RPC needs a ceiling.
const buckets = new Map()
export function rateLimit(key, limit = 30, windowMs = 60_000) {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now - b.start > windowMs) { buckets.set(key, { start: now, n: 1 }); return true }
  if (b.n >= limit) return false
  b.n++
  return true
}

async function rpc(method, params) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS)
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'frag', method, params }),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`rpc ${r.status}`)
    const j = await r.json()
    if (j.error) throw new Error(j.error.message || 'rpc error')
    return j.result
  } finally { clearTimeout(t) }
}

/**
 * Every asset of OUR collection held by `address`.
 * Returns { address, collection, names, weapons, count } or throws.
 */
export async function readOwned(address) {
  const cached = cacheGet(address)
  if (cached) return cached

  const owner = b58decode(address)
  const coll = b58decode(COLLECTION)
  if (!owner || !coll) throw new Error('bad address')

  // authority filter = [kind 2 = Collection, ...collection pubkey] as one 33-byte memcmp
  const authority = new Uint8Array(33)
  authority[0] = 2
  authority.set(coll, 1)

  const accounts = await rpc('getProgramAccounts', [MPL_CORE_PROGRAM, {
    encoding: 'base64',
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 1, bytes: b58encode(owner) } },
      { memcmp: { offset: 33, bytes: b58encode(authority) } },
    ],
  }])

  const names = []
  for (const a of accounts || []) {
    const raw = Buffer.from(a.account.data[0], 'base64')
    if (raw.length < 70 || raw[0] !== 1) continue          // not an AssetV1
    const len = raw.readUInt32LE(66)
    if (len === 0 || len > 128 || 70 + len > raw.length) continue
    names.push(raw.subarray(70, 70 + len).toString('utf8'))
  }

  const payload = {
    address,
    collection: COLLECTION,
    count: names.length,
    names,
    weapons: grantedWeapons(names),
  }
  cacheSet(address, payload)
  return payload
}

export const _internal = { b58decode, b58encode }
