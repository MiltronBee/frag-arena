// Distance-based damage falloff for hitscan weapons, applied server-side where
// per-hit damage is judged (server/GameInstance.js performShot). Data-driven and
// OPT-IN: a weapon with no falloffStart/falloffEnd keeps flat config.damage at any
// range (no behaviour change). Pure math, zero babylon imports — server + node-testable.
//
// Model: full damage within `falloffStart` metres, LINEAR interpolation of the
// damage multiplier from 1.0 down to `falloffMinMult` between start and end, then
// floored at falloffMinMult beyond `falloffEnd`.
//
// ADS range-extension (Bungie sandbox guidance for the Pistol): the aimed shot
// pushes the WHOLE falloff window outward. The weapon's ads.rangeMult scaled by the
// live aimFactor (the SAME 0..1 ramp the shot was fired with) multiplies both
// falloffStart and falloffEnd — so at full ADS the gun keeps full damage much
// farther out (the aimed long-range 3-shot kill), while hip-fire drops off early.

// effective (ADS-extended) falloff window for a shot fired at `aimFactor`.
export const falloffRange = (config, aimFactor = 0) => {
	const af = Math.min(1, Math.max(0, aimFactor))
	// rangeMult of R at full ADS -> window scaled by 1 at hip, R when fully aimed
	const rangeMult = (config.ads && config.ads.rangeMult != null)
		? (1 + (config.ads.rangeMult - 1) * af) : 1
	return { start: (config.falloffStart || 0) * rangeMult, end: (config.falloffEnd || 0) * rangeMult }
}

// damage multiplier (0..1) for a hit at `distance` metres, fired at `aimFactor`.
// Returns 1 for weapons without a configured falloff window (flat damage).
export const damageFalloffMult = (config, distance, aimFactor = 0) => {
	if (config.falloffStart == null || config.falloffEnd == null) return 1
	const minMult = config.falloffMinMult != null ? config.falloffMinMult : 1
	const { start, end } = falloffRange(config, aimFactor)
	if (distance <= start) return 1
	if (distance >= end || end <= start) return minMult
	const t = (distance - start) / (end - start)
	return 1 - (1 - minMult) * t
}
