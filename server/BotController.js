// UT99-style deathmatch bot brain.
//
// A bot owns NO special powers: it synthesizes the same MoveCommand-shaped
// object a human client sends (camRay aim + wasd/jump + fireInput) and the
// GameInstance runs it through the exact same applyCommand physics and
// performShot weapon authority. Everything that makes it beatable is here:
//   * turn-rate-limited aim (it swings onto you, never snaps)
//   * per-burst aim error (it misses like a mid-skill UT bot)
//   * trigger discipline (bursts with pauses, only fires roughly on target)
//   * line-of-sight checks against the REAL map geometry (it can't wallhack)
//   * wander targets on real walkable floor (it can't walk into the void)
//   * strafe-orbiting at its weapon's preferred range, occasional jumps
import * as BABYLON from '../common/babylon.node.js'
import { weapons } from '../common/weaponsConfig'
import { USE_MESH_MAP, MAP_MESH } from '../common/mapMesh'
import { nearestWorldHit } from './lagCompensatedHitscanCheck'

const TURN_RATE = 3.4          // rad/s — swings onto a target in ~0.3-0.9s
const RETARGET_MS = 900        // how often it reconsiders who to fight
const AIM_ERR_YAW = 0.055      // rad, re-rolled each burst (~±1.6°)
const AIM_ERR_PITCH = 0.03
const FIRE_CONE = 0.13         // rad — only pulls the trigger this close to on-target

// LoS re-evaluation interval. A cross-map ray on CTF-Visage costs ~100-300us (it is
// up to 105m long, so the bounding-sphere pre-reject in nearestWorldHit prunes far
// less than it does for a typical short hitscan pellet). Running that every bot every
// tick at 40Hz is real money; re-checking ~8x/second is not, and a bot whose knowledge
// of "can I see you" is up to 150ms stale reads as HUMAN reaction time rather than as
// a bug. The result is invalidated immediately on a target switch, and the jitter
// keeps a full roster from re-evaluating on the same tick.
const LOS_INTERVAL_MS = 120
const LOS_JITTER_MS = 60

// ---------------------------------------------------------------------------
// World geometry access
// ---------------------------------------------------------------------------
// Bot LoS and server shot resolution MUST agree, so both consult the SAME meshes:
// GameInstance.occluderMeshes (subdivided, disabled clones of the map collider on a
// mesh map; the Obstacle boxes on a box arena). think() is only handed `this.obstacles`,
// which is an EMPTY Map on a mesh map — that emptiness is the wallhack bug: the old
// loop simply never ran and every LoS query returned true.
//
// GameInstance is owned by another change right now, so rather than widen think()'s
// signature we recover the occluders from the scene the bot's own mesh lives in
// (server/GameInstance.js builds them there, named `occluder_<i>`). That naming is the
// one piece of coupling here and it is worth removing: see the note at the bottom of
// this file — passing this.occluderMeshes into think() is strictly better.
const EMPTY = []
const boxCache = new WeakMap()
const sceneCache = new WeakMap()

const worldMeshes = (me, obstacles) => {
	// box arena: the obstacles Map is populated and is itself the occluder set
	if (obstacles && obstacles.size > 0) {
		let c = boxCache.get(obstacles)
		if (!c || c.size !== obstacles.size) {
			c = { size: obstacles.size, meshes: [...obstacles.values()].map(o => o.mesh).filter(Boolean) }
			boxCache.set(obstacles, c)
		}
		return c.meshes
	}
	const scene = me.mesh && me.mesh.getScene && me.mesh.getScene()
	if (!scene) return EMPTY
	let c = sceneCache.get(scene)
	// re-scan while empty: the map mesh loads async, so the first few bot ticks after
	// boot legitimately find nothing. Once populated the list is static and cached.
	if (!c || c.meshes.length === 0) {
		c = { meshes: scene.meshes.filter(m => m.name && m.name.indexOf('occluder_') === 0) }
		sceneCache.set(scene, c)
	}
	return c.meshes
}

// LoS: a ray from the bot's chest to the target's, blocked by any world geometry
// strictly between them. Reuses server/lagCompensatedHitscanCheck.js's nearestWorldHit
// so "the bot thinks it can see you" and "the server lets the bullet through" are
// decided by one implementation against one mesh set.
const hasLineOfSight = (me, target, meshes) => {
	const dx = target.x - me.x
	const dy = target.y - me.y
	const dz = target.z - me.z
	const dist = Math.hypot(dx, dy, dz)
	if (dist < 0.001) return true
	if (!meshes || meshes.length === 0) return true   // no collider yet (async map load)
	const ray = new BABYLON.Ray(
		me.mesh.position,
		new BABYLON.Vector3(dx / dist, dy / dist, dz / dist),
		dist
	)
	return nearestWorldHit(meshes, ray, dist) >= dist
}

// ---------------------------------------------------------------------------
// Navigable point set (mesh maps)
// ---------------------------------------------------------------------------
// The old wander box was a hardcoded rectangle sized for the BOX arena. On CTF-Visage
// 28.9% of the points it produced were over open void (measured) and it capped at
// x=32, so a bot could never reach the east base at x 60-79. Instead of a new magic
// rectangle (there are 9 maps coming), derive the walkable set from the MAP ITSELF:
//
//   1. probe a grid of downward rays over the map's own spawn bounding box + margin
//   2. keep cells whose topmost surface is walkable (|normal.y| >= MIN_WALK_NORMAL,
//      the same 0.7 common/applyCommand.js uses) and above killY
//   3. flood-fill from the cells under the map's real spawn points, so the kept set is
//      exactly the floor CONTINUOUSLY connected to somewhere a player starts
//
// Everything comes from data mapMesh.js already publishes (spawns, scale, killY), so
// no per-map authoring is needed and a new map works the day it is added.
//
// Deliberate limitation: step 3 samples only the TOPMOST surface, so floor directly
// underneath other geometry is invisible to it. On CTF-Visage the play area is a single
// layer (two decks joined by an arched bridge) so nothing is lost, and the upside is
// large: tower roofs and upper floors are naturally excluded, because they are cut off
// from the deck by a height step the flood fill will not cross.
const MIN_WALK_NORMAL = 0.7    // == common/applyCommand.js
const NAV = {
	step: 2.0,          // grid resolution, world units
	margin: 15,         // how far past the spawn bbox to probe
	dyMax: 1.2,         // max floor-height change between adjacent cells (ramp, not ledge)
	maxSlope: 1.0,      // max rise-per-run along a straight walk (45 degrees)
	stepUp: 0.45,       // == applyCommand MAX_STEP_HEIGHT
	hopRadius: 22,      // how far one wander hop may reach
	tries: 4,           // straight-line candidates tested per wander pick
	probesPerTick: 60,  // build budget: ~3ms/tick, whole grid inside ~1s
}

// Nearest floor below (x,z): topmost surface, with its normal. nearestWorldHit cannot
// serve here — it returns a distance but no normal, and walkability IS the normal — so
// this is the one extra raycast loop in the file. It mirrors nearestWorldHit's
// bounding-sphere pre-reject so it costs the same per mesh.
const DOWN = new BABYLON.Vector3(0, -1, 0)
const floorProbe = (meshes, x, z, fromY, len) => {
	const ray = new BABYLON.Ray(new BABYLON.Vector3(x, fromY, z), DOWN, len)
	let best = null
	for (let i = 0; i < meshes.length; i++) {
		const mesh = meshes[i]
		const bs = mesh.getBoundingInfo && mesh.getBoundingInfo().boundingSphere
		if (bs) {
			const near = (fromY - bs.centerWorld.y) - bs.radiusWorld
			if (near > len || (best && near > best.distance)) continue
		}
		const pi = ray.intersectsMesh(mesh)
		if (pi.hit && (!best || pi.distance < best.distance)) best = pi
	}
	if (!best) return null
	const n = best.getNormal(true, true)
	// groundNormalY compares |n.y| (see applyCommand) — OBJ winding may point either way
	return { y: fromY - best.distance, ny: n ? Math.abs(n.y) : 1 }
}

const navCache = new WeakMap()

const newNav = () => {
	const sc = MAP_MESH.scale || 1
	const spawns = (MAP_MESH.spawns || []).map(s => ({ x: s.x * sc, y: s.y * sc, z: s.z * sc }))
	if (spawns.length === 0) return null
	const m = NAV.margin
	const minX = Math.min(...spawns.map(s => s.x)) - m
	const maxX = Math.max(...spawns.map(s => s.x)) + m
	const minZ = Math.min(...spawns.map(s => s.z)) - m
	const maxZ = Math.max(...spawns.map(s => s.z)) + m
	const killY = (MAP_MESH.killY || -1e9) * sc
	// start every probe above the tallest thing a spawn could sit under, and run it
	// down past killY so the ray cannot stop short of the floor
	const topY = Math.max(...spawns.map(s => s.y)) + 60
	const nx = Math.ceil((maxX - minX) / NAV.step) + 1
	const nz = Math.ceil((maxZ - minZ) / NAV.step) + 1
	return {
		ready: false, cursor: 0, lastTick: -1,
		nx, nz, minX, minZ, topY, killY, probeLen: topY - killY + 5,
		grid: new Array(nx * nz).fill(null),
		spawns, nodes: []
	}
}

// Probe a slice of the grid. Budgeted so the ~2350-ray build never stalls a tick:
// NAV.probesPerTick cells per SERVER tick (all bots in a tick share `now`, so a full
// roster does not multiply the cost), finishing in ~1s. Until then the bot wanders
// between the map's spawn points, which are walkable by definition.
const advanceNav = (nav, meshes, now) => {
	if (nav.ready || nav.lastTick === now) return
	nav.lastTick = now
	const end = Math.min(nav.grid.length, nav.cursor + NAV.probesPerTick)
	for (; nav.cursor < end; nav.cursor++) {
		const i = (nav.cursor / nav.nz) | 0
		const j = nav.cursor % nav.nz
		const x = nav.minX + i * NAV.step
		const z = nav.minZ + j * NAV.step
		const f = floorProbe(meshes, x, z, nav.topY, nav.probeLen)
		if (f && f.ny >= MIN_WALK_NORMAL && f.y > nav.killY + 3) nav.grid[nav.cursor] = { x, y: f.y, z }
	}
	if (nav.cursor < nav.grid.length) return

	// grid complete -> flood fill from the cells under the real spawn points
	const { nx, nz, grid } = nav
	const seen = new Uint8Array(nx * nz)
	const queue = []
	nav.spawns.forEach(s => {
		const ci = Math.round((s.x - nav.minX) / NAV.step)
		const cj = Math.round((s.z - nav.minZ) / NAV.step)
		let bk = -1, bd = Infinity
		for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
			const ii = ci + di, jj = cj + dj
			if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue
			const g = grid[ii * nz + jj]
			if (!g || Math.abs(g.y - s.y) > 4) continue
			const d = (g.x - s.x) ** 2 + (g.z - s.z) ** 2
			if (d < bd) { bd = d; bk = ii * nz + jj }
		}
		if (bk >= 0 && !seen[bk]) { seen[bk] = 1; queue.push(bk) }
	})
	while (queue.length) {
		const k = queue.pop()
		const i = (k / nz) | 0, j = k % nz
		for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
			if (!di && !dj) continue
			const ii = i + di, jj = j + dj
			if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue
			const kk = ii * nz + jj
			if (seen[kk] || !grid[kk]) continue
			// a ramp (bridge arch, tower approach) steps a little; a ledge steps a lot
			if (Math.abs(grid[kk].y - grid[k].y) > NAV.dyMax * (di && dj ? 1.414 : 1)) continue
			seen[kk] = 1; queue.push(kk)
		}
	}
	nav.nodes = grid.filter((g, k) => g && seen[k])
	nav.ready = true
	console.log(`[bot-nav] ${nav.nodes.length} walkable nodes (${nav.nx}x${nav.nz} grid, step ${NAV.step}) reachable from spawns`)
}

// REACHABILITY. Bots have no pathfinder — they point themselves at a spot and hold W —
// so "walkable" is not enough: the STRAIGHT LINE to the target must be walkable too, or
// the bot walks off the deck trying to cross a gap. Sample the segment and require every
// sample to be walkable floor AND to be continuous with the one before it (a rise no
// steeper than maxSlope, so the arched bridge passes and a ledge or gap does not).
const straightWalk = (nav, meshes, ax, az, bx, bz) => {
	const d = Math.hypot(bx - ax, bz - az)
	const n = Math.max(1, Math.ceil(d / (NAV.step * 0.75)))
	const spacing = d / n
	const limit = NAV.maxSlope * spacing + NAV.stepUp
	let prevY = null
	for (let i = 0; i <= n; i++) {
		const t = i / n
		const f = floorProbe(meshes, ax + (bx - ax) * t, az + (bz - az) * t, nav.topY, nav.probeLen)
		if (!f || f.ny < MIN_WALK_NORMAL || f.y <= nav.killY + 3) return false
		if (prevY !== null && Math.abs(f.y - prevY) > limit) return false
		prevY = f.y
	}
	return true
}

// Pick the next wander target: a real walkable node the bot can reach by walking in a
// straight line. Short hops chain — the whole navigable set is ONE straight-line-hop
// component at this radius (verified in _work/botfix/probe-nav5.ts), so a bot with no
// pathfinder still tours the entire map, bases and bridge included, over time.
const pickWander = (nav, meshes, me) => {
	// Still probing (roughly the first second after the map mesh resolves): DON'T wander.
	// The tempting fallback — "head for a random spawn point, those are walkable" — is
	// itself the void bug in miniature: spawns sit on both bases, so the straight line
	// from a west-base bot to an east-base spawn is a 105m walk over open nothing.
	// A bot that stands still for a second is strictly better than one that walks off
	// the map, and think() retries this on a short backoff.
	if (!nav.ready || nav.nodes.length === 0) return null
	const near = []
	let closest = null, closestD = Infinity
	for (let i = 0; i < nav.nodes.length; i++) {
		const n = nav.nodes[i]
		const d = Math.hypot(n.x - me.x, n.z - me.z)
		if (d < closestD) { closestD = d; closest = n }
		if (d > 3 && d <= NAV.hopRadius) near.push(n)
	}
	for (let t = 0; t < NAV.tries && near.length; t++) {
		const n = near[Math.floor(Math.random() * near.length)]
		if (straightWalk(nav, meshes, me.x, me.z, n.x, n.z)) return { x: n.x, z: n.z }
	}
	// nothing straight-line reachable (bot is off the deck, cornered, or mid-air):
	// head for the nearest walkable node — the best recovery a steering-only bot has
	return closest ? { x: closest.x, z: closest.z } : null
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
		// throttled LoS cache
		this.losTarget = null
		this.losAt = 0
		this.losResult = false
	}

	// One AI tick: returns a MoveCommand-shaped plain object for applyCommand.
	// `combatants` = alive entities it may fight (never includes itself).
	think(delta, now, combatants, obstacles) {
		const me = this.entity
		const meshes = worldMeshes(me, obstacles)
		// Advance the navigable-point build EVERY tick, not just when a wander target is
		// wanted. Picks happen at most once per 4s per bot, which is nowhere near enough
		// ticks to finish a ~2350-ray grid — left to the pick path the set never became
		// ready at all and every bot fell back to "walk at a random spawn point", i.e.
		// straight across the void. advanceNav is idempotent per server tick (all bots in
		// a tick share `now`), so a full roster costs the same as one bot.
		const nav = this.navFor(meshes, now)

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
		const alive = target && target.isAlive !== false
		// LoS is the expensive part of a bot tick, so re-evaluate on a timer rather than
		// every tick — but never carry a stale answer across a target switch.
		if (!alive) {
			this.losResult = false
			this.losTarget = null
		} else if (target !== this.losTarget || now >= this.losAt) {
			this.losTarget = target
			this.losAt = now + LOS_INTERVAL_MS + Math.random() * LOS_JITTER_MS
			this.losResult = hasLineOfSight(me, target, meshes)
		}
		const seesTarget = alive && this.losResult

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
			// a new wander target is chosen fresh next time it loses sight
			this.wander = null
		} else {
			// no target in sight: wander to a point on real walkable floor
			const wanderDone = this.wander &&
				Math.hypot(this.wander.x - me.x, this.wander.z - me.z) < 1.5
			if (!this.wander || wanderDone || now >= this.wanderUntil) {
				this.wander = this.pickWanderTarget(nav, meshes)
				// no target available yet (nav still probing, or the bot is somewhere with
				// nothing straight-line reachable) -> retry soon instead of idling 4s
				this.wanderUntil = now + (this.wander ? 4000 : 250)
			}
			if (this.wander) {
				wishYaw = Math.atan2(this.wander.x - me.x, this.wander.z - me.z)
				forwards = true
			}
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

	// Get-or-create this scene's navigable point set and push its incremental build
	// along by one tick's budget. Null on a box arena or before the map mesh exists.
	navFor(meshes, now) {
		if (!USE_MESH_MAP || !meshes || meshes.length === 0) return null
		const scene = this.entity.mesh && this.entity.mesh.getScene && this.entity.mesh.getScene()
		if (!scene) return null
		let nav = navCache.get(scene)
		if (nav === undefined) {
			nav = newNav()
			navCache.set(scene, nav)
		}
		if (!nav) return null
		advanceNav(nav, meshes, now)
		return nav
	}

	// Mesh map: a probed, spawn-connected, straight-line-reachable floor point.
	// Box arena: the original random point inside the arena — that path has a flat
	// floor at y=0 with no edges to fall off, so there is nothing to fix there.
	pickWanderTarget(nav, meshes) {
		if (!USE_MESH_MAP) {
			return { x: (Math.random() * 2 - 1) * 32, z: (Math.random() * 2 - 1) * 15 }
		}
		if (!nav) return null
		return pickWander(nav, meshes, this.entity)
	}
}

// NOTE for whoever next owns server/GameInstance.js: think() should be handed
// `this.occluderMeshes` instead of (or alongside) `this.obstacles`. GameInstance already
// maintains that array on BOTH the mesh-map and box-arena paths, and passing it would
// delete the `occluder_<i>` name-matching in worldMeshes() above — the only fragile part
// of this file. The call site is GameInstance.update:
//     bot.controller.think(delta, wallNow, this.combatants(entity), this.obstacles)
// -> bot.controller.think(delta, wallNow, this.combatants(entity), this.occluderMeshes)
// with worldMeshes() reduced to `Array.isArray(arg) ? arg : <derive from Map>`.
export default BotController
