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
//   * A* pathfinding over the map's OWN UT99 nav graph (it crosses the map like a
//     player, not by diffusing across probed floor)
//   * strafe-orbiting at its weapon's preferred range, occasional jumps
import * as BABYLON from '../common/babylon.node.js'
import { weapons } from '../common/weaponsConfig'
import { USE_MESH_MAP, MAP_MESH } from '../common/mapMesh'
import { nearestWorldHit } from './lagCompensatedHitscanCheck'
import { getNavGraph, nearestNode, aStar } from './navGraph'

const TURN_RATE = 3.4          // rad/s — swings onto a target in ~0.3-0.9s (aim: human-ish)
const NAV_TURN_RATE = 12       // rad/s — steering (no visible target). The aim rate is
// deliberately slow so the bot doesn't snap onto YOU; but movement follows the heading,
// and at 3.4 rad/s the heading crawls while momentum carries the bot wide — it arcs off
// narrow floor into the void. When there is nothing to aim at, the bot may whip its view
// around to face the next waypoint, so velocity stays glued to the path.
const RETARGET_MS = 900        // how often it reconsiders who to fight
const AIM_ERR_YAW = 0.055      // rad, re-rolled each burst (~±1.6°)
const AIM_ERR_PITCH = 0.03
const FIRE_CONE = 0.13         // rad — only pulls the trigger this close to on-target
// Combat orbit (strafe/advance/fire) is a CLOSE-range behaviour. Its strafing walks the
// bot sideways with no floor awareness, which is fatal on a catwalk like Visage's central
// bridge — a bot that sees an enemy across the span would strafe straight off it. So the
// bot only orbits within COMBAT_RANGE; visible-but-farther, it keeps A*-pathfinding toward
// the enemy (staying on real floor) and closes the distance before it fights.
const COMBAT_RANGE = 22        // world units
const LEDGE_LOOK = 1.8         // world units — how far ahead combat ledge-sense probes

// LoS re-evaluation interval. A cross-map ray on CTF-Visage costs ~100-300us (it is
// up to 105m long, so the bounding-sphere pre-reject in nearestWorldHit prunes far
// less than it does for a typical short hitscan pellet). Running that every bot every
// tick at 40Hz is real money; re-checking ~8x/second is not, and a bot whose knowledge
// of "can I see you" is up to 150ms stale reads as HUMAN reaction time rather than as
// a bug. The result is invalidated immediately on a target switch, and the jitter
// keeps a full roster from re-evaluating on the same tick.
const LOS_INTERVAL_MS = 120
const LOS_JITTER_MS = 60

// A* pathfinding over the map's own UT99 nav graph (server/navGraph.js). Re-planning is
// THROTTLED: a bot re-runs A* at most once per PATH_REPLAN_MS, or immediately when its
// destination snaps to a different graph node or it runs out of waypoints — a fresh path
// every tick is pure waste, the graph does not change under a moving target inside a
// second. A waypoint is retired once the bot is within WAYPOINT_REACH of it.
const PATH_REPLAN_MS = 1000
const WAYPOINT_REACH = 3.0     // world units — advance to the next waypoint this close
const JUMP_LEAD = 5.0          // press jump this far out when the leg is a 'jump' edge
const PICKUP_HOLD_MS = 8000    // how long a bot roams toward one pickup before repicking
// Movement is along the CURRENT heading (aimYaw), which turns at only TURN_RATE. Holding
// W while the heading is still swinging onto a waypoint carves a wide arc — fine in the
// open, fatal near a ledge (the bot arcs off into the void). So on a path we only drive
// forward once the heading is within MOVE_CONE of the waypoint; outside it the bot pivots
// in place. It costs a fraction of a second per sharp turn and keeps the bot on the floor.
const MOVE_CONE = 0.6          // rad (~34°)
// Cornering: the bot has real momentum (applyCommand friction bleeds ~7.6 m/s over ~0.3s),
// so arriving at a waypoint at full tilt and then turning hard carries it past the node —
// off a ledge if the node sits near one. Slow-in/fast-out: within SLOWDOWN_DIST of a
// waypoint whose OUTGOING leg turns more than BRAKE_ANGLE, drive forward only every other
// tick (half speed) so the bot reaches the corner slow and the overshoot stays small.
const SLOWDOWN_DIST = 5.0      // world units
const BRAKE_ANGLE = 0.6        // rad — corner sharper than this triggers the brake
const LOOKAHEAD = 4.0          // pure-pursuit carrot distance ahead along the polyline

// ---------------------------------------------------------------------------
// World geometry access
// ---------------------------------------------------------------------------
// Bot LoS and server shot resolution MUST agree, so both consult the SAME meshes:
// GameInstance.occluderMeshes (subdivided, disabled clones of the map collider on a mesh
// map; the Obstacle boxes on a box arena). GameInstance now hands that array straight
// into think() (it maintains occluderMeshes on both paths), so worldMeshes just returns
// it — the old `occluder_<i>` scene-name matching is gone. The obstacles-Map branch is
// kept only so an older caller still works.
const EMPTY = []
const boxCache = new WeakMap()

const worldMeshes = (me, arg) => {
	// GameInstance passes its occluderMeshes array directly
	if (Array.isArray(arg)) return arg
	// legacy caller: an obstacles Map (box arena) is itself the occluder set
	if (arg && arg.size > 0) {
		let c = boxCache.get(arg)
		if (!c || c.size !== arg.size) {
			c = { size: arg.size, meshes: [...arg.values()].map(o => o.mesh).filter(Boolean) }
			boxCache.set(arg, c)
		}
		return c.meshes
	}
	return EMPTY
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
//   1. probe a grid of downward rays over the map's own `walkable` AABB (the floor
//      extent mapMesh.js publishes; a spawn-bbox+margin box would clip any map whose
//      play area reaches past where players start — e.g. Visage's far east deck)
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

// Floor-probe extents for combat ledge-sense, derived once from the active map's data
// (topmost start above the walkable ceiling, run down past killY).
let combatProbe = null
const combatProbeParams = () => {
	if (!combatProbe) {
		const sc = MAP_MESH.scale || 1
		const w = MAP_MESH.walkable
		const topY = (w ? w.maxY * sc : 100) + 60
		const killY = (MAP_MESH.killY != null ? MAP_MESH.killY : (w ? w.minY : -1e6)) * sc
		combatProbe = { topY, len: topY - killY + 5, floorMin: killY + 3 }
	}
	return combatProbe
}

const navCache = new WeakMap()

const newNav = () => {
	const sc = MAP_MESH.scale || 1
	const spawns = (MAP_MESH.spawns || []).map(s => ({ x: s.x * sc, y: s.y * sc, z: s.z * sc }))
	if (spawns.length === 0) return null
	// Bounds = the map's `walkable` AABB (native units -> world). It is the true floor
	// extent, so nothing reachable is clipped; a spawn-bbox+margin box was tighter than
	// the real play area on any map that extends past its spawns. Fall back to the old
	// spawn-bbox+margin only if a map has no `walkable` block.
	const w = MAP_MESH.walkable
	let minX, maxX, minZ, maxZ, killY, topY
	if (w) {
		minX = w.minX * sc; maxX = w.maxX * sc; minZ = w.minZ * sc; maxZ = w.maxZ * sc
		killY = (MAP_MESH.killY != null ? MAP_MESH.killY : w.minY) * sc
		// probe from just above the walkable ceiling, down past killY
		topY = w.maxY * sc + 60
	} else {
		const m = NAV.margin
		minX = Math.min(...spawns.map(s => s.x)) - m
		maxX = Math.max(...spawns.map(s => s.x)) + m
		minZ = Math.min(...spawns.map(s => s.z)) - m
		maxZ = Math.max(...spawns.map(s => s.z)) + m
		killY = (MAP_MESH.killY || -1e9) * sc
		// start every probe above the tallest thing a spawn could sit under, and run it
		// down past killY so the ray cannot stop short of the floor
		topY = Math.max(...spawns.map(s => s.y)) + 60
	}
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
		// A* path state (server/navGraph.js). Replanned on a throttle (PATH_REPLAN_MS) and
		// followed by PURE PURSUIT — the bot steers at a carrot point that slides along the
		// walkable polyline, so it tracks the path instead of cutting corners off ledges.
		this.path = null        // array of graph node indices, current route
		this.pathX = null       // its node world x's (the polyline)
		this.pathZ = null       // its node world z's
		this.segJump = null     // segJump[i]: is segment (i-1 -> i) a jump edge?
		this.pathProg = 0       // index of the polyline segment the bot is currently on
		this.pathDone = false   // reached the last node -> head straight at the destination
		this.pathGoal = -1      // goal node the current path targets (detect goal moves)
		this.pathAt = 0         // next time replanning is allowed
		this.pickupGoal = -1    // roam-destination pickup node when there is no enemy
		this.pickupUntil = 0
		// OBJECTIVE BIAS (CTF/DOM) v1: a {x,y,z} world destination set per tick by
		// GameInstance. When present it REPLACES the random pickup roam target (only in the
		// no-enemy branch of navigate — a live visible enemy still preempts). null = roam.
		this.objectiveDest = null
		this.wantJump = false   // set by navigate() when the current segment is a jump edge
		this.brake = false      // set by navigate() when braking into a sharp corner
		this.tick = 0           // think-tick counter (drives the half-speed brake duty)
	}

	// OBJECTIVE BIAS (CTF/DOM): GameInstance sets the bot's current objective destination
	// (world {x,y,z}) each tick, or null to fall back to the random pickup roam. Consumed
	// only in navigate()'s no-enemy branch.
	setObjective(dest) { this.objectiveDest = dest || null }

	// One AI tick: returns a MoveCommand-shaped plain object for applyCommand.
	// `combatants` = alive entities it may fight (never includes itself).
	think(delta, now, combatants, occluderMeshes) {
		const me = this.entity
		this.tick++
		const meshes = worldMeshes(me, occluderMeshes)
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
				// TDM: never target a TEAMMATE. A bot only fights the enemy team, so it can
				// never shoot or path-to-attack a friendly (LoS/nav are unchanged otherwise).
				if (candidate.teamId !== undefined && me.teamId !== undefined
					&& candidate.teamId === me.teamId) return
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
		let turnRate = TURN_RATE   // bumped to NAV_TURN_RATE while steering (no visible target)

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
		// close enough to fight? beyond COMBAT_RANGE the bot pathfinds in instead of orbiting
		const engage = seesTarget && Math.hypot(target.x - me.x, target.z - me.z) <= COMBAT_RANGE

		if (engage) {
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

			// LEDGE SENSE. Orbit strafing has no floor awareness, so a fight on a catwalk or
			// tower top would walk the bot off the edge (Visage is all edges). Probe the floor
			// a step ahead in the move direction; if it's void, first try flipping the strafe,
			// and if that is void too, stand and shoot rather than step off. Only runs while
			// engaged (close, few bots), so the extra probe is cheap.
			if (meshes.length && (forwards || backwards || left || right)) {
				const safe = (lr, fb) => this.moveSafe(meshes, me, wishYaw, lr, fb)
				const lr = (left ? -1 : 0) + (right ? 1 : 0)
				const fb = (forwards ? 1 : 0) - (backwards ? 1 : 0)
				if (!safe(lr, fb)) {
					if (lr !== 0 && safe(-lr, fb)) {            // flip strafe onto solid ground
						this.strafeDir = -this.strafeDir; left = lr > 0; right = lr < 0
					} else if (fb !== 0 && safe(0, fb)) {       // keep advancing/retreating, no strafe
						left = right = false
					} else {                                     // nowhere safe -> hold position
						forwards = backwards = left = right = false
					}
				}
			}
		} else {
			// No target in sight: A* the map's real nav graph toward a destination — the
			// enemy (chase it to re-establish LoS) if one is alive, otherwise an item-pickup
			// node to roam — and steer along the waypoints. This replaces the slow-diffusion
			// wander: a bot crosses the map on the graph's edges at walking speed instead of
			// random-hopping across it over minutes.
			turnRate = NAV_TURN_RATE   // steer the heading fast so velocity hugs the path
			const wp = this.navigate(now, alive ? target : null)
			if (wp) {
				wishYaw = Math.atan2(wp.x - me.x, wp.z - me.z)
				// drive forward only once roughly facing the waypoint (see MOVE_CONE)
				let he = wishYaw - this.aimYaw
				while (he > Math.PI) he -= Math.PI * 2
				while (he < -Math.PI) he += Math.PI * 2
				// forward when facing the waypoint; half-speed (every other tick) when
				// braking into a sharp corner so momentum can't carry the bot off a ledge
				forwards = Math.abs(he) < MOVE_CONE && (!this.brake || (this.tick & 1) === 0)
				if (this.wantJump && forwards) jump = true
				this.wander = null
			} else {
				// Graph unavailable, or the destination is in a disconnected component
				// (A* found no path): fall back to the probed straight-line wander so the
				// bot keeps moving on real floor rather than freezing.
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
					let he = wishYaw - this.aimYaw
					while (he > Math.PI) he -= Math.PI * 2
					while (he < -Math.PI) he += Math.PI * 2
					forwards = Math.abs(he) < MOVE_CONE
				}
			}
		}

		// swing the aim toward the wish direction at a bounded rate — human-ish when
		// aiming at a target, fast when merely steering toward a waypoint (see NAV_TURN_RATE)
		const maxTurn = turnRate * delta
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

	// A* NAVIGATION with pure pursuit. Return the world {x,z} the bot should steer toward
	// THIS tick, or null if there is no graph / no path (the caller then uses the probed
	// fallback). `target` is a live enemy to chase, or null to roam toward an item pickup.
	// A* is throttled to once per PATH_REPLAN_MS (plus on a goal-node change or route
	// completion); every other tick just slides a carrot along the cached polyline, which
	// is a handful of distance checks. The carrot tracks the WALKABLE polyline, so the bot
	// follows the path's shape instead of aiming at a far node and cutting the corner off a
	// ledge — the failure mode of one-waypoint-at-a-time steering on this geometry.
	navigate(now, target) {
		this.wantJump = false
		this.brake = false
		if (!USE_MESH_MAP) return null   // box arena has no nav graph -> caller's box wander
		const g = getNavGraph()
		if (!g || g.N === 0) return null
		const me = this.entity

		// Destination world point + its goal node.
		let goalNode, destX, destZ
		if (target) {
			destX = target.x; destZ = target.z
			goalNode = nearestNode(g, target.x, target.y, target.z)
		} else if (this.objectiveDest) {
			// OBJECTIVE BIAS (CTF/DOM): roam toward the mode's objective instead of a random
			// pickup. Everything downstream (A* throttle, carrot pursuit, ledge braking) is
			// untouched — only the destination node changes.
			goalNode = nearestNode(g, this.objectiveDest.x, this.objectiveDest.y, this.objectiveDest.z)
			if (goalNode < 0) return null
			destX = g.nodes[goalNode].x; destZ = g.nodes[goalNode].z
		} else {
			// roam: hold one reachable pickup for a while, then pick another (also when the
			// current route completes, so the bot doesn't stall on a reached pickup)
			if (this.pickupGoal < 0 || now >= this.pickupUntil || this.pathDone) {
				this.pickupGoal = g.pickups.length
					? g.pickups[(Math.random() * g.pickups.length) | 0] : -1
				this.pickupUntil = now + PICKUP_HOLD_MS
				this.path = null
			}
			if (this.pickupGoal < 0) return null
			goalNode = this.pickupGoal
			destX = g.nodes[goalNode].x; destZ = g.nodes[goalNode].z
		}
		if (goalNode < 0) return null

		// (Re)plan on a throttle, on a goal-node change, or when the route is complete.
		if (!this.path || goalNode !== this.pathGoal || now >= this.pathAt || this.pathDone) {
			this.pathAt = now + PATH_REPLAN_MS
			this.pathGoal = goalNode
			const startNode = nearestNode(g, me.x, me.y, me.z)
			const p = aStar(g, startNode, goalNode)
			if (!p) { this.path = null; return null }  // disconnected -> fallback
			this.path = p
			this.pathDone = false
			this.pathProg = 0
			// cache the polyline (world) + per-segment jump flags
			this.pathX = new Float64Array(p.length)
			this.pathZ = new Float64Array(p.length)
			this.segJump = new Uint8Array(p.length)
			for (let i = 0; i < p.length; i++) { this.pathX[i] = g.nodes[p[i]].x; this.pathZ[i] = g.nodes[p[i]].z }
			for (let i = 1; i < p.length; i++) {
				const es = g.adj[p[i - 1]]
				for (let k = 0; k < es.length; k++) if (es[k].to === p[i]) { this.segJump[i] = es[k].jump ? 1 : 0; break }
			}
		}

		const X = this.pathX, Z = this.pathZ, N = X.length
		if (N === 1) { this.pathDone = true; return { x: destX, z: destZ } }

		// closest point on the polyline, searched from current progress forward (monotonic,
		// so the bot never snaps back to an earlier segment that happens to pass nearby)
		let bestSeg = this.pathProg, bestT = 0, bestD = Infinity
		const windowEnd = Math.min(N - 1, this.pathProg + 8)
		for (let s = this.pathProg; s < windowEnd; s++) {
			const ax = X[s], az = Z[s], dx = X[s + 1] - ax, dz = Z[s + 1] - az
			const L2 = dx * dx + dz * dz || 1e-6
			let t = ((me.x - ax) * dx + (me.z - az) * dz) / L2
			t = t < 0 ? 0 : t > 1 ? 1 : t
			const cx = ax + dx * t, cz = az + dz * t
			const d = (me.x - cx) ** 2 + (me.z - cz) ** 2
			if (d < bestD) { bestD = d; bestSeg = s; bestT = t }
		}
		this.pathProg = bestSeg

		// done: within reach of the final node -> steer straight at the real destination
		if (bestSeg >= N - 2 && Math.hypot(me.x - X[N - 1], me.z - Z[N - 1]) < WAYPOINT_REACH) {
			this.pathDone = true
			return { x: destX, z: destZ }
		}

		// brake into a sharp bend at the NEXT vertex (slow-in/fast-out)
		if (bestSeg + 2 < N) {
			const v0x = X[bestSeg + 1] - X[bestSeg], v0z = Z[bestSeg + 1] - Z[bestSeg]
			const v1x = X[bestSeg + 2] - X[bestSeg + 1], v1z = Z[bestSeg + 2] - Z[bestSeg + 1]
			const l0 = Math.hypot(v0x, v0z) || 1, l1 = Math.hypot(v1x, v1z) || 1
			const bend = Math.acos(Math.max(-1, Math.min(1, (v0x * v1x + v0z * v1z) / (l0 * l1))))
			if (bend > BRAKE_ANGLE &&
				Math.hypot(X[bestSeg + 1] - me.x, Z[bestSeg + 1] - me.z) < SLOWDOWN_DIST) this.brake = true
		}

		// carrot: walk LOOKAHEAD metres forward along the polyline from (bestSeg, bestT)
		let seg = bestSeg, t = bestT, remain = LOOKAHEAD, cx = X[N - 1], cz = Z[N - 1]
		while (seg < N - 1) {
			const ax = X[seg], az = Z[seg], dx = X[seg + 1] - ax, dz = Z[seg + 1] - az
			const segLen = Math.hypot(dx, dz)
			const toEnd = segLen * (1 - t)
			if (this.segJump[seg + 1]) this.wantJump = true  // jump if the carrot spans a jump edge
			if (remain <= toEnd || seg === N - 2) {
				const tt = Math.min(1, t + (segLen > 0 ? remain / segLen : 0))
				cx = ax + dx * tt; cz = az + dz * tt
				break
			}
			remain -= toEnd; seg++; t = 0
		}
		return { x: cx, z: cz }
	}

	// Combat ledge-sense: would stepping in the (lr strafe, fb forward/back) direction —
	// relative to heading `yaw` — land on walkable floor LEDGE_LOOK ahead? Mirrors the
	// world-space move basis applyCommand uses (forward = (sin,cos)yaw, right = (cos,-sin)yaw).
	moveSafe(meshes, me, yaw, lr, fb) {
		const cos = Math.cos(yaw), sin = Math.sin(yaw)
		let dx = lr * cos + fb * sin
		let dz = -lr * sin + fb * cos
		const l = Math.hypot(dx, dz)
		if (l < 1e-6) return true
		dx /= l; dz /= l
		const p = combatProbeParams()
		const f = floorProbe(meshes, me.x + dx * LEDGE_LOOK, me.z + dz * LEDGE_LOOK, p.topY, p.len)
		return !!f && f.ny >= MIN_WALK_NORMAL && f.y > p.floorMin
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

// think() is handed GameInstance.this.occluderMeshes directly (the call site is
// GameInstance.update). That array is maintained on BOTH the mesh-map and box-arena paths,
// so worldMeshes() just returns it — the old `occluder_<i>` scene-name matching is gone.
export default BotController
