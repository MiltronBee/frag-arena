import { update as updateWeapon } from './weapon'
import { Vector3, Matrix, Axis } from 'babylonjs'
import { weapons } from './weaponsConfig'
import nengiConfig from './nengiConfig'

/* UT99-style movement. Runs on BOTH the client (prediction) and the server
   (authoritative) — it must stay deterministic: same entity state + same
   command in, same result out. Anything time- or random-based is forbidden. */

// UT99 values converted at ~52.5 unreal-units per meter
export const GROUND_SPEED = 7.6   // GroundSpeed 400
const GROUND_ACCEL = 10           // quake-style accel coefficient — snappy starts
const FRICTION = 8                // quick stops (no ice skating)
const MAX_AIR_WISH_SPEED = 1.2    // quake-style air speed limit
const AIR_ACCEL = 30              // quake-style air acceleration
const JUMP_SPEED = 6.2            // JumpZ 325
const GRAVITY = 18                // 950 uu/s²
const TERMINAL_FALL = 30
export const DODGE_SPEED = 11.4   // dodge bursts at 1.5x GroundSpeed
const DODGE_UP = 3.4              // small hop so the dodge clears the floor
const DODGE_COOLDOWN = 0.35       // after landing, before the next dodge
// NOTE: an earlier post-dodge "landing speed clamp" was removed — DYOR found it has
// no prior art in shipped arena shooters (they use a re-dodge cooldown, which we
// already have). Raising the sim tick to 40Hz halves the per-tick dodge jump
// (0.57m -> 0.285m), which fixes the target-trackability problem the clamp was
// invented for. If dodges still feel spammy in playtest, bump DODGE_COOLDOWN to
// ~0.45 (UT4's shipped `dodgedelay`) rather than reintroducing a clamp.
const GROUND_Y = 0
// clamp hitches so one lagged frame can't teleport. Derived from the sim tick so
// a tick-rate raise (nengiConfig.UPDATE_RATE) keeps the per-command clamp equal to
// exactly one server tick automatically — do NOT hardcode this to 1/20.
const MAX_DELTA = 1 / nengiConfig.UPDATE_RATE

// the fastest a player legitimately moves horizontally (used for the smooth
// entity's path-following budget on the server)
export const MAX_SPEED = DODGE_SPEED

// dodge direction wire codes (0 = no dodge this command)
export const DODGE_DIRS = { forwards: 1, backwards: 2, left: 3, right: 4 }
const DODGE_VECTORS = {
	1: new Vector3(0, 0, 1),
	2: new Vector3(0, 0, -1),
	3: new Vector3(-1, 0, 0),
	4: new Vector3(1, 0, 0),
}

// quake-style acceleration: only adds speed while the velocity component along
// wishDir is below wishSpeed — never bleeds speed above it, so dodge momentum
// survives holding forward
const accelerate = (entity, wishX, wishZ, wishSpeed, accel, delta) => {
	const current = entity.velX * wishX + entity.velZ * wishZ
	const add = wishSpeed - current
	if (add <= 0) { return }
	const speed = Math.min(accel * wishSpeed * delta, add)
	entity.velX += wishX * speed
	entity.velZ += wishZ * speed
}

export default (entity, command) => {
	if (!entity.isAlive) {
		return
	}
	const delta = Math.min(Math.max(command.delta, 0.0001), MAX_DELTA)

	// aim: look in any direction, move flatly in the x/z plane
	const camVector = new Vector3(command.camRayX, command.camRayY, command.camRayZ)
	entity.mesh.lookAt(entity.mesh.position.add(camVector))

	// wish direction from input keys, rotated by yaw into world space
	let ix = 0
	let iz = 0
	if (command.forwards) { iz += 1 }
	if (command.backwards) { iz -= 1 }
	if (command.left) { ix -= 1 }
	if (command.right) { ix += 1 }
	const yawMatrix = Matrix.RotationAxis(Axis.Y, entity.mesh.rotation.y)
	const wish = Vector3.TransformCoordinates(new Vector3(ix, 0, iz), yawMatrix)
	const wishLen = Math.hypot(wish.x, wish.z)
	const wishX = wishLen > 0 ? wish.x / wishLen : 0
	const wishZ = wishLen > 0 ? wish.z / wishLen : 0

	if (entity.grounded) {
		// ground friction, applied even while accelerating — the interplay of the
		// two is what makes starts/stops feel 1999-snappy instead of floaty
		const speed = Math.hypot(entity.velX, entity.velZ)
		if (speed > 0) {
			const drop = speed * FRICTION * delta
			const scale = Math.max(speed - drop, 0) / speed
			entity.velX *= scale
			entity.velZ *= scale
		}
		if (wishLen > 0) {
			// Plasma slow debuff: scale ground max-speed AND accel by (1-slowFactor)
			// for this frame. Deterministic (slowTimer/slowFactor are entity state,
			// synced + predicted), so it reconciles exactly. Does NOT touch the dodge
			// burst below (escape stays viable at full DODGE_SPEED).
			const slow = entity.slowTimer > 0 ? (1 - (entity.slowFactor || 0)) : 1
			accelerate(entity, wishX, wishZ, GROUND_SPEED * slow, GROUND_ACCEL * slow, delta)
		}

		// the cooldown only ticks while grounded: dodging launches you airborne,
		// so you can't dodge again until you land AND the timer runs out (UT rule)
		if (entity.dodgeTimer > 0) {
			entity.dodgeTimer -= delta
		}

		if (command.dodge && entity.dodgeTimer <= 0 && DODGE_VECTORS[command.dodge]) {
			const dir = Vector3.TransformCoordinates(DODGE_VECTORS[command.dodge], yawMatrix)
			entity.velX = dir.x * DODGE_SPEED
			entity.velZ = dir.z * DODGE_SPEED
			entity.velY = DODGE_UP
			entity.grounded = false
			entity.dodgeTimer = DODGE_COOLDOWN
		} else if (command.jump) {
			entity.velY = JUMP_SPEED
			entity.grounded = false
		}
	} else if (wishLen > 0) {
		// Quake-style air acceleration / strafe jumping
		accelerate(entity, wishX, wishZ, MAX_AIR_WISH_SPEED, AIR_ACCEL, delta)
	}

	entity.velY -= GRAVITY * delta
	if (entity.velY < -TERMINAL_FALL) {
		entity.velY = -TERMINAL_FALL
	}

	// integrate with collisions
	const oldX = entity.x
	const oldY = entity.y
	const oldZ = entity.z
	entity.mesh.moveWithCollisions(new Vector3(
		entity.velX * delta,
		entity.velY * delta,
		entity.velZ * delta
	))
	if (entity.y < GROUND_Y) {
		entity.y = GROUND_Y
	}

	// horizontal velocity becomes what actually happened, so walls absorb speed
	// instead of storing a slingshot for when you strafe off them
	entity.velX = (entity.x - oldX) / delta
	entity.velZ = (entity.z - oldZ) / delta

	// grounded = a downward move got cut short (the floor plane or an obstacle top)
	const movedY = entity.y - oldY
	if (entity.velY <= 0 && movedY - entity.velY * delta > 0.001) {
		entity.grounded = true
		entity.velY = 0
	} else {
		entity.grounded = false
	}

	// tick the Plasma slow debuff down (independent of grounded state so it also
	// expires while airborne). Clamp at 0 so a networked/predicted value never runs
	// negative and permanently disables the (1-slowFactor) gate above.
	if (entity.slowTimer > 0) {
		entity.slowTimer -= delta
		if (entity.slowTimer < 0) entity.slowTimer = 0
	}

	// Apply weapon switching. When the equipped index actually changes, start the
	// equip lock (drawTime) — weapon.fire() refuses to fire while equipTimer > 0.
	if (command.weaponIndex !== undefined) {
		if (command.weaponIndex !== entity.currentWeaponIndex) {
			const w = weapons[command.weaponIndex]
			entity.equipTimer = (w && w.drawTime) || 0
		}
		entity.currentWeaponIndex = command.weaponIndex
	}

	// Modular weapons reload logic
	if (entity.weaponsState) {
		const index = entity.currentWeaponIndex || 0
		const config = weapons[index]
		const state = entity.weaponsState[index]

		// Tick down active reload timer
		if (state.reloading) {
			// Interrupt reload if the player tries to fire and has bullets in the magazine
			if (command.fireInput && state.magazineAmmo > 0) {
				state.reloading = false
				state.reloadTimer = 0
			} else {
				state.reloadTimer -= delta
				if (state.reloadTimer <= 0) {
					// Reload complete! Refill the magazine
					const needed = config.magazineCapacity - state.magazineAmmo
					const transfer = Math.min(needed, state.reserveAmmo)
					state.magazineAmmo += transfer
					state.reserveAmmo -= transfer
					state.reloading = false
					state.reloadTimer = 0
				}
			}
		}

		// Start reload (manual keypress)
		if (command.reload && !state.reloading && state.magazineAmmo < config.magazineCapacity && state.reserveAmmo > 0) {
			state.reloading = true
			state.reloadTimer = Math.max(0.1, config.reloadTime - 0.15)
		}

		// Auto reload (trying to fire with empty magazine)
		if (command.fireInput && !state.reloading && state.magazineAmmo === 0 && state.reserveAmmo > 0) {
			state.reloading = true
			state.reloadTimer = Math.max(0.1, config.reloadTime - 0.15)
		}
	}

	// ADS aim ramp (deterministic — mirrors the plasma slow debuff above). aimFactor
	// eases 0..1 toward the held aim state over the weapon's in/out time, and drives
	// the weapon's ADS accuracy in weapon.fire()/firePattern. Weapons without an ads
	// config clamp to 0. Runs identically on client (prediction) + server (authority),
	// and re-derives on reconciliation replay, so hit-reg + tracers stay consistent.
	{
		const acfg = weapons[entity.currentWeaponIndex || 0]
		const ads = acfg && acfg.ads
		if (ads && command.aimInput) {
			const step = ads.inTime > 0 ? delta / ads.inTime : 1
			entity.aimFactor = Math.min(1, (entity.aimFactor || 0) + step)
		} else {
			const step = (ads && ads.outTime > 0) ? delta / ads.outTime : 1
			entity.aimFactor = Math.max(0, (entity.aimFactor || 0) - step)
		}
	}

	// advances the weapon-related timer(s) — use the clamped delta, not the raw
	// client-supplied command.delta, or a spoofed huge delta drains cooldownTimer
	// instantly (unlimited rate of fire)
	updateWeapon(entity, delta)
}
