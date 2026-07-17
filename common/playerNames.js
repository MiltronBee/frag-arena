// Short military/callsign-style player names (ALL CAPS). Indexed by nameIndex
// (UInt8 on the wire); assigned round-robin server-side to humans + bots, then
// resolved to a floating overhead nametag on the client.
export const PLAYER_NAMES = [
	'GHOST', 'VIPER', 'ACE', 'NOVA', 'REX',
	'ECHO', 'BLADE', 'STORM', 'HAWK', 'TITAN',
	'ZERO', 'LYNX', 'WOLF', 'CRANE', 'APEX',
	'BOLT', 'FROST', 'PIKE', 'ROGUE', 'SHADOW',
	'TALON', 'FURY', 'SABLE', 'SCOUT', 'DUSK',
	'NEON', 'GLITCH', 'PIXEL', 'EMBER', 'CIPHER',
]

export const HUMAN_NAME_SENTINEL = 30 // nameIndex value meaning "human; real name comes via PlayerName message"

export function sanitizeName(raw) {
	return (raw || '').toUpperCase().replace(/[^A-Z0-9_\-]/g, '').slice(0, 12) || 'PLAYER'
}

export function encodeName(msg, name) {
	const safe = sanitizeName(name)
	for (let i = 0; i < 12; i++) msg['c' + i] = safe.charCodeAt(i) || 0
}

export function decodeName(msg) {
	let s = ''
	for (let i = 0; i < 12; i++) { const c = msg['c' + i]; if (!c) break; s += String.fromCharCode(c) }
	return s || 'PLAYER'
}
