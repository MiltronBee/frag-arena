/* weapon system */

import { Vector3, Ray } from './babylon.node.js'
import { weapons } from './weaponsConfig'
import { shotSeed } from './firePattern'

// advances the weapon cooldown timers
export const update = (entity, delta) => {
	// swap-commitment equip lock: tick down the just-equipped weapon's draw time.
	// fire() refuses to fire while this is > 0. Runs on client + server through this
	// shared function, so prediction and authority stay in lockstep.
	if (entity.equipTimer > 0) {
		entity.equipTimer -= delta
		if (entity.equipTimer < 0) entity.equipTimer = 0
	}

	// Update legacy cooldown
	const weapon = entity.weapon
	if (weapon && weapon.onCooldown) {
		weapon.acc += delta
		if (weapon.acc >= weapon.cooldown) {
			weapon.acc = 0
			weapon.onCooldown = false
		}
	}

	// Update modular weapon cooldowns
	if (entity.weaponsState) {
		entity.weaponsState.forEach(state => {
			if (state.onCooldown) {
				state.cooldownTimer -= delta
				if (state.cooldownTimer <= 0) {
					state.cooldownTimer = 0
					state.onCooldown = false
				}
			}
			// sustained-fire heat cools off between bursts (drives spread bloom).
			// Client and server both run this; small drift only shifts VISUAL spread,
			// damage always uses the server's own heat.
			if (state.heat) {
				state.heat = Math.max(0, state.heat - delta * 1.3)
			}
		})
	}
}

// returns a ray with attached config metadata if the weapon successfully fires
export const fire = (entity) => {
	if (!entity.isAlive || !entity.weaponsState) {
		console.log("WEAPON_FIRE_FAIL: isAlive:", entity.isAlive, "hasWeaponsState:", !!entity.weaponsState)
		return false
	}

	const index = entity.currentWeaponIndex || 0
	const config = weapons[index]
	const state = entity.weaponsState[index]

	if (!config || !state) {
		console.log("WEAPON_FIRE_FAIL: no config or state for index:", index)
		return false
	}

	// swap-commitment: cannot fire mid-draw. Gates BOTH client prediction and server
	// authority through this shared function, so they stay in lockstep (like reload).
	if (entity.equipTimer > 0) {
		return false
	}

	// Enforce active cooldown and ammo check
	if (!state.onCooldown && state.magazineAmmo > 0) {
		// per-shot spread identity, computed IDENTICALLY on client and server:
		// seed from pre-shot ammo, heat sampled before this shot's own bump
		const seed = shotSeed(entity.nid || 0, index, state.magazineAmmo)
		const heat = state.heat || 0
		// ADS (entity.aimFactor 0..1, deterministic from applyCommand) reduces heat
		// accumulation per the weapon's heatMult, so aimed sustained fire blooms less.
		const af = Math.min(1, Math.max(0, entity.aimFactor || 0))
		const heatMul = (config.ads && config.ads.heatMult != null) ? (1 - (1 - config.ads.heatMult) * af) : 1
		state.heat = Math.min(1, heat + (config.heatPerShot || 0) * heatMul)

		// Consume 1 ammo
		state.magazineAmmo -= 1
		state.onCooldown = true
		state.cooldownTimer = config.fireCooldown

		// Update legacy cooldown state so we don't break simple template prediction checks
		if (entity.weapon) {
			entity.weapon.onCooldown = true
			entity.weapon.cooldown = config.fireCooldown
			entity.weapon.acc = 0
		}

		// Calculate aim vector
		const wm = entity.mesh.getWorldMatrix()
		const aimVector = Vector3.TransformCoordinates(Vector3.Forward(), wm)
			.subtract(entity.mesh.position)
			.normalize()

		const ray = new Ray(entity.mesh.position, aimVector)
		ray.config = config // attach scriptable object config dynamically
		ray.seed = seed
		ray.heat = heat
		ray.aimFactor = af // ADS ramp — threaded into shotPattern (spread) + projectile spawn
		return ray
	} else {
		console.log("WEAPON_FIRE_FAIL: onCooldown:", state.onCooldown, "magazineAmmo:", state.magazineAmmo)
	}

	return false
}