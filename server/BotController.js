// UT99-style deathmatch bot brain.
//
// A bot owns NO special powers: it synthesizes the same MoveCommand-shaped
// object a human client sends (camRay aim + wasd/jump + fireInput) and the
// GameInstance runs it through the exact same applyCommand physics and
// performShot weapon authority. Everything that makes it beatable is here:
//   * turn-rate-limited aim (it swings onto you, never snaps)
//   * per-burst aim error (it misses like a mid-skill UT bot)
//   * trigger discipline (bursts with pauses, only fires roughly on target)
//   * line-of-sight checks against the arena obstacles (it can't wallhack)
//   * strafe-orbiting at its weapon's preferred range, occasional jumps
import * as BABYLON from '../common/babylon.node.js'
import { weapons } from '../common/weaponsConfig'

const TURN_RATE = 3.4          // rad/s — swings onto a target in ~0.3-0.9s
const RETARGET_MS = 900        // how often it reconsiders who to fight
const AIM_ERR_YAW = 0.055      // rad, re-rolled each burst (~±1.6°)
const AIM_ERR_PITCH = 0.03
const FIRE_CONE = 0.13         // rad — only pulls the trigger this close to on-target

// LoS: a ray from the bot's chest to the target's, blocked by any obstacle box
const hasLineOfSight = (me, target, obstacles) => {
	const dx = target.x - me.x
	const dy = target.y - me.y
	const dz = target.z - me.z
	const dist = Math.hypot(dx, dy, dz)
	if (dist < 0.001) return true
	const ray = new BABYLON.Ray(
		me.mesh.position,
		new BABYLON.Vector3(dx / dist, dy / dist, dz / dist),
		dist
	)
	for (const obstacle of obstacles.values()) {
		if (ray.intersectsMesh(obstacle.mesh).hit) return false
	}
	return true
}

class BotController {
	constructor(entity, weaponIndex) {
		this.entity = entity
		this.weaponIndex = weaponIndex
		this.aimYaw = Math.random() * Math.PI * 2
		this.aimPitch = 0
		this.aimErrYaw = 0
		this.aimErrPitch = 0
		this.strafeDir = Math.random() < 0.5 ? -1 : 1
		this.strafeFlipAt = 0
		this.burstUntil = 0
		this.pauseUntil = 0
		this.retargetAt = 0
		this.target = null
		this.wander = null
		this.wanderUntil = 0
	}

	// One AI tick: returns a MoveCommand-shaped plain object for applyCommand.
	// `combatants` = alive entities it may fight (never includes itself).
	think(delta, now, combatants, obstacles) {
		const me = this.entity

		// (re)pick the nearest living target on a timer, or when the old one died
		if (now >= this.retargetAt || !this.target || this.target.isAlive === false) {
			this.retargetAt = now + RETARGET_MS
			let best = null
			let bestDist = Infinity
			combatants.forEach(candidate => {
				const d = Math.hypot(candidate.x - me.x, candidate.z - me.z)
				if (d < bestDist) { bestDist = d; best = candidate }
			})
			this.target = best
		}

		const spec = weapons[this.weaponIndex]
		let wishYaw = this.aimYaw
		let wishPitch = 0
		let forwards = false, backwards = false, left = false, right = false, jump = false
		let wantsFire = false

		const target = this.target
		const seesTarget = target && target.isAlive !== false &&
			hasLineOfSight(me, target, obstacles)

		if (seesTarget) {
			const dx = target.x - me.x
			const dy = target.y - me.y
			const dz = target.z - me.z
			const dist = Math.hypot(dx, dz)
			wishYaw = Math.atan2(dx, dz)
			wishPitch = Math.atan2(dy, dist)

			// orbit at the weapon's preferred range: shotgun crowds in, the rest
			// keep mid-range; strafe direction flips on a timer so it never circles
			// predictably, with the occasional UT hop thrown in
			if (now >= this.strafeFlipAt) {
				this.strafeFlipAt = now + 800 + Math.random() * 1500
				this.strafeDir = -this.strafeDir
				if (Math.random() < 0.3) jump = true
			}
			const preferred = (spec.range || 50) < 40 ? 7 : 13
			if (dist > preferred + 2) forwards = true
			else if (dist < preferred - 3) backwards = true
			left = this.strafeDir < 0
			right = this.strafeDir > 0

			// trigger discipline: burst, pause, re-roll this burst's aim error
			if (now >= this.pauseUntil && now >= this.burstUntil) {
				this.burstUntil = now + 350 + Math.random() * 700
				this.pauseUntil = this.burstUntil + 250 + Math.random() * 600
				this.aimErrYaw = (Math.random() - 0.5) * 2 * AIM_ERR_YAW
				this.aimErrPitch = (Math.random() - 0.5) * 2 * AIM_ERR_PITCH
			}
			wantsFire = dist < (spec.range || 50) * 0.9 && now < this.burstUntil
		} else {
			// no target in sight: wander between random arena points (same radius
			// band as spawn points, so it never grinds along the outer walls)
			const wanderDone = this.wander &&
				Math.hypot(this.wander.x - me.x, this.wander.z - me.z) < 1.5
			if (!this.wander || wanderDone || now >= this.wanderUntil) {
				// Roam the central valley of the long Facing Worlds platform: a wide X
				// band (tower-to-tower) but clear of the tower footprints (|x|>=42) and
				// the side walls (|z|<20). Bots don't climb towers, so keep them in play.
				this.wander = { x: (Math.random() * 2 - 1) * 32, z: (Math.random() * 2 - 1) * 15 }
				this.wanderUntil = now + 4000
			}
			wishYaw = Math.atan2(this.wander.x - me.x, this.wander.z - me.z)
			forwards = true
		}

		// swing the aim toward the wish direction at a bounded, human-ish rate
		const maxTurn = TURN_RATE * delta
		let dYaw = (wishYaw + this.aimErrYaw) - this.aimYaw
		while (dYaw > Math.PI) dYaw -= Math.PI * 2
		while (dYaw < -Math.PI) dYaw += Math.PI * 2
		this.aimYaw += Math.max(-maxTurn, Math.min(maxTurn, dYaw))
		const dPitch = (wishPitch + this.aimErrPitch) - this.aimPitch
		this.aimPitch += Math.max(-maxTurn, Math.min(maxTurn, dPitch))

		const onTarget = Math.abs(dYaw) < FIRE_CONE
		const cosPitch = Math.cos(this.aimPitch)
		return {
			camRayX: Math.sin(this.aimYaw) * cosPitch,
			camRayY: Math.sin(this.aimPitch),
			camRayZ: Math.cos(this.aimYaw) * cosPitch,
			forwards, backwards, left, right, jump,
			dodge: 0,
			weaponIndex: this.weaponIndex,
			reload: false,
			fireInput: wantsFire && onTarget, // also drives applyCommand's auto-reload
			delta,
		}
	}
}

export default BotController
