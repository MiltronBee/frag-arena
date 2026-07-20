import { update as updateWeapon } from './weapon'
import { Vector3, Matrix, Axis } from './babylon.node.js'
import { weapons } from './weaponsConfig'
import nengiConfig from './nengiConfig'
import { JUMP_PADS } from './arenaConfig'
import { USE_MESH_MAP } from './mapMesh'

/* UT99-style movement. Runs on BOTH the client (prediction) and the server
   (authoritative) — it must stay deterministic: same entity state + same
   command in, same result out. Anything time- or random-based is forbidden. */

// UT99 values converted at ~52.5 unreal-units per meter
export const GROUND_SPEED = 7.6   // GroundSpeed 400
const GROUND_ACCEL = 10           // quake-style accel coefficient — snappy starts
const FRICTION = 8                // quick stops (no ice skating)
const MAX_AIR_WISH_SPEED = 1.2    // quake-style air speed limit
const AIR_ACCEL = 30              // quake-style air acceleration
const JUMP_SPEED = 7.2            // bumped from 6.2 for a higher, floatier UT-style hop
                                 // (apex ~1.44m vs ~1.07m; also helps clear stairs)
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
// Walkable-surface limit: the minimum ground-plane normal.y a player can stand on.
// 0.7 == Quake III's MIN_WALK_NORMAL (~45.6 degrees). At or above it the surface is
// FLOOR (gravity is clipped out, you stand still); below it the surface is a WALL/RAMP
// you slide down. The normal comes from the collider's slide plane after the vertical
// move — no raycast, so this stays a pure function of (entity, command).
const MIN_WALK_NORMAL = 0.7
// Snap-to-ground probe distance. Walking DOWNHILL at 40Hz, one tick of horizontal
// travel (7.6 m/s * 0.025 = 0.19m) drops the floor away by more than gravity can pull
// the capsule in the same tick (18 * 0.025^2 = 0.011m) on any slope steeper than ~3.4
// degrees — so without an active snap the player goes ballistic, loses ground contact,
// and friction switches off (the "ice" feel). After the vertical move we probe down by
// this much and stay glued if we find walkable floor. 0.35 covers a 40Hz downhill run
// on slopes past 60 degrees while staying under the ~0.5 step height, so it can't glue
// a player to a floor they genuinely jumped or walked off.
// `collider.slidePlaneNormal` is NOT a unit surface normal in Babylon 9 — it is the
// residual-penetration vector, whose LENGTH scales with the unconsumed part of the
// requested move (on a flat floor |n| == 1 - |moveY|/radius). Its DIRECTION is the true
// surface normal, so normalizing recovers it exactly — verified to 4dp against ground
// truth on 0/15/30/44/50/60-degree slopes. Comparing the RAW .y to a cosine threshold
// measures IMPACT SPEED, not slope: a player landing at JUMP_SPEED (7.2 m/s) moves
// 0.18 in a tick and reads n.y ~ 0.64 on DEAD FLAT GROUND, so it is misclassified as a
// wall and never re-grounds — grounded latches false, velY runs to terminal, and
// friction/jump/dodge/jump-pads (all gated on grounded) die. Past |moveY| > radius the
// vector flips sign; taking |.| is correct here because this is only ever consulted
// while velY <= 0, where the contacted surface must be a floor rather than a ceiling.
const groundNormalY = (n) => {
	const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z)
	return len > 1e-9 ? Math.abs(n.y) / len : 1
}
const STEP_DOWN = 0.35

// ---------------------------------------------------------------------------
// FLOOR-GAP CONSTANTS — UE CharacterMovementComponent's MIN_FLOOR_DIST /
// MAX_FLOOR_DIST, used by its AdjustFloorHeight().
//
// UNIT SCALE (verified, not assumed). UE ships MIN_FLOOR_DIST = 1.9 and
// MAX_FLOOR_DIST = 2.4 in CENTIMETRES, against a capsule of ~34cm radius. To port
// them we need our own unit. Three independent quantities in this file agree that
// 1 unit == 1 METRE:
//   GROUND_SPEED 7.6 == UT99 GroundSpeed 400 uu/s / 52.5 uu-per-metre = 7.62
//   GRAVITY      18  == UT99 950 uu/s^2          / 52.5              = 18.1
//   JUMP_SPEED   7.2 -> apex = v^2/2g = 7.2^2/36 = 1.44, which is exactly the
//                       "apex ~1.44m" its own comment quotes.
// So UE's 1.9cm / 2.4cm are 0.019 / 0.024 in our units.
//
// We do NOT use those numbers directly. The gap exists to keep the collider clear
// of the SOLVER, and the depenetration distance a solver produces scales with the
// COLLIDER, not with the world — so the better-argued port is UE's ratio-to-radius,
// not its absolute centimetres. UE: 1.9/34 = 5.6% of radius, 2.4/34 = 7.1%, midpoint
// 2.15/34 = 6.3%. Our ellipsoid radius is 0.5, giving 0.028 / 0.035 / 0.0316.
//
// WHAT THE MAGNITUDE ACTUALLY BUYS — measured, and less than you would expect. The
// gap was swept over 0.0316 / 0.0215 / 0.0145 / 0.008 and EVERY headline number was
// identical to 3dp: downhill 22.382m, standing drift 0.000m, jumpArc grounded 89 on
// all four golden maps. The ramp-parallel delta (B) is what restores displacement;
// the gap does not contribute to it. What the gap buys is that it is NON-ZERO:
// with AdjustFloorHeight disabled entirely the golden jumpArc reads 90/90/83/90 —
// sesmar loses seven grounded ticks — because a player left resting flush on the
// surface starts the next move interpenetrating and the solver eats it. With the gap
// held, all four maps read a uniform 89. So this constant is chosen for its SIGN and
// its dead band, not for a magnitude any measurement here can distinguish; the
// radius-scaled port is kept because it is the one with a defensible derivation.
const FLOOR_GAP_MIN = 0.028
const FLOOR_GAP_MAX = 0.035
const FLOOR_GAP_TARGET = 0.0316
// How far FindFloor sweeps before it declares you airborne (UE: MAX_FLOOR_DIST).
// Comfortably clear of FLOOR_GAP_MAX so a correctly-hovering player is never one
// rounding error from being called airborne. STEP_DOWN is still used, but only as a
// SEARCH distance for when this sweep finds nothing at all (see findFloor).
const FLOOR_PROBE = 0.05
// ---------------------------------------------------------------------------

// One downward sweep, used as a pure query. Returns null if nothing is within `dist`,
// otherwise { floorDist, nx, ny, nz, walkable } with the ellipsoid put back EXACTLY
// where it started.
//
// TWO Babylon-specific traps here, both measured rather than assumed
// (_work/slope-verify/probe-diag.ts):
//
// 1. `collider.collisionFound` IS NOT A HIT TEST. On a resting player it reads FALSE
//    on every sloped surface we tested (10/20/35/44 degrees) even though the sweep was
//    plainly blocked — 0.05 requested, 0.0058 achieved, and deflected 0.016 sideways.
//    It appears to report only the LAST iteration of the collide-and-slide loop, which
//    on a slope consumes its remaining budget sliding rather than colliding. Believing
//    it reports every standing player on a ramp as airborne, which is exactly the
//    0%-grounded failure the first cut of this restructure produced. We detect contact
//    from the SHORTFALL in achieved travel instead, which is the same technique the
//    airborne vertical phase below has always used.
//
// 2. THE VERTICAL DROP IS NOT THE FLOOR DISTANCE. Because the probe slides, the
//    achieved y-travel is contaminated by the slide's own downward component, and the
//    error grows with both slope and probe length — for a player resting flush on the
//    surface (true distance 0) the naive `startY - endY` reads 0.0058 at 20 degrees and
//    0.1689 at 44 degrees with a STEP_DOWN sweep. Servoing a ~0.03 gap against a ruler
//    that mis-reads by 0.17 is hopeless.
//
//    So we do not measure the drop; we measure the PLANE. The sweep leaves the
//    ellipsoid tangent to the surface it hit, and `slidePlaneNormal` — which IS
//    populated and exact even when collisionFound is false, matching ground-truth
//    normals to 4dp on all five test slopes — gives that plane's orientation. The
//    vertical distance from where we started to that plane is then
//        floorDist = dot(start - end, N) / N.y
//    which is exact regardless of how far the probe slid. Verified: 1e-6 or better on
//    0/10/20/35/44 degrees at BOTH 0.05 and 0.35 probe lengths.
const sweepFloor = (entity, dist) => {
	const sx = entity.x, sy = entity.y, sz = entity.z
	entity.mesh.computeWorldMatrix(true)
	entity.mesh.moveWithCollisions(new Vector3(0, -dist, 0))
	const px = entity.x, py = entity.y, pz = entity.z
	entity.x = sx; entity.y = sy; entity.z = sz
	// Travelled the whole way => open air below us.
	if (sy - py >= dist - 1e-4) { return null }

	const c = entity.mesh.collider
	const raw = c ? c.slidePlaneNormal : null
	const len = raw ? Math.sqrt(raw.x * raw.x + raw.y * raw.y + raw.z * raw.z) : 0
	if (!raw || len <= 1e-9) {
		// Blocked but no usable plane. Treat as flat floor and fall back to the drop —
		// the same `!n => walkable` convention the vertical phase has always used for
		// box-arena floors and solver paths that report no slide plane.
		return { floorDist: sy - py, nx: 0, ny: 1, nz: 0, walkable: true }
	}
	let nx = raw.x / len, ny = raw.y / len, nz = raw.z / len
	// Orient UP. groundNormalY compares |n.y| so a sign-flipped residual still
	// classifies correctly, but the ramp-parallel delta below needs the genuinely
	// upward normal or it would synthesize the move INTO the ramp instead of along it.
	if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
	return {
		floorDist: ((sx - px) * nx + (sy - py) * ny + (sz - pz) * nz) / ny,
		nx, ny, nz,
		// keep using the validated helper for the walkability test itself
		walkable: groundNormalY(raw) >= MIN_WALK_NORMAL,
	}
}

// UE's FindFloor(). Tests for ground DIRECTLY instead of inferring it from a move
// that happened to be cut short. `moveWithCollisions` + exact save/restore is a
// sweep query: assigning to our OWN transform is not a scene query, so this stays a
// pure function of (entity, command) and is safe to replay during reconciliation —
// unlike scene.pickWithRay, which needs a scene handle applyCommand is never given.
//
// The probe SLIDES on a ramp, so x/z drift during it and the achieved y-travel is
// only an approximation of the true gap (see FLOOR_PROBE). All three components are
// restored exactly; we keep only floorDist and the plane normal.
//
// `slidePlaneNormal` is REUSED by the collider between calls, so it must be cloned
// before any further move, and it is a residual-penetration vector whose LENGTH is
// meaningless — only its direction is the surface normal (see groundNormalY).
//
// allowStepDown: when the short sweep finds nothing, search on down to STEP_DOWN.
// This is where the old phase-3 snap-to-ground lives now — it is the same probe with
// the same distance and the same walkability test, just hoisted so that BOTH the
// pre-move floor query and the post-move one get it.
const NO_FLOOR = Object.freeze({ walkable: false, fromPlane: false, floorDist: STEP_DOWN, nx: 0, ny: 1, nz: 0 })
const findFloor = (entity, allowStepDown) => {
	// Box arenas (!USE_MESH_MAP) have no floor MESH at all — their floor is the
	// analytic plane y = GROUND_Y, enforced by the clamp at the bottom of this file.
	// A swept probe finds nothing there, so without this branch every player standing
	// in a box arena would be reported airborne. The plane is static config, so
	// folding it in analytically keeps the function pure. fromPlane suppresses the
	// hover gap: the gap exists to keep us out of the SOLVER, and an analytic clamp
	// has no depenetration to hide from — hovering there would just float the player
	// 3cm above their own floor and change every box-arena resting height.
	if (!USE_MESH_MAP) {
		const planeDist = entity.y - GROUND_Y
		if (planeDist >= 0 && planeDist <= FLOOR_PROBE) {
			return { walkable: true, fromPlane: true, floorDist: planeDist, nx: 0, ny: 1, nz: 0 }
		}
	}

	const near = sweepFloor(entity, FLOOR_PROBE)
	if (near) {
		// Something is within reach: it decides our state, walkable or not. A steep
		// face right under us means we are NOT standing, and searching further down
		// would only find the same face.
		near.fromPlane = false
		return near
	}
	if (!allowStepDown) { return NO_FLOOR }

	// Nothing within the measuring sweep. We may have walked over the crest of a
	// downhill slope, or off a step: search on down to STEP_DOWN. Because floorDist
	// is exact at any probe length, the caller's AdjustFloorHeight can descend to the
	// surface from here without a second probe.
	const far = sweepFloor(entity, STEP_DOWN)
	if (far && far.walkable) {
		far.fromPlane = false
		return far
	}
	// Really did walk off an edge — stay airborne and fall. Visage is a floating map:
	// walking off MUST drop you (the server kills below KILL_Y).
	return NO_FLOOR
}

// UE's AdjustFloorHeight(). UE never lets the capsule rest ON the floor; it servos it
// to HOVER in a dead band above it, so the collider is never interpenetrating when the
// next move starts. That is the whole reason the ramp fix is stable: interpenetration
// is what makes the solver spend a move pushing us back out instead of moving us
// along, and once the gap is held penetration stops happening, so the scheme is
// self-reinforcing.
//
// The correction is a swept move (so it cannot shove us through a ceiling), but it is
// a FREE move in practice: to descend we travel floorDist - TARGET, which is strictly
// less than floorDist, so it never reaches the floor and never slides. x/z are
// restored anyway, in case a ceiling deflects it.
const adjustFloorHeight = (entity, fl) => {
	if (fl.fromPlane) { return }
	if (fl.floorDist >= FLOOR_GAP_MIN && fl.floorDist <= FLOOR_GAP_MAX) { return }
	const sx = entity.x, sz = entity.z
	entity.mesh.computeWorldMatrix(true)
	entity.mesh.moveWithCollisions(new Vector3(0, FLOOR_GAP_TARGET - fl.floorDist, 0))
	entity.x = sx; entity.z = sz
}

// CLIP velocity against the slide plane — Source/Quake PM_ClipVelocity. Unchanged in
// substance; hoisted out of the (previously single) horizontal phase into a helper
// because BOTH move paths now need it: the walking move still has to be stopped by
// walls, and the airborne move still has to be stopped by everything.
//
// This REPLACED a `velX = (x - oldX) / delta` re-derivation, which was the direct
// cause of walking downhill collapsing to 0.85 m/s on a 20-degree ramp
// (GROUND_SPEED is 7.6).
//
// WHY RE-DERIVATION HAD TO GO. Babylon's collide-and-slide does not only move you:
// it also DEPENETRATES, shoving the ellipsoid back out of any surface it is already
// intersecting. Walking downhill you sink a hair into the ramp every tick, so the
// next move begins with a push-out that is UP and BACKWARD (measured on the 20deg
// ramp: dx = -0.0051m, dy = +0.0188m). Re-derivation cannot tell that correction
// apart from real travel, so it promoted it into momentum: velX became
// -0.0051/0.025 = -0.2052 m/s, i.e. the solver's error correction OVERWROTE the
// player's speed every single tick. Ground accel then had to restart from ~zero,
// which is exactly the 0.85 m/s average we measured.
//
// PROOF this is depenetration and not slide deflection: at tick 0 with velocity
// EXACTLY ZERO — the horizontal phase passing a zero-length vector, so there is
// nothing to deflect — the entity still moved 0.0057m. Displacement with no requested
// motion can only be push-out. Any scheme that reads velocity back out of position is
// therefore reading solver noise, and no threshold or dead-zone fixes that, because
// on a slope the push-out is the same order as a real tick of travel.
//
// WHAT REPLACED IT: velocity is now changed ONLY by accel, friction, and this
// subtractive projection — never by position. We remove the component of velocity
// pointing INTO the plane and keep everything along it:
//     v' = v - N * dot(v, N)
// Walls therefore still absorb speed exactly as before (running head-on at a wall,
// v is entirely into the plane, so the whole horizontal velocity is removed and
// nothing is stored to slingshot you when you strafe off) — that was the reason
// re-derivation existed, and clipping serves it without reading the solver's error.
//
// slidePlaneNormal is NOT unit length (see groundNormalY above — its magnitude is
// residual penetration), so it MUST be normalized before use as a projection axis
// or the subtraction is scaled by an arbitrary factor.
//
// The `dot < 0` guard is load-bearing, and its sign behaviour is EMPIRICAL, not
// assumed — measured per-tick on the 20deg ramp BEFORE the ramp-parallel move
// existed, when the walking move still contacted the ramp every tick:
//   DOWNHILL: the outward normal tilts downhill (unit n = -0.342, 0.940, 0.000 with
//             velX negative), so dot is POSITIVE — +2.5994 at steady state, and
//             POSITIVE on 38 of the 38 measured contacts. We do NOT clip; velocity
//             is untouched and the full 7.600 m/s GROUND_SPEED survives.
//   UPHILL:   same normal, velX now positive, so dot is NEGATIVE — -2.5994 at
//             steady state, NEGATIVE on 6 of 6 measured contacts. Motion really is
//             into the plane, so we clip, and uphill costs speed as it should.
// Clipping unconditionally (dropping the guard) would subtract from downhill motion
// too and re-break the very bug this fixes. A walking move no longer contacts the
// ramp at all (see B), so on a clean slope this helper is now a no-op in both
// directions — but the guard stays, because creases, steps and slope transitions do
// still produce ramp contacts and the sign reasoning above still governs them.
//
// NO COLLISION => velocity is left EXACTLY as it was. Never re-derive from position.
const clipVelocityToSlidePlane = (entity) => {
	const collider = entity.mesh.collider
	if (collider && collider.collisionFound) {
		const rawN = collider.slidePlaneNormal
		const len = Math.sqrt(rawN.x * rawN.x + rawN.y * rawN.y + rawN.z * rawN.z)
		if (len > 1e-9) {
			const nx = rawN.x / len
			const nz = rawN.z / len
			const dot = entity.velX * nx + entity.velZ * nz
			if (dot < 0) {
				entity.velX -= nx * dot
				entity.velZ -= nz * dot
			}
		}
	}
}

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
	// Did a dodge ACTUALLY fire this tick? Phase 3 (snap-to-ground) must not be
	// suppressed by merely PRESSING dodge — a dodge only happens when the cooldown has
	// expired, so gating on `command.dodge` disabled snapping for the whole 0.35s
	// cooldown whenever a player kept the key held or tapped it (measured on a
	// 20-degree ramp: grounded duty cycle fell from 100% to 13%, which switches ground
	// friction off and brings back the ice-slide this file exists to prevent).
	// Deliberately a LOCAL, not an entity field: it is derived fresh from
	// (entity, command) every call, so it must never be replicated or it would become
	// state that reconciliation replay could disagree about.
	let dodgeFired = false
	const yawMatrix = Matrix.RotationAxis(Axis.Y, entity.mesh.rotation.y)
	const wish = Vector3.TransformCoordinates(new Vector3(ix, 0, iz), yawMatrix)
	const wishLen = Math.hypot(wish.x, wish.z)
	const wishX = wishLen > 0 ? wish.x / wishLen : 0
	const wishZ = wishLen > 0 ? wish.z / wishLen : 0

	// ---------------------------------------------------------------------------
	// A. FIND FLOOR, UP FRONT (UE: CurrentFloor, refreshed at the top of PhysWalking).
	//
	// Ground state used to be INFERRED — "the vertical move came up short, so I must
	// be standing on something". That is only ever true after the fact, so nothing
	// earlier in the tick could know the surface it was standing on, and in particular
	// the move itself could not be built to lie along that surface. Testing for the
	// floor directly, before anything else happens, is what makes B below possible.
	//
	// Only runs when we ENTER the tick grounded. A player who is genuinely airborne
	// still earns their landing from the vertical sweep further down: probing an
	// airborne player would snap them out of a fall the instant they passed within
	// STEP_DOWN of a floor, which would flatten jump arcs and break landings.
	//
	// The result is also where the hover gap is (re)established, so acceleration,
	// jumping and jump-pads all run from a known, non-interpenetrating position.
	// ---------------------------------------------------------------------------
	let floorNX = 0, floorNY = 0, floorNZ = 0, haveFloor = false
	if (entity.grounded) {
		const fl = findFloor(entity, true)
		entity.grounded = fl.walkable
		if (fl.walkable) {
			adjustFloorHeight(entity, fl)
			if (!fl.fromPlane) { floorNX = fl.nx; floorNY = fl.ny; floorNZ = fl.nz; haveFloor = true }
		}
	}

	// D. UE's MaintainHorizontalGroundVelocity: while walking, velocity is a purely
	// horizontal quantity. Zeroing it here — BEFORE friction and acceleration, which
	// is the order UE uses — means any residual vertical snap from the floor probe or
	// the gap servo contributes exactly nothing to the next move, and gravity has
	// nothing to accumulate into while we are standing on something.
	if (entity.grounded) { entity.velY = 0 }

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
			dodgeFired = true
		} else if (command.jump) {
			entity.velY = JUMP_SPEED
			entity.grounded = false
		}
	} else if (wishLen > 0) {
		// Quake-style air acceleration / strafe jumping
		accelerate(entity, wishX, wishZ, MAX_AIR_WISH_SPEED, AIR_ACCEL, delta)
	}

	// Jump-pads (Facing Worlds tower lifts). Deterministic: static map data, fixed
	// iteration order, reads only synced entity state (x/z/y/grounded) — never the
	// command — so client prediction, reconciliation replay, and server authority all
	// agree. Fires only while grounded and standing on the pad's top face; sets velY
	// and grounded=false BEFORE gravity integrates this tick.
	if (entity.grounded) {
		for (let i = 0; i < JUMP_PADS.length; i++) {
			const p = JUMP_PADS[i]
			const topY = p.height - 0.5
			if (
				entity.x >= p.x - p.width * 0.5 - 0.5 && entity.x <= p.x + p.width * 0.5 + 0.5 &&
				entity.z >= p.z - p.depth * 0.5 - 0.5 && entity.z <= p.z + p.depth * 0.5 + 0.5 &&
				entity.y >= topY - 0.2 && entity.y <= topY + 1.2
			) {
				entity.velX = p.launchX
				entity.velY = p.launchY
				entity.velZ = p.launchZ
				entity.grounded = false
				break
			}
		}
	}

	// Gravity now integrates ONLY while airborne. It used to run unconditionally, which
	// meant a standing player pumped -0.45 m/s into the floor every single tick; the
	// vertical sweep then had to collide that into the ramp, sinking the ellipsoid a
	// little further in each time. That sink is the interpenetration the whole
	// restructure exists to remove, so the pump has to stop at the source.
	// NOTE this still fires on the tick you jump, dodge or hit a jump-pad: all three
	// set grounded = false BEFORE this line, so JUMP_SPEED / DODGE_UP / launchY each
	// still lose exactly one tick of gravity, as they always have.
	if (!entity.grounded) {
		entity.velY -= GRAVITY * delta
		if (entity.velY < -TERMINAL_FALL) {
			entity.velY = -TERMINAL_FALL
		}
	}

	// ---------------------------------------------------------------------------
	// INTEGRATE. Two completely different paths now: WALKING (one ramp-parallel move,
	// no gravity, no vertical sweep) and AIRBORNE (the horizontal-then-vertical split
	// documented below). Which one runs is decided by the explicit floor probe above,
	// not by guessing from a cut-short move.
	//
	// This used to be ONE combined moveWithCollisions of (velX, velY, velZ) * delta,
	// which is what made sloped mesh maps (CTF-Visage) feel like they had "strong
	// gravity": you slid downhill while standing still. The mechanism was a feedback
	// loop between the solver and the velocity re-derivation below —
	//
	//   1. gravity puts -0.45 m/s into velY every tick even while grounded,
	//   2. collide-and-slide projects that downward move along the slope, turning it
	//      into DOWNHILL HORIZONTAL displacement,
	//   3. `velX = (x - oldX) / delta` promoted that displacement into real, persistent
	//      horizontal momentum, which fed step 2 harder on the next tick,
	//   4. and once the downhill creep passed ~1.13 m/s the old grounded test (which
	//      measured TOTAL y movement, so horizontal speed on a slope contaminated it)
	//      started reporting airborne — switching ground friction OFF entirely, so
	//      nothing was left to oppose the slide.
	//
	// Splitting the move broke the middle of that chain: the vertical phase's sideways
	// deflection is DISCARDED on walkable ground instead of becoming momentum.
	//
	// Step 3 above — the re-derivation itself — is now gone too, and that is a SEPARATE,
	// later fix. Confining re-derivation to the horizontal phase stopped the standing
	// slide, but it left walking DOWNHILL collapsing to 0.85 m/s against a GROUND_SPEED
	// of 7.6, because phase 1's own displacement is contaminated by the solver's
	// depenetration push-out. Phase 1 now uses Quake/Source PM_ClipVelocity against the
	// normalized slide plane instead, and never reads velocity back out of position.
	// The long comment at the clipping block below has the measurements.
	//
	// The one surviving re-derivation is in phase 2's STEEP-face branch, and it is
	// deliberate: there the sideways deflection is not solver noise, it IS the physical
	// slide down an unwalkable face, and we want it promoted to momentum.
	//
	// Babylon 9 headless note (applies to every moveWithCollisions below): getRenderId()
	// never advances under NullEngine (server) or during client prediction-replay, so
	// getAbsolutePosition() returns a stale world matrix and the move tunnels through
	// walls / never rests on the ground. computeWorldMatrix(true) recomputes it,
	// bypassing the frozen-renderId cache guard (transformNode:
	// _currentRenderId===currentRenderId short-circuit added in 9.x). Validated
	// bit-for-bit vs 4.0.3; a harmless no-op there.
	// ---------------------------------------------------------------------------
	const wasGrounded = entity.grounded

	if (entity.grounded) {
		// =======================================================================
		// B. WALKING MOVE — UE's ComputeGroundMovementDelta(). THE ACTUAL FIX.
		//
		// The delta enters horizontal: (velX*dt, 0, velZ*dt). Moving it as-is is what
		// was destroying downhill travel. Horizontal motion on a downhill ramp aims
		// the ellipsoid slightly INTO the surface it is standing on, so the sweep
		// contacts the ramp, the solver deflects it, and — because we were already
		// interpenetrating from the previous tick's gravity — spends the move pushing
		// us back OUT rather than moving us along. Measured on the 20-degree ramp that
		// produced a stable 3-tick cycle in which every third move was eaten:
		// requested dx -0.1900, achieved dx -0.0051, and only 63.5% of the requested
		// travel was realised even though velocity read a full 7.600 m/s.
		//
		// UE never moves a walking character horizontally. It synthesizes the vertical
		// component so the delta lies IN the floor plane:
		//     FloorDot = N . Delta ;  Delta.Z = -FloorDot / N.Z     (their Z is up)
		// X and Y pass through UNTOUCHED — which is exactly why horizontal SPEED is
		// preserved going up and down a slope, and why the along-surface distance is
		// correspondingly longer. Because the move is already parallel to the surface
		// it never contacts the ramp at all: no slide, no deflection, no depenetration
		// to eat it, and the sweep is left free to do its real job of stopping us at
		// walls.
		//
		// Guarded as UE guards it: only on a walkable normal (findFloor already
		// enforced MIN_WALK_NORMAL), only when N.y is meaningfully non-zero, and
		// skipped entirely for the analytic box-arena plane where N is (0,1,0) and the
		// synthesized component would be zero anyway.
		// =======================================================================
		const dx = entity.velX * delta
		const dz = entity.velZ * delta
		let dy = 0
		if (haveFloor && floorNY > 1e-4) {
			dy = -(floorNX * dx + floorNZ * dz) / floorNY
		}
		entity.mesh.computeWorldMatrix(true)
		entity.mesh.moveWithCollisions(new Vector3(dx, dy, dz))
		clipVelocityToSlidePlane(entity)
	} else {
		// =======================================================================
		// AIRBORNE PATH — the horizontal-then-vertical split, unchanged. A player who
		// is genuinely off the ground has no floor plane to move parallel to, so this
		// is still the right shape: gravity integrates, the horizontal move happens
		// first so wall absorption is unaffected by it, and the vertical move is what
		// EARNS a landing.
		// =======================================================================

		// PHASE 1 — horizontal. Collide-and-slide along walls; this phase may also raise y
		// (that is how you walk UP a ramp or a step). Note there is deliberately no
		// pre-move x/z snapshot here any more: nothing downstream is allowed to look at
		// how far this move actually got (see the clipping block below for why).
		entity.mesh.computeWorldMatrix(true)
		entity.mesh.moveWithCollisions(new Vector3(entity.velX * delta, 0, entity.velZ * delta))
		clipVelocityToSlidePlane(entity)

		// PHASE 2 — vertical (gravity fall / jump arc).
		const preY = entity.y
		const preX = entity.x
		const preZ = entity.z
		entity.mesh.computeWorldMatrix(true)
		entity.mesh.moveWithCollisions(new Vector3(0, entity.velY * delta, 0))
		const movedY = entity.y - preY

		// The vertical move was cut short => we landed on something. Ask the collider what
		// we landed ON: normal.y >= MIN_WALK_NORMAL is walkable floor, anything less is a
		// steep face we should slide down.
		const blocked = entity.velY <= 0 && movedY - entity.velY * delta > 0.001
		let walkable = false
		if (blocked) {
			const collider = entity.mesh.collider
			const n = collider && collider.collisionFound ? collider.slidePlaneNormal : null
			// No collider normal (box-arena floor plane, or a solver path that reports no
			// slide plane) => treat as flat floor, which is what those surfaces are.
			walkable = !n || groundNormalY(n) >= MIN_WALK_NORMAL
		}

		if (blocked && walkable) {
			// Standing on real floor. Discard the sideways deflection this vertical move
			// produced — that deflection IS the phantom downhill slide — and kill the
			// downward velocity so gravity stops pumping into the slope next tick.
			entity.x = preX
			entity.z = preZ
			entity.grounded = true
			entity.velY = 0
		} else if (blocked) {
			// Too steep to stand on. This is a genuine slide: KEEP the deflection and let
			// it become horizontal momentum, so steep faces shed you with real speed
			// instead of sticking. Gravity keeps accumulating (we stay airborne).
			entity.velX = (entity.x - preX) / delta
			entity.velZ = (entity.z - preZ) / delta
			entity.grounded = false
		} else {
			entity.grounded = false
		}

		// PHASE 3 — snap-to-ground. If we came into this tick standing and are not jumping,
		// but the vertical phase left us airborne, we most likely just walked over the crest
		// of a downhill slope and out-ran gravity (see STEP_DOWN). Probe down; if walkable
		// floor is within reach, stay glued to it so friction and ground accel keep running.
		// If nothing is there we really did walk off an edge — restore and fall (Visage is a
		// floating map: walking off MUST drop you into the void).
		// Gated on `dodgeFired`, NOT on `command.dodge` — see the declaration above.
		if (wasGrounded && !entity.grounded && entity.velY <= 0 && !command.jump && !dodgeFired) {
			const sx = entity.x
			const sy = entity.y
			const sz = entity.z
			entity.mesh.computeWorldMatrix(true)
			entity.mesh.moveWithCollisions(new Vector3(0, -STEP_DOWN, 0))
			const snapped = entity.y - sy
			const collider = entity.mesh.collider
			const n = collider && collider.collisionFound ? collider.slidePlaneNormal : null
			const snapWalkable = !n || groundNormalY(n) >= MIN_WALK_NORMAL
			if (snapped > -STEP_DOWN + 0.001 && snapWalkable) {
				// found floor within a step — glue to it (keep the probe's y, drop its
				// sideways deflection for the same reason phase 2 does)
				entity.x = sx
				entity.z = sz
				entity.grounded = true
				entity.velY = 0
			} else {
				entity.x = sx
				entity.y = sy
				entity.z = sz
			}
		}

	} // end AIRBORNE path

	// ---------------------------------------------------------------------------
	// A'. RE-FIND FLOOR, then C. ADJUST FLOOR HEIGHT (UE: FindFloor +
	// AdjustFloorHeight at the tail of PhysWalking).
	//
	// The move is done; re-test for ground rather than trusting what we believed
	// before it. This is what catches walking off a ledge (the probe finds nothing
	// within STEP_DOWN, grounded goes false, and the next tick is a fall) and what
	// re-establishes the hover gap after a landing or a step-down left the ellipsoid
	// sitting flush on — or slightly inside — the surface.
	//
	// Ordering is UE's and it matters: probe and height-adjust happen AFTER the move
	// and BEFORE velocity is touched again. Doing the height adjust first would servo
	// against a stale floor, and touching velocity first would reintroduce the vertical
	// component the walking path is defined not to have.
	//
	// The step-down search is gated exactly as the old phase 3 was — on `dodgeFired`
	// rather than `command.dodge`, and never on the tick a jump/dodge/jump-pad
	// deliberately left the ground (all three clear `wasGrounded` before this point,
	// so a launch can never be snapped back down).
	// ---------------------------------------------------------------------------
	if (entity.grounded) {
		const fl2 = findFloor(entity, wasGrounded && !command.jump && !dodgeFired)
		entity.grounded = fl2.walkable
		if (fl2.walkable) {
			entity.velY = 0
			adjustFloorHeight(entity, fl2)
		}
	}

	// Box arenas use y>=GROUND_Y as their (invisible) floor. Mesh maps have REAL floors
	// with edges — so we DON'T clamp: players rest on the mesh via moveWithCollisions and
	// fall off ledges into the void (the server kills them below KILL_Y). See mapMesh.js.
	if (!USE_MESH_MAP && entity.y < GROUND_Y) {
		entity.y = GROUND_Y
		if (entity.velY < 0) {
			entity.grounded = true
			entity.velY = 0
		}
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
