// Pure unit check: ADS (aimFactor) tightens the cone per weapon. Same seed → same
// rand sequence, so the jitter magnitude scales exactly by the effective spread, and
// hip vs aimed is a clean apples-to-apples ratio. No engine, runs under plain node.
import { shotPattern } from '../common/firePattern.js'
import weapons from '../common/weaponsConfig.js'

const mag = (o) => Math.hypot(o.dx, o.dy)
const SEED = 0xC0FFEE
let fail = 0
const check = (name, pass, detail) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`); if (!pass) fail++ }

// Rifle: heat=1 (full bloom). hip = 0.003 + 0.004 = 0.007; ads = 0.003 + 0.004*0.6 = 0.0054
const rifle = weapons[0]
const rHip = mag(shotPattern(rifle, SEED, 1.0, 0)[0])
const rAds = mag(shotPattern(rifle, SEED, 1.0, 1.0)[0])
check('Rifle: ADS tightens sustained-fire cone', rAds < rHip * 0.9, `hip=${rHip.toFixed(5)} ads=${rAds.toFixed(5)} ratio=${(rAds / rHip).toFixed(3)}`)
check('Rifle: ADS ratio ~0.77 (bloom -40%)', Math.abs(rAds / rHip - 0.0054 / 0.007) < 0.02, `ratio=${(rAds / rHip).toFixed(3)}`)

// Pistol: spreadBaseMult 0, no heat. hip = 0.0015; ads -> ~0
const pistol = weapons[3]
const pHip = mag(shotPattern(pistol, SEED, 0, 0)[0])
const pAds = mag(shotPattern(pistol, SEED, 0, 1.0)[0])
check('Pistol: ADS drives cone toward zero', pAds < pHip * 0.05, `hip=${pHip.toFixed(6)} ads=${pAds.toFixed(6)}`)

// Ramp: half-aim gives a partial bonus (anti-macro / Hale's ramp), between hip and full
const rMid = mag(shotPattern(rifle, SEED, 1.0, 0.5)[0])
check('Rifle: half-aim is between hip and full-ADS (ramped)', rMid < rHip && rMid > rAds, `hip=${rHip.toFixed(5)} mid=${rMid.toFixed(5)} ads=${rAds.toFixed(5)}`)

// Non-ADS weapon (SMG) is unaffected by aimFactor
const smg = weapons[1]
const sHip = mag(shotPattern(smg, SEED, 1.0, 0)[0])
const sAds = mag(shotPattern(smg, SEED, 1.0, 1.0)[0])
check('SMG (no ads config): aimFactor has no effect', Math.abs(sHip - sAds) < 1e-9, `hip=${sHip.toFixed(5)} ads=${sAds.toFixed(5)}`)

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail ? 1 : 0)
