// THE CODEX — the whitepaper, restructured as a Mass Effect-style reference terminal:
// a list of entries on the left, a reader on the right, and a narrator that reads the
// selected entry aloud.
//
// WHY DATA AND NOT MARKUP: the old whitepaper was five <div class="info-section"> blocks
// hardcoded in index.html. Narration needs the prose as strings (you cannot hand innerHTML
// to a speech synthesiser and get a sentence back), the reader needs to paginate it, and
// the entry list needs titles without scraping <h3>s. One array serves all three.
//
// `vo` is a path to a recorded read of the entry, rendered ONCE at author time by
// scripts/generate-codex-vo.mjs in the Chavita voice. The narrator prefers it and only
// falls back to the browser's speech synthesis if a file is missing.
//
// These used to be null, and the fallback WAS the shipping behaviour: every player who
// pressed LISTEN re-synthesised the entry on their own machine, in whatever voice their
// OS happened to have, differently on every platform, and not at all where the API is
// absent or muted. A codex that reads itself aloud should sound the same to everyone.
//
// CATEGORY drives the grouping in the entry list. Order within a category is the order
// here, so this array is also the reading order.

export const CODEX_CATEGORIES = [
	{ id: 'arena', label: 'THE ARENA' },
	{ id: 'economy', label: 'THE ECONOMY' },
	{ id: 'bench', label: 'FRAGBENCH' },
]

export const CODEX_ENTRIES = [
	{
		id: 'the-game',
		category: 'arena',
		kicker: 'PRIMARY',
		title: 'The Game',
		vo: '/assets/vo/codex/the-game.mp3',
		body: [
			'A browser-native arena shooter in the late-nineties lineage. Forty-hertz server-authoritative netcode, client-side prediction, and lag-compensated hitscan — the same architecture the genre settled on, running inside a tab with nothing to install.',
			'Five imported arenas. Team Deathmatch, Free-For-All, and Capture the Flag, with sudden-death overtime. A-star bots that pathfind, dodge, and contest objectives, so the arena is never empty and never a walkover.',
		],
	},
	{
		id: 'the-arsenal',
		category: 'arena',
		kicker: 'ORDNANCE',
		title: 'The Arsenal',
		vo: '/assets/vo/codex/the-arsenal.mp3',
		body: [
			'Everyone spawns with the Pistol. Nothing else spawns on the arena floor.',
			'This is the Season One rule, and it is the whole economy in one sentence: the rifle, the SMG, the shotgun and the sniper are carried in by the people who own them. There are no free pickups for anything above a sidearm.',
			'What you carry, you can lose. Die holding a weapon and it drops where you fell, for whoever put you there. Ownership decides what enters the arena; the fight decides who leaves with it.',
		],
	},
	{
		id: 'the-cloth',
		category: 'arena',
		kicker: 'PLATE',
		title: 'The Cloth',
		vo: '/assets/vo/codex/the-cloth.mp3',
		body: [
			'Armour is worn as a single finish — Gold, Silver, Ebony, or Solana. A set is five pieces: helm, cuirass, pauldron, joint cap, sabaton.',
			'No mixing. A half-gold, half-ebony set reads as a bug rather than as a choice, so the protocol cannot express one. You may wear an incomplete set of a finish you hold; you may not wear two finishes at once.',
			'The Cloth is cosmetic. It changes nothing about how much damage you take, and it never will.',
		],
	},
	{
		id: 'proof-of-blood',
		category: 'economy',
		kicker: 'ISSUANCE',
		title: 'Proof of Blood',
		vo: '/assets/vo/codex/proof-of-blood.mp3',
		body: [
			'Bitcoin’s issuance, mirrored at a hundred times the clock, with frags as hashpower.',
			'Every ten minutes a block closes. Kills mine hash; objectives mine more. When the block closes, its reward splits proportionally to hash share — a mining-pool payout, not a leaderboard prize. Contribute a tenth of the hash in a window and you take a tenth of the block.',
			'The reward starts at five thousand and halves every two thousand one hundred and sixty blocks, roughly every fifteen days. The schedule converges on a mined supply of twenty-one and a half million: a true twenty-one-million mirror on an accelerated clock.',
			'An empty block issues nothing, but height still advances — exactly as an empty block does on Bitcoin. Time does not wait for you to earn.',
		],
	},
	{
		id: 'never-power',
		category: 'economy',
		kicker: 'CONSTRAINT',
		title: 'Never Power',
		vo: '/assets/vo/codex/never-power.mp3',
		body: [
			'Tokens will never buy stats. Not damage, not health, not accuracy, not speed.',
			'Ownership decides what you may carry into the arena and what you look like carrying it. It does not decide who wins the duel. The moment a wallet can buy an advantage the benchmark stops measuring skill and starts measuring balance — and the benchmark is the point.',
		],
	},
	{
		id: 'fragbench',
		category: 'bench',
		kicker: 'BENCHMARK',
		title: 'FragBench',
		vo: '/assets/vo/codex/fragbench.mp3',
		body: [
			'The game doubles as a live benchmark for language models. Any program can connect to the sanctioned agent endpoint and drive a real player down the same authority path a human uses. No special access, no privileged physics.',
			'The split is strategist and controller. Your model makes low-rate tactical calls — roughly one per second, because deciding faster than you can observe buys nothing. A reference controller, identical for every entrant, executes at forty hertz. The result measures the model, not the aim script.',
			'Entrants report a model identifier, and the ladder ranks by model. A pairwise Elo ladder runs alongside the token: ratings are separate from wealth, because being rich and being good are different claims.',
		],
	},
	{
		id: 'house-rules',
		category: 'bench',
		kicker: 'PROTOCOL',
		title: 'House Rules',
		vo: '/assets/vo/codex/house-rules.mp3',
		body: [
			'The server is authoritative. The gateway accepts an intent surface and ignores everything else in a frame.',
			'One socket is one player. Disconnecting removes your body from the match.',
			'Humans always get the seat first. Seats are limited, and when silicon and a person want the same slot, the person takes it. That is a rule of the arena, not a bug in the queue.',
		],
	},
	{
		id: 'the-flywheel',
		category: 'bench',
		kicker: 'THESIS',
		title: 'The Flywheel',
		vo: '/assets/vo/codex/the-flywheel.mp3',
		body: [
			'Agent builders want to rank, so they connect bots. Strong bots populate the arena. Humans get better fighting them. The crowd grows, and so do the stakes.',
			'The benchmark is the marketing. The economy is the scoreboard. The game is the point.',
		],
	},
]

/** Flat lookup by id — the reader routes on `#/codex/<id>`. */
export function codexEntry(id) {
	return CODEX_ENTRIES.find((e) => e.id === id) || null
}

/**
 * The plain-prose read of an entry, for the narrator.
 *
 * Joined with a pause-length gap rather than a bare space: speech synthesis runs
 * paragraphs together otherwise, and the whole point of a narrated codex is that it sounds
 * like someone reading rather than a buffer being flushed.
 */
export function codexNarration(entry) {
	if (!entry) return ''
	return [entry.title, ...entry.body].join('. \n\n')
}
