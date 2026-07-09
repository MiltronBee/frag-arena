import { update as updateWeapon } from './weapon'
import { Vector3, Matrix, Axis } from 'babylonjs'

/* UT99-style movement. Runs on BOTH the client (prediction) and the server
   (authoritative) — it must stay deterministic: same entity state + same
   command in, same result out. Anything time- or random-based is forbidden. */

// UT99 values converted at ~52.5 unreal-units per meter
export const GROUND_SPEED = 7.6   // GroundSpeed 400
const GROUND_ACCEL = 10           // quake-style accel coefficient — snappy starts
const FRICTION = 8                // quick stops (no ice skating)
const AIR_CONTROL = 0.35          // UT99 AirControl: steer mid-air, can't stop
const JUMP_SPEED = 6.2            // JumpZ 325
const GRAVITY = 18                // 950 uu/s²
const TERMINAL_FALL = 30
export const DODGE_SPEED = 11.4   // dodge bursts at 1.5x GroundSpeed
const DODGE_UP = 3.4              // small hop so the dodge clears the floor
const DODGE_COOLDOWN = 0.35       // after landing, before the next dodge
const GROUND_Y = 0
const MAX_DELTA = 1 / 20          // clamp hitches so one lagged frame can't teleport

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
			accelerate(entity, wishX, wishZ, GROUND_SPEED, GROUND_ACCEL, delta)
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
		// air control: steer toward the wish direction, but weakly
		accelerate(entity, wishX, wishZ, GROUND_SPEED, GROUND_ACCEL * AIR_CONTROL, delta)
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

	// advances the weapon-related timer(s)
	updateWeapon(entity, command.delta)
}
