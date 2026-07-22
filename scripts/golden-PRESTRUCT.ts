// Millimeter-level collision-regression GOLDEN harness. Sibling to verify-map.ts:
// same NullEngine scene build, same real movement model (common/applyCommand.js),
// same command shape. Instead of PASS/FAIL checks it records the FULL per-tick
// trajectory of a battery of FIXED, deterministic input sequences for EVERY map,
// so a later Babylon bump can be diffed against this baseline (see
// scripts/golden-collision-diff.mjs). Client/server prediction is bit-sensitive to
// collision drift, so the sequences are seeded only from static map data — no time,
// no random, fixed iteration order.
//
//   npx tsx scripts/golden-collision.ts            # write the golden JSON
//   npx tsx scripts/golden-collision.ts /tmp/x.json  # write to a chosen path
import * as BABYLON from '../common/babylon.node.js'
import { writeFileSync } from 'fs'
import applyCommand from '../_work/slope-verify/applyCommand.PRESTRUCT-harness.js'
import { obstacleY } from '../common/arenaConfig'
import { mapList } from '../common/maps'
import { DODGE_DIRS } from '../common/applyCommand'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import nengiConfig from '../common/nengiConfig'

const DT = 1 / nengiConfig.UPDATE_RATE
const PLAYER_R = 0.5
const OUT = process.argv[2] || `${__dirname}/../upgrade/golden-collision-babylon-${BABYLON.Engine.Version}.json`

const specTopY = s => (s.y === undefined ? obstacleY(s.height) : s.y) + s.height / 2

// round to 6 decimals, normalising -0 -> 0 so the JSON is byte-stable
const r6 = n => { const v = Math.round(n * 1e6) / 1e6; return Object.is(v, -0) ? 0 : v }

// Build a fresh NullEngine scene from a map's OBSTACLE_SPECS (mirrors
// server/setupObstacles.js + verify-map.ts). Returns { dispose }.
function buildScene(map) {
	const engine = new BABYLON.NullEngine()
	engine.enableOfflineSupport = false
	const scene = new BABYLON.Scene(engine)
	scene.collisionsEnabled = true
	// Box-arena floor collider. verify-map.ts omits it (it only rides pads onto tower
	// decks), but our spawn sequences stand on open floor — and USE_MESH_MAP=true
	// disables applyCommand's y>=GROUND_Y clamp, so without a real collider a floor
	// player falls into the void and never reaches a wall. A big box with its TOP face
	// at GROUND_Y (y=0) is the box arena's implicit ground; players rest on it via
	// moveWithCollisions exactly like they already rest on the tower decks.
	const floor = BABYLON.MeshBuilder.CreateBox('floor', { size: 1 })
	floor.position.set(0, -50, 0)
	floor.scaling.set(400, 100, 400)
	floor.checkCollisions = true
	floor.computeWorldMatrix(true)
	for (const spec of map.OBSTACLE_SPECS) {
		const m = BABYLON.MeshBuilder.CreateBox('obstacle', { size: 1 })
		m.position.set(spec.x, spec.y === undefined ? obstacleY(spec.height) : spec.y, spec.z)
		m.scaling.set(spec.width, spec.height, spec.depth)
		m.checkCollisions = true
		m.computeWorldMatrix(true)
	}
	return { dispose: () => engine.dispose() }
}

function makePlayer(x, y, z) {
	const p = new PlayerCharacter()
	p.x = x; p.y = y; p.z = z
	p.velX = 0; p.velY = 0; p.velZ = 0
	p.grounded = true
	p.currentWeaponIndex = 0
	return p
}

// Same command shape verify-map.ts uses (all fields present, look flattened to x/z).
function cmd({ forwards = false, backwards = false, left = false, right = false,
	jump = false, dodge = 0, lookX = 0, lookZ = 1 } = {}) {
	const len = Math.hypot(lookX, lookZ) || 1
	return {
		delta: DT, camRayX: lookX / len, camRayY: 0, camRayZ: lookZ / len,
		forwards, backwards, left, right,
		jump, dodge, weaponIndex: 0, fireInput: false, reload: false, aimInput: false
	}
}

// nearest obstacle to (x,z), by horizontal centre distance — deterministic aim seed
function nearestObstacle(map, x, z) {
	return map.OBSTACLE_SPECS.slice().sort((a, b) =>
		Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0]
}
function nearestTower(map, x, z) {
	const towers = map.OBSTACLE_SPECS.filter(s => s.style === 3)
	return towers.slice().sort((a, b) =>
		Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0]
}

// Step `player` through `ticks` of a fixed command (or a per-tick command factory),
// recording [x,y,z,velY,grounded] each tick. Disposes the player mesh at the end.
function record(player, cmdOrFn, ticks) {
	const fn = typeof cmdOrFn === 'function' ? cmdOrFn : () => cmdOrFn
	const traj = []
	for (let t = 0; t < ticks; t++) {
		applyCommand(player, fn(t))
		traj.push([r6(player.x), r6(player.y), r6(player.z), r6(player.velY), player.grounded])
	}
	player.mesh.dispose()
	return traj
}

function buildSequences(map) {
	const seqs = {}
	const spawn = map.SPAWN_POINTS[0]
	// rest on the floor collider (top face at y=0): player ellipsoid r=0.5
	const sx = spawn.x, sy = (spawn.y || 0) + PLAYER_R, sz = spawn.z
	const wall = nearestObstacle(map, sx, sz)
	const wLookX = wall.x - sx, wLookZ = wall.z - sz

	// 1) walk forward into the nearest wall until blocked (150 ticks)
	seqs.walkIntoWall = record(makePlayer(sx, sy, sz),
		cmd({ forwards: true, lookX: wLookX, lookZ: wLookZ }), 150)

	// 2) jump arc: jump one tick, then hold forward (120 ticks)
	seqs.jumpArc = record(makePlayer(sx, sy, sz),
		t => cmd({ forwards: true, jump: t === 0, lookX: wLookX, lookZ: wLookZ }), 120)

	// 3) dodge burst: forwards-dodge each tick (cooldown gates re-dodges) (90 ticks)
	seqs.dodgeBurst = record(makePlayer(sx, sy, sz),
		cmd({ dodge: DODGE_DIRS.forwards, lookX: wLookX, lookZ: wLookZ }), 90)

	// 4) diagonal wall-slide: forwards+right into the nearest wall (120 ticks)
	seqs.wallSlideDiag = record(makePlayer(sx, sy, sz),
		cmd({ forwards: true, right: true, lookX: wLookX, lookZ: wLookZ }), 120)

	// 5) each jump-pad ride, ballistic AND air-control — spawn ON the pad top and
	// look toward the nearest tower, exactly like verify-map.ts ridePad (240 ticks)
	const pads = map.JUMP_PADS || []
	for (let i = 0; i < pads.length; i++) {
		const pad = pads[i]
		const tower = nearestTower(map, pad.x, pad.z)
		const toTowerX = tower ? (Math.sign(tower.x - pad.x) || -1) : -1
		for (const air of [false, true]) {
			const p = makePlayer(pad.x, specTopY(pad) + PLAYER_R, pad.z)
			seqs[`pad${i}_${air ? 'air' : 'ballistic'}`] =
				record(p, cmd({ forwards: air, lookX: toTowerX, lookZ: 0 }), 240)
		}
	}
	return seqs
}

const out = { babylonVersion: BABYLON.Engine.Version, generatedAt: new Date().toISOString(), maps: {} }
for (const map of mapList) {
	const { dispose } = buildScene(map)
	out.maps[map.id] = { sequences: buildSequences(map) }
	dispose()
	const s = out.maps[map.id].sequences
	console.log(`${map.id}: ${Object.keys(s).length} sequences`)
	for (const name of Object.keys(s)) {
		const traj = s[name]
		const last = traj[traj.length - 1]
		console.log(`  ${name.padEnd(16)} ${traj.length} ticks  final=(${last[0]},${last[1]},${last[2]}) velY=${last[3]} grounded=${last[4]}`)
	}
}
writeFileSync(OUT, JSON.stringify(out))
console.log(`\nwrote ${OUT}  (babylon ${out.babylonVersion})`)
