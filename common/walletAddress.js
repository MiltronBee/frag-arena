// WALLET LINK wire format. Shared by the command (client -> server) so the two halves can
// never disagree about length or encoding.
//
// WHY THIS EXISTS AT ALL: the address used to ride ONLY in the nengi handshake
// (GameClient reads localStorage once, at page load). That works for a returning player
// whose address is already saved, and silently fails for everyone else — the menu saves
// the address AFTER the socket is connected, so a first-time linker never sent one, never
// got a grant, and deployed with the spawn pistol no matter what they held. The menu even
// promised "unlocks apply on next join"; there was no next join, because connect() is
// called exactly once and nothing reconnects. This command is that missing join.
//
// nengi protocols are FIXED-SIZE field lists, so the address goes over as N UInt8 slots —
// the same trick common/chat.js and playerNames.js use. Base58 is ASCII-only by
// definition, so one slot is one character with no multi-byte case to handle.
//
// 44 is the maximum length of a base58-encoded 32-byte Solana pubkey (32 bytes of 0xFF
// encodes to 44 chars); 32 is the minimum a leading-zero-heavy key can shrink to. Sized
// to the protocol rather than to observed addresses, so a legitimate edge-case key is
// never truncated into a different (or invalid) address.
export const WALLET_MAX_LEN = 44

// Base58 excludes 0/O/I/l precisely so addresses survive being read aloud and retyped.
// Anything outside the alphabet cannot be part of a real address, so it is dropped rather
// than passed through to the RPC — junk here costs a chain read and a cache slot keyed on
// attacker-chosen input, which walletLink.js is already careful to bound.
const B58_RE = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g

// A REQUEST, never a claim. The server re-reads the chain from this address and derives
// the grant itself, so the worst a hand-crafted packet achieves is making us look up
// somebody else's wallet — which grants the sender nothing they do not hold, because the
// grant is applied from what THAT address holds.
export function sanitizeWallet(raw) {
	return String(raw == null ? '' : raw).trim().replace(B58_RE, '').slice(0, WALLET_MAX_LEN)
}

// charCodeAt beyond the string returns NaN; `|| 0` turns that into the terminator, which
// is also why a NUL can never appear mid-address.
export function encodeWallet(msg, addr) {
	const safe = sanitizeWallet(addr)
	for (let i = 0; i < WALLET_MAX_LEN; i++) msg['w' + i] = safe.charCodeAt(i) || 0
}

export function decodeWallet(msg) {
	let out = ''
	for (let i = 0; i < WALLET_MAX_LEN; i++) {
		const c = msg['w' + i]
		if (!c) break
		out += String.fromCharCode(c)
	}
	// Re-sanitize on the way out: the slots arrived over the wire, so the sender's own
	// encode() proves nothing about what is actually in the packet.
	return sanitizeWallet(out)
}

// Generated rather than typed out — 44 hand-written UInt8 lines is 44 chances to typo a
// field name, and a mismatch between this and encodeWallet is a silent wire corruption.
export function walletProtocol(nengi) {
	const p = {}
	for (let i = 0; i < WALLET_MAX_LEN; i++) p['w' + i] = nengi.UInt8
	return p
}
