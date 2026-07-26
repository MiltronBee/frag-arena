// BOT SKILL, PERSONALITY & AIM ERROR — ported from UT99's own bot brain.
//
// PROVENANCE. The shape of this model and most of its constants are Epic's, read
// out of the UnrealScript embedded in the shipped Botpack.u (UT99 GOTY + OldUnreal
// 469e, /mnt/echostore/ut99-thesis): `Bot.AdjustAim`, `Bot.InitializeSkill`,
// `Bot.ReSetSkill`, `Bot.FaceDestination` and `ChallengeBotInfo.CHIndividualize` /
// `.AdjustSkill`. Where we deviate it is called out inline and the reason given.
//
// WHY PORT INSTEAD OF INVENT. Our bots aimed with a CONSTANT ±0.055 rad error
// re-rolled once per burst. Constant error means the player's movement — the entire
// skill expression of an arena shooter — changed nothing about how often they got
// hit. Strafing, jumping and juking were cosmetic. Epic solved this in 1999 with one
// line (the relative-motion term below), and the rest of their model is a catalogue
// of the moments a bot should be WORSE: just after spotting you, just after being
// hit, while anyone is airborne. Those moments are exactly the ones a player reads as
// "I outplayed it" rather than "the computer decided I die now".
//
// THE DESIGN GOAL IS NOT DIFFICULTY. A bot that never misses is trivial to write and
// miserable to play; the point of every term here is to make bots lose in ways that
// feel earned, and win in ways that feel readable.

// ── skill ────────────────────────────────────────────────────────────────────
// UT99's scale exactly: 0..7, where 0-3 is the "novice" band (a different, gentler
// error curve) and 4-7 is the skilled band. InitializeSkill splits it the same way,
// which is why `band` below subtracts 4 rather than rescaling — the two curves are
// genuinely different functions, not one curve with a steeper slope.
export const MAX_SKILL = 7
export const SKILL_NAMES = ['Novice', 'Average', 'Experienced', 'Skilled', 'Adept', 'Masterful', 'Inhuman', 'Godlike']

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export const skillBand = (skill) => {
	const s = clamp(skill, 0, MAX_SKILL)
	const novice = s < 4
	return { novice, band: clamp(novice ? s : s - 4, 0, 3) }
}

// ── aim error ────────────────────────────────────────────────────────────────
// Base angular error per skill level, radians, measured at a stationary target — the
// spine of the model, before any situational multiplier. This is a TABLE rather than
// Epic's formula on purpose: their two-band curve (`2.4 - 0.2*(skill+FRand)` /
// `1.7 - 0.4*(skill+FRand)`) is expressed in Unreal rotator units against per-weapon
// error bases we do not have, and porting the numbers literally produced a roster that
// was 100% accurate at the top of the scale and 0% at the bottom — the exact "too good
// is unplayable" failure, plus its useless mirror image. The SHAPE is kept (a gentle
// low end, a steep middle, a top that is frightening but still misses); the numbers are
// ours, calibrated against the measured hit rates in scripts/measure-bot-aim.ts.
//
// Read these against the target's angular size: our hit capsule is 0.36 units wide, so
// at a 14-unit duel it subtends ~0.026 rad. An error at or under that lands.
const SKILL_AIM_ERR = [0.070, 0.058, 0.048, 0.040, 0.033, 0.027, 0.023, 0.019]

// Per-shot spread around that base (Epic's FRand term, kept). This is why a bot is not
// a step function: the same bot at the same skill has good shots and bad ones, so a
// player can win an exchange they statistically should have lost — and those are the
// exchanges people remember.
const SHOT_VARIANCE = 0.8   // multiplier lands in [0.6, 1.4], mean 1.0

// TRACKING DIFFICULTY — our replacement for Epic's `aimerror * (11 - 10*dot(...))`.
//
// Epic compares the direction to the target against the direction to
// `Target.Location + 1.25 * Velocity`: a target crossing the view scores a low dot and
// multiplies the error, a target moving along the view costs nothing. The INTENT is
// exactly right and it is the single most important idea in their bot — it is why
// strafing works in UT99 — but the literal form does not survive the move to our scale.
// Their 1.25-second lookahead is short against UT's engagement distances; against ours
// it is often LONGER than the whole duel, so the predicted point overshoots past the
// bot and the dot flips negative. Measured symptom: a player charging straight at a bot
// (the easiest possible shot, and Epic's own dot would score it ~1.0) came out as
// maximally evasive, and bots hit it 0.9% of the time.
//
// So we measure the thing their dot is a proxy for: ANGULAR velocity — how fast the bot
// must swing its aim to stay on you, in rad/s. That is well-behaved at every distance,
// it keeps both of Epic's properties (crossing motion is punished, closing motion is
// not; the same speed is harder to track up close because it subtends more angle), and
// it cannot invert.
const TRACK_GAIN = 1.15     // per rad/s of angular velocity
const TRACK_MAX = 2.6       // ceiling: a bot should be beatable by movement, not blind

// UT99 penalises a freshly acquired target with a flat 2x, applied ONCE (AdjustAim
// rewinds LastAcquireTime so the branch cannot retrigger). A single wild shot is not
// enough here: our bots hold the trigger through a burst rather than firing one
// projectile per decision, so a one-shot penalty vanishes into the burst. We spread
// the same 2x over a decaying window instead — full at the instant of acquisition,
// gone by ACQUIRE_MS. Same intent, adapted to a continuous-fire game: you get a moment
// to react to being spotted, which is the difference between a firefight and an ambush.
const ACQUIRE_PENALTY = 2.0
const ACQUIRE_MS_BASE = 2500     // UT99: `LastAcquireTime > TimeSeconds - 2.5 + skill`
const ACQUIRE_MS_PER_SKILL = 250 // higher skill locks on sooner

// "Bots don't aim as well if recently hit, or if they or their target is flying
// through the air" — Bot.uc. Shooting back and dodge-jumping degrade their aim, which
// is the mechanical justification for doing either.
const PAIN_MS = 200              // UT99: LastPainTime < 0.2
const PAIN_PENALTY = 1.5
const AIRBORNE_PENALTY = 1.3

// Per-shot reaction delay before a bot may fire at a NEWLY acquired target. UT99 has
// no explicit reaction time (it falls out of turn rate + the acquire error); later
// Unreal engines added one, and we need it because our bots turn faster relative to
// our arena's sightlines. Without it a bot that rounds a corner fires in the same tick
// it sees you, which reads as a cheat even when the shot misses.
const REACTION_MS_BASE = 520
const REACTION_MS_PER_SKILL = 55

// Returns the angular aim error (radians) for this instant. Every argument is a live
// measurement, so the number moves DURING a fight — the bot's aim visibly widens the
// moment you start moving laterally, and tightens when you stand still.
export function aimError(p) {
	const { novice, band } = skillBand(p.skill)
	// 1. the skill baseline, plus Epic's per-shot randomness
	const s = clamp(Math.round(p.skill), 0, MAX_SKILL)
	let err = SKILL_AIM_ERR[s] * (1 - SHOT_VARIANCE / 2 + SHOT_VARIANCE * p.rand())

	// 2. how hard the target is to TRACK right now (see TRACK_GAIN)
	err *= clamp(1 + TRACK_GAIN * (p.angularVel || 0), 1, TRACK_MAX)

	// 3. instant-hit weapons carry their own curve, kept from Epic. Counterintuitively
	//    it GROWS with skill (0.5 -> 1.07): it exists to stop high-skill bots from
	//    turning hitscan into a death sentence, and the baseline still nets them ahead.
	if (p.hitscan) err *= novice ? 0.75 : (0.75 + 0.1 * band)

	// 4. freshly acquired target — decaying, see ACQUIRE_PENALTY
	const acquireWindow = Math.max(400, ACQUIRE_MS_BASE - ACQUIRE_MS_PER_SKILL * p.skill)
	if (p.acquiredAgo < acquireWindow) {
		const t = 1 - p.acquiredAgo / acquireWindow
		err *= 1 + (ACQUIRE_PENALTY - 1) * t
	}

	// 5. hurt, or anyone airborne
	if (p.painAgo < PAIN_MS) err *= PAIN_PENALTY
	if (p.airborne) err *= AIRBORNE_PENALTY

	// 6. the bot's own accuracy trait (UT99: `aimerror -= aimerror * accuracy`)
	err -= err * p.accuracy

	return Math.max(0, err)
}

// Angular velocity of the target across the bot's view, rad/s — how fast the bot has to
// swing to stay on you. RELATIVE velocity, so a bot that strafes WITH you tracks you
// better; mirroring your movement is a real counter, exactly as it is between humans.
// Only the component PERPENDICULAR to the line of sight counts — closing straight in
// changes range, not angle, and range is not what makes a shot hard.
export function angularVelocity(me, target) {
	const dx = target.x - me.x, dy = target.y - me.y, dz = target.z - me.z
	const d = Math.hypot(dx, dy, dz)
	if (d < 0.5) return 0
	const rvx = (target.velX || 0) - (me.velX || 0)
	const rvy = (target.velY || 0) - (me.velY || 0)
	const rvz = (target.velZ || 0) - (me.velZ || 0)
	// strip the component along the line of sight; what remains is what moves the angle
	const along = (rvx * dx + rvy * dy + rvz * dz) / d
	const px = rvx - along * dx / d
	const py = rvy - along * dy / d
	const pz = rvz - along * dz / d
	return Math.hypot(px, py, pz) / d
}

export const reactionMs = (skill, alertness) =>
	Math.max(90, (REACTION_MS_BASE - REACTION_MS_PER_SKILL * skill) * (1 - 0.35 * alertness))

// UT99: `ReFireRate = Default.ReFireRate * (1 - 0.25 * skill)` for the skilled band.
// Higher skill = shorter pauses between bursts, so pressure scales with skill and not
// only accuracy — a Godlike bot should feel relentless, not just precise.
export const refireScale = (skill) => {
	const { novice, band } = skillBand(skill)
	return novice ? 1 : (1 - 0.22 * band)
}

// ── personality ──────────────────────────────────────────────────────────────
// UT99 gives every named bot a row in ChallengeBotInfo (BotAccuracy, CombatStyle,
// Alertness, Camping, StrafingAbility, Jumpy, FavoriteWeapon) and CHIndividualize
// stamps them onto the bot at spawn. That table — not the skill number — is why a UT
// lobby feels like a room full of people instead of eight copies of one opponent. One
// of them rushes you every time, one hangs back with the sniper, one is a coward, and
// you learn their names.
//
// We do not have Epic's table (it ships as binary class defaults, not as script), so
// these are ours, authored against the ranges their code implies: accuracy -1..1,
// combatStyle 0..1 (used by Epic as a charge probability), alertness/camping/strafing
// 0..1, jumpy boolean.
export const ARCHETYPES = [
	// label        accuracy combatStyle alertness camping strafing jumpy skillBias
	{ label: 'rusher',   accuracy: -0.06, combatStyle: 0.85, alertness: 0.80, camping: 0.05, strafing: 0.55, jumpy: true,  skillBias: 0 },
	{ label: 'duelist',  accuracy: 0.14,  combatStyle: 0.55, alertness: 0.70, camping: 0.15, strafing: 0.85, jumpy: true,  skillBias: +1 },
	{ label: 'sniper',   accuracy: 0.20,  combatStyle: 0.15, alertness: 0.55, camping: 0.70, strafing: 0.20, jumpy: false, skillBias: 0 },
	{ label: 'grunt',    accuracy: -0.03, combatStyle: 0.50, alertness: 0.45, camping: 0.25, strafing: 0.45, jumpy: false, skillBias: -1 },
	{ label: 'coward',   accuracy: -0.13, combatStyle: 0.10, alertness: 0.60, camping: 0.55, strafing: 0.60, jumpy: true,  skillBias: -1 },
	{ label: 'berserker',accuracy: -0.16, combatStyle: 1.00, alertness: 0.90, camping: 0.00, strafing: 0.35, jumpy: true,  skillBias: +1 },
]

// The FragBench entrant profile: a fixed, UN-JITTERED, dead-centre personality. Every
// agent must get the SAME controller characteristics or the benchmark is measuring the
// dice as well as the model — two entrants with identical strategies would post
// different scores because one drew a better strafer. Deliberately not an archetype.
export const NEUTRAL_PERSONALITY = Object.freeze({
	label: 'entrant',
	accuracy: 0, combatStyle: 0.5, alertness: 0.5,
	camping: 0.2, strafing: 0.5, jumpy: false, skillBias: 0,
})

// Deal archetypes round-robin rather than at random: eight bots rolled independently
// are, more often than not, four of the same thing. A player should meet a spread.
export function personalityFor(index) {
	const a = ARCHETYPES[index % ARCHETYPES.length]
	// A little jitter so two rushers are not identical twins, but never enough to blur
	// the archetype — the point is that they stay recognisable across a match.
	const j = (scale) => (Math.random() - 0.5) * scale
	return {
		label: a.label,
		accuracy: clamp(a.accuracy + j(0.08), -1, 1),
		combatStyle: clamp(a.combatStyle + j(0.15), 0, 1),
		alertness: clamp(a.alertness + j(0.15), 0, 1),
		camping: clamp(a.camping + j(0.15), 0, 1),
		strafing: clamp(a.strafing + j(0.15), 0, 1),
		jumpy: a.jumpy,
		skillBias: a.skillBias,
	}
}

// ── dynamic difficulty ───────────────────────────────────────────────────────
// A direct port of ChallengeBotInfo.AdjustSkill, which is UT99's answer to the exact
// failure the brief names: a bot that is too good is unplayable. Epic's fix is not to
// pick the right difficulty up front — it is to stop trying, and converge on it.
//
// After any kill involving a human, the target difficulty moves toward the level at
// which the human trades evenly. The step is 2/min(n,10), so it moves in whole levels
// early (converging within a handful of deaths) and in 0.2 steps later (settling
// instead of oscillating). Clamped to the 0..7 skill scale.
//
// Epic only nudges the bot that was actually involved; a roster therefore drifts into a
// spread around the target rather than snapping to one number, which preserves the
// personality mix while still bounding the top end.
export class DifficultyDirector {
	constructor(start) {
		this.difficulty = clamp(start, 0, MAX_SKILL)
		this.humanKills = 0   // humans killing bots -> push difficulty UP
		this.botKills = 0     // bots killing humans -> pull difficulty DOWN
	}

	// The human killed a bot: they are ahead, so the arena should push back harder.
	humanScored() {
		this.humanKills++
		this.difficulty = clamp(this.difficulty + 2 / Math.min(this.humanKills, 10), 0, MAX_SKILL)
		return this.difficulty
	}

	// A bot killed the human: ease off. Epic's asymmetry is deliberate and worth
	// keeping — the counters are independent, so a long session settles at the level
	// where the two pressures cancel, which IS "an even fight" by definition.
	botScored() {
		this.botKills++
		this.difficulty = clamp(this.difficulty - 2 / Math.min(this.botKills, 10), 0, MAX_SKILL)
		return this.difficulty
	}
}
