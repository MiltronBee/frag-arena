/* weapon system */

import { Vector3, Ray } from 'babylonjs'
import { weapons } from './weaponsConfig'

// advances the weapon cooldown timers
export const update = (entity, delta) => {
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

	// Enforce active cooldown and ammo check
	if (!state.onCooldown && state.magazineAmmo > 0) {
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
		return ray
	} else {
		console.log("WEAPON_FIRE_FAIL: onCooldown:", state.onCooldown, "magazineAmmo:", state.magazineAmmo)
	}

	return false
}