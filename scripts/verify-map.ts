// Headless MAP-physics harness for EVERY map in common/maps. No browser, no server:
// it imports the real deterministic movement model (common/applyCommand.js) and each
// map's geometry, builds a BABYLON.NullEngine scene the same way
// server/setupObstacles.js does, and steps the real sim. So it tests the actual
// collision + jump-pad physics the server runs.
//
//   npx tsx scripts/verify-map.ts            # verify all maps
//   npx tsx scripts/verify-map.ts curse      # verify one map by id
//
// Per map it checks: spawns are on open floor; every jump-pad deposits a player ON
// the nearest tower deck (ballistic AND with air-control); and all geometry fits the
// ±64 network view box (GameInstance client.view). Exit 0 = all maps pass.
import * as BABYLON from 'babylonjs'
import applyCommand from '../common/applyCommand'
import { obstacleY } from '../common/arenaConfig'
import { mapList, getMap } from '../common/maps'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import nengiConfig from '../common/nengiConfig'

const DT = 1 / nengiConfig.UPDATE_RATE
const PLAYER_R = 0.5
const VIEW_HALF = 64 // GameInstance client.view halfWidth/Height/Depth
const fmt = n => (n >= 0 ? ' ' : '') + n.toFixed(2)

const specTopY = s => (s.y === undefined ? obstacleY(s.height) : s.y) + s.height / 2
const specBotY = s => (s.y === undefined ? obstacleY(s.height) : s.y) - s.height / 2

// Build a fresh NullEngine scene from a map's OBSTACLE_SPECS (mirrors
// server/setupObstacles.js). Returns { engine, dispose }.
function buildScene(map) {
	const engine = new BABYLON.NullEngine()
	engine.enableOfflineSupport = false
	const scene = new BABYLON.Scene(engine)
	scene.collisionsEnabled = true
	for (const spec of map.OBSTACLE_SPECS) {
		const m = BABYLON.MeshBuilder.CreateBox('obstacle', { size: 1 })
		m.position.set(spec.x, spec.y === undefined ? obstacleY(spec.height) : spec.y, spec.z)
		m.scaling.set(spec.width, spec.height, spec.depth)
		m.checkCollisions = true
		m.computeWorldMatrix(true)
	}
	return { engine, scene, dispose: () => engine.dispose() }
}

function makePlayer(x, y, z) {
	const p = new PlayerCharacter()
	p.x = x; p.y = y; p.z = z
	p.velX = 0; p.velY = 0; p.velZ = 0
	p.grounded = true
	p.currentWeaponIndex = 0
	return p
}
function cmd({ forwards = false, lookX = 0, lookZ = 1 } = {}) {
	const len = Math.hypot(lookX, lookZ) || 1
	return {
		delta: DT, camRayX: lookX / len, camRayY: 0, camRayZ: lookZ / len,
		forwards, backwards: false, left: false, right: false,
		jump: false, dodge: 0, weaponIndex: 0, fireInput: false, reload: false, aimInput: false
	}
}

// Ride a pad and return where the player SETTLES (grounded + ~0 velY for 5 ticks —
// the grounded heuristic false-fires for one tick at the apex when grazing a top
// corner, so require a real rest).
function ridePad(pad, tower, airControl) {
	const p = makePlayer(pad.x, specTopY(pad) + PLAYER_R, pad.z)
	const toTowerX = Math.sign(tower.x - pad.x) || -1
	const command = cmd({ forwards: airControl, lookX: toTowerX, lookZ: 0 })
	let apex = -Infinity, landed = null, settled = 0
	for (let t = 0; t < 240; t++) {
		applyCommand(p, command)
		apex = Math.max(apex, p.y)
		if (t > 1 && p.grounded && Math.abs(p.velY) < 0.05) {
			if (++settled >= 5) { landed = { x: p.x, y: p.y, z: p.z }; break }
		} else settled = 0
	}
	p.mesh.dispose()
	return { landed, apex }
}

function verifyMap(map) {
	const checks = []
	const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass }
	const { dispose } = buildScene(map)

	const towers = map.OBSTACLE_SPECS.filter(s => s.style === 3)
	const deckY = t => specTopY(t) + PLAYER_R

	console.log(`\n======== ${map.name}  [${map.mode}]  (id: ${map.id}) ========`)
	console.log(`obstacles: ${map.OBSTACLE_SPECS.length}   pads: ${map.JUMP_PADS.length}   spawns: ${map.SPAWN_POINTS.length}   towers(style3): ${towers.length}`)

	// --- bounds / view-box fit
	let maxX = 0, maxZ = 0, maxTop = 0
	for (const s of map.OBSTACLE_SPECS) {
		maxX = Math.max(maxX, Math.abs(s.x) + s.width / 2)
		maxZ = Math.max(maxZ, Math.abs(s.z) + s.depth / 2)
		maxTop = Math.max(maxTop, specTopY(s))
	}
	console.log(`extents: |x|max=${fmt(maxX)} |z|max=${fmt(maxZ)} topY=${fmt(maxTop)}  (view box ±${VIEW_HALF})`)
	check('fits ±64 network view box', maxX <= VIEW_HALF && maxZ <= VIEW_HALF && maxTop <= VIEW_HALF,
		`|x|=${maxX.toFixed(1)} |z|=${maxZ.toFixed(1)}`)

	// --- spawn validity
	let badSpawn = 0
	for (const s of map.SPAWN_POINTS) {
		const hit = map.OBSTACLE_SPECS.find(o =>
			Math.abs(s.x - o.x) < o.width / 2 + PLAYER_R &&
			Math.abs(s.z - o.z) < o.depth / 2 + PLAYER_R &&
			specBotY(o) < PLAYER_R * 2)
		if (hit) { badSpawn++; console.log(`  BAD spawn (${fmt(s.x)},${fmt(s.z)}) inside style-${hit.style} @(${fmt(hit.x)},${fmt(hit.z)})`) }
	}
	check('all spawns on open floor', badSpawn === 0, `${map.SPAWN_POINTS.length - badSpawn}/${map.SPAWN_POINTS.length} clear`)

	// --- jump-pad landing (only if the map has pads)
	for (const pad of map.JUMP_PADS) {
		const tower = towers.slice().sort((a, b) =>
			Math.hypot(a.x - pad.x, a.z - pad.z) - Math.hypot(b.x - pad.x, b.z - pad.z))[0]
		if (!tower) { check(`pad @x=${fmt(pad.x)} has a target deck`, false, 'no style-3 tower nearby'); continue }
		const target = deckY(tower)
		for (const air of [false, true]) {
			const r = ridePad(pad, tower, air)
			const onDeck = r.landed &&
				Math.abs(r.landed.y - target) < 0.4 &&
				Math.abs(r.landed.x - tower.x) <= tower.width / 2 + 0.1 &&
				Math.abs(r.landed.z - tower.z) <= tower.depth / 2 + 0.1
			const where = r.landed ? `rest @(${fmt(r.landed.x)},${fmt(r.landed.y)},${fmt(r.landed.z)})` : 'never settled'
			check(`pad @x=${fmt(pad.x)} ${air ? 'air-control' : 'ballistic'} lands on deck`, !!onDeck, `apex ${fmt(r.apex)} deck ${fmt(target)} ${where}`)
		}
	}

	dispose()
	let failed = 0
	for (const c of checks) {
		console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
		if (!c.pass) failed++
	}
	console.log(`  --> ${checks.length - failed}/${checks.length} checks passed`)
	return failed
}

const arg = process.argv[2]
const targets = arg ? [getMap(arg)] : mapList
let totalFailed = 0
for (const map of targets) totalFailed += verifyMap(map)
console.log(`\n${totalFailed === 0 ? 'ALL MAPS PASS' : totalFailed + ' checks FAILED across maps'}`)
process.exit(totalFailed ? 1 : 0)
