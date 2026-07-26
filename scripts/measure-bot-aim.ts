// BOT AIM MEASUREMENT. Answers the only question that matters for "are these bots fun":
// does what the PLAYER does change how often they get hit?
//
// Method: drive a real BotController at the real 40Hz tick against a scripted target
// whose movement we control, and record the angular error at every tick the bot pulls
// the trigger. Angular error converts to a hit probability against the real hit capsule
// (CAPSULE_R = 0.36 from server/lagCompensatedHitscanCheck.js): a shot lands if the aim
// ray passes within that radius at the target's distance.
//
// No Babylon scene is needed. hasLineOfSight() returns true when the occluder array is
// empty, which is exactly the isolated firing-range condition we want — this measures
// the AIM MODEL, not the map.
import BotController from '../server/BotController'
import { personalityFor } from '../server/botSkill'

const CAPSULE_R = 0.36        // server/lagCompensatedHitscanCheck.js
const TICK_MS = 25            // 40Hz
const DT = TICK_MS / 1000

type Profile = 'stationary' | 'strafing' | 'strafing-fast' | 'jumping' | 'charging'

function makeEntity(x: number, y: number, z: number) {
	return {
		x, y, z, velX: 0, velY: 0, velZ: 0, grounded: true,
		isAlive: true, teamId: 1, hitpoints: 100,
		mesh: { position: { x, y, z } },
	}
}

// Move the target for one tick according to its profile. Speeds are in the game's own
// units (applyCommand's ground speed tops out around 7-8 u/s, so 7 is a real sprint).
function stepTarget(t: any, profile: Profile, tick: number, botX: number, botZ: number) {
	const phase = Math.floor(tick / 24) % 2 === 0 ? 1 : -1   // flip direction ~every 0.6s
	// perpendicular to the bot->target line, so "strafing" means across its view
	const dx = t.x - botX, dz = t.z - botZ
	const d = Math.hypot(dx, dz) || 1
	const px = -dz / d, pz = dx / d
	switch (profile) {
		case 'stationary':
			t.velX = 0; t.velZ = 0; t.velY = 0; t.grounded = true
			break
		case 'strafing':
			t.velX = px * 4.5; t.velZ = pz * 4.5
			break
		case 'strafing-fast':
			t.velX = px * 7.5 * phase; t.velZ = pz * 7.5 * phase
			break
		case 'jumping':
			t.velX = px * 4.5 * phase; t.velZ = pz * 4.5 * phase
			t.grounded = tick % 40 > 12
			t.velY = t.grounded ? 0 : 4
			break
		case 'charging':
			t.velX = -dx / d * 6; t.velZ = -dz / d * 6
			break
	}
	t.x += t.velX * DT; t.z += t.velZ * DT
	t.mesh.position.x = t.x; t.mesh.position.z = t.z
	// keep the duel at a workable distance so we measure aim, not pathing
	const nd = Math.hypot(t.x - botX, t.z - botZ)
	if (nd > 26 || nd < 5) {
		const k = (nd > 26 ? 26 : 5) / nd
		t.x = botX + (t.x - botX) * k
		t.z = botZ + (t.z - botZ) * k
		t.mesh.position.x = t.x; t.mesh.position.z = t.z
	}
}

// One run: returns shots fired, expected hits, and how long until the first shot.
function run(profile: Profile, skill: number, personalityIndex: number, seconds = 45) {
	const bot = makeEntity(0, 0, 0)
	bot.teamId = 0
	const target = makeEntity(0, 0, 14)
	const ctrl: any = new BotController(bot as any, 0, {
		skill, personality: personalityFor(personalityIndex),
	})
	let now = 10000
	let shots = 0, expectedHits = 0, firstShotTick = -1
	const ticks = Math.floor(seconds * 1000 / TICK_MS)

	for (let i = 0; i < ticks; i++) {
		stepTarget(target, profile, i, bot.x, bot.z)
		const cmd = ctrl.think(DT, now, [target], [])
		if (cmd.fireInput) {
			if (firstShotTick < 0) firstShotTick = i
			shots++
			// angle between the bot's aim ray and the true line to the target
			const dx = target.x - bot.x, dy = target.y - bot.y, dz = target.z - bot.z
			const d = Math.hypot(dx, dy, dz)
			const dot = (cmd.camRayX * dx + cmd.camRayY * dy + cmd.camRayZ * dz) / d
			const ang = Math.acos(Math.max(-1, Math.min(1, dot)))
			// a shot lands if the ray passes within the capsule radius at that range
			if (Math.sin(ang) * d <= CAPSULE_R) expectedHits++
		}
		now += TICK_MS
	}
	return {
		shots,
		hitRate: shots ? expectedHits / shots : 0,
		firstShotMs: firstShotTick < 0 ? -1 : firstShotTick * TICK_MS,
	}
}

// Average several runs — the model is stochastic by design (Epic's FRand), so one run
// is not a measurement.
function measure(profile: Profile, skill: number, runs = 8) {
	let shots = 0, hits = 0, firstMs = 0, firstN = 0
	for (let r = 0; r < runs; r++) {
		const res = run(profile, skill, r)
		shots += res.shots
		hits += res.hitRate * res.shots
		if (res.firstShotMs >= 0) { firstMs += res.firstShotMs; firstN++ }
	}
	return {
		hitRate: shots ? hits / shots : 0,
		shots,
		firstShotMs: firstN ? firstMs / firstN : -1,
	}
}

const PROFILES: Profile[] = ['stationary', 'strafing', 'strafing-fast', 'jumping', 'charging']
const pct = (v: number) => (v * 100).toFixed(1).padStart(5) + '%'

console.log('Bot hit-rate against a target doing different things (higher = deadlier bot)')
console.log('A player\'s movement SHOULD change these numbers. If every row is identical,')
console.log('movement is cosmetic and the duel is a coin flip.\n')
console.log('skill  ' + PROFILES.map(p => p.padStart(14)).join(''))
for (const skill of [0, 2, 3, 5, 7]) {
	const row = PROFILES.map(p => pct(measure(p, skill).hitRate).padStart(14)).join('')
	console.log(String(skill).padEnd(7) + row)
}

console.log('\nReaction: time from spotting the target to the first shot (ms)')
for (const skill of [0, 3, 7]) {
	console.log(`  skill ${skill}: ${measure('stationary', skill).firstShotMs.toFixed(0)}ms`)
}

console.log('\nThe spread that matters — stationary vs hard strafing, per skill:')
for (const skill of [0, 3, 5, 7]) {
	const stat = measure('stationary', skill).hitRate
	const strafe = measure('strafing-fast', skill).hitRate
	const delta = stat > 0 ? (1 - strafe / stat) * 100 : 0
	console.log(`  skill ${skill}: standing ${pct(stat)} -> strafing ${pct(strafe)}`
		+ `   (moving cuts incoming fire by ${delta.toFixed(0)}%)`)
}

console.log('\nPersonality spread at one skill level (same skill, different archetypes):')
for (let i = 0; i < 6; i++) {
	const p = personalityFor(i)
	let shots = 0, hits = 0
	for (let r = 0; r < 6; r++) {
		const res = run('strafing', 3, i)
		shots += res.shots; hits += res.hitRate * res.shots
	}
	console.log(`  ${p.label.padEnd(10)} hit ${pct(shots ? hits / shots : 0)}  shots ${String(shots).padStart(5)}`
		+ `  (accuracy ${p.accuracy.toFixed(2)}, style ${p.combatStyle.toFixed(2)}, strafing ${p.strafing.toFixed(2)})`)
}
