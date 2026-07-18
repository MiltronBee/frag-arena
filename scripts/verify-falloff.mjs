// Pure-node unit test for the hitscan damage-falloff helper (common/damageFalloff.js).
// No babylon: exercises the falloff math directly against the live weaponsConfig so
// the shipped pistol numbers are what's actually asserted. Run: node scripts/verify-falloff.mjs
import { damageFalloffMult, falloffRange } from '../common/damageFalloff.js'
import weapons from '../common/weaponsConfig.js'

let pass = 0, fail = 0
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const assert = (cond, msg) => {
	if (cond) { pass++; console.log('  ok  ', msg) }
	else { fail++; console.error('  FAIL', msg) }
}

const pistol = weapons[3]
console.log(`Pistol: dmg ${pistol.damage}, falloff ${pistol.falloffStart}->${pistol.falloffEnd}m ` +
	`min ${pistol.falloffMinMult}x, ads.rangeMult ${pistol.ads.rangeMult}`)
const dmgAt = (dist, af = 0) => pistol.damage * damageFalloffMult(pistol, dist, af)

// 1) full damage within falloffStart (hip fire, aimFactor 0)
assert(damageFalloffMult(pistol, 0, 0) === 1, 'point-blank = full damage (1.0x)')
assert(damageFalloffMult(pistol, pistol.falloffStart, 0) === 1, 'at falloffStart = still full damage')
assert(dmgAt(10, 0) === pistol.damage, '10m hip = full 34 dmg -> 3-shot kill')
assert(Math.ceil(100 / dmgAt(15, 0)) === 3, '15m hip stays a 3-shot kill')

// 2) reduced at / beyond falloffEnd, floored at falloffMinMult
assert(approx(damageFalloffMult(pistol, pistol.falloffEnd, 0), pistol.falloffMinMult), 'at falloffEnd = falloffMinMult')
assert(approx(damageFalloffMult(pistol, 999, 0), pistol.falloffMinMult), 'far beyond falloffEnd = floored at min, not lower')
assert(dmgAt(40, 0) < pistol.damage, '40m hip < full damage')
assert(Math.ceil(100 / dmgAt(40, 0)) > 3, '40m hip needs MORE than 3 shots (falloff bites)')

// 3) linear interpolation at the midpoint of the hip window
const mid = (pistol.falloffStart + pistol.falloffEnd) / 2
assert(approx(damageFalloffMult(pistol, mid, 0), (1 + pistol.falloffMinMult) / 2), 'midpoint = halfway multiplier (linear)')

// 4) ADS (aimFactor 1) extends the full-damage range outward
const ext = falloffRange(pistol, 1)
assert(approx(ext.start, pistol.falloffStart * pistol.ads.rangeMult), `ADS pushes falloffStart out to ${ext.start}m`)
assert(approx(ext.end, pistol.falloffEnd * pistol.ads.rangeMult), `ADS pushes falloffEnd out to ${ext.end}m`)
// a distance that is falloff territory when hip-fired is full-damage when aimed
assert(damageFalloffMult(pistol, 30, 0) < 1, '30m hip = reduced')
assert(damageFalloffMult(pistol, 30, 1) === 1, '30m ADS = full damage (range extended)')
assert(Math.ceil(100 / dmgAt(30, 0)) > 3 && Math.ceil(100 / dmgAt(30, 1)) === 3,
	'30m: hip needs >3 shots but ADS restores the 3-shot kill')
// partial ADS extends proportionally (aimFactor 0.5)
const half = falloffRange(pistol, 0.5)
assert(approx(half.start, pistol.falloffStart * (1 + (pistol.ads.rangeMult - 1) * 0.5)),
	'half ADS extends the window proportionally')

// 5) weapons WITHOUT falloff config keep flat damage (no behaviour change)
const rifle = weapons[0]
assert(rifle.falloffStart == null, 'rifle has no falloff config')
assert(damageFalloffMult(rifle, 0, 0) === 1 && damageFalloffMult(rifle, 500, 1) === 1,
	'rifle = flat damage (1.0x) at every range, ADS or not')

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
