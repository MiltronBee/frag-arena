import nengi from 'nengi'
import nengiConfig from '../common/nengiConfig'
import { SPAWN_POINTS } from '../common/arenaConfig'
import { setActiveMap } from '../common/mapMesh'
import { getMapRecord, DEFAULT_MAP_ID } from '../common/mapRegistry'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import Identity from '../common/message/Identity'
import WeaponFired from '../common/message/WeaponFired'
import Respawned from '../common/message/Respawned'
import HitConfirmed from '../common/message/HitConfirmed'
import Killed from '../common/message/Killed'
import DamageTaken from '../common/message/DamageTaken'
import PlayerName from '../common/message/PlayerName'
import { HUMAN_NAME_SENTINEL, decodeName } from '../common/playerNames'
import followPath from './followPath'
import damagePlayer from './damagePlayer' // TODO
import niceInstanceExtension from './niceInstanceExtension'
import applyCommand, { MAX_SPEED } from '../common/applyCommand'
import setupObstacles from './setupObstacles'
import { fire } from '../common/weapon'
import { shotPattern, applyPattern } from '../common/firePattern'
import { damageFalloffMult, falloffRange } from '../common/damageFalloff'
import lagCompensatedHitscanCheck, { nearestWorldHit } from './lagCompensatedHitscanCheck'
import Projectile from '../common/entity/Projectile'
import Grenade from '../common/entity/Grenade'
import MegaHealthPickup, { MEGA_STATE } from '../common/entity/MegaHealthPickup'
import MatchState, { MATCH_PHASE, MATCH_WINNER, MATCH_MODE } from '../common/entity/MatchState'
import setupPickups from './setupPickups'
import Pickup from '../common/entity/Pickup'
import {
	PICKUP_TYPE, PICKUP_RADIUS, CHARGE_LEAD_SECONDS, HEALTH_HEAL, HEALTH_CAP,
	REST_HEIGHT, ARMOR_PICKUP, ARMOR_CAP, ARMOR_ABSORB,
	UDAMAGE_MULT, UDAMAGE_SECONDS, DROP_DESPAWN_SECONDS, DROP_JITTER,
} from '../common/pickupConfig'
import { weapons, DEFAULT_ZONE_MULTIPLIERS, SPAWN_WEAPON_INDEX } from '../common/weaponsConfig'
import { PLAYER_NAMES } from '../common/playerNames'
import BotController from './BotController'
import AgentBotController from './AgentBotController'
import AgentGateway from './AgentGateway'
import BloodLedger from './BloodLedger'

import * as BABYLON from '../common/babylon.node.js'
import { OBJFileLoader } from '../common/babylon.node.js' // OBJ loader (server-side collision) via node barrel

//import 'babylonjs-loaders' // mutates something globally
global.XMLHttpRequest = require('xhr2').XMLHttpRequest

// Phase 3 frag-grenade tuning (locked design numbers). Server-only physics.
const GRENADE = {
	MAX_CHARGES: 2,
	RECHARGE_TIME: 12.0,   // seconds to regen one spent charge (up to MAX)
	THROW_INTERVAL: 0.6,   // min seconds between throws
	SPEED: 22,             // launch speed (m/s)
	PITCH_DEG: 15,         // degrees ABOVE the aim vector
	GRAVITY: 18,           // matches applyCommand.js GRAVITY (native player arc)
	FUSE: 1.8,             // seconds until detonation
	RESTITUTION: 0.4,      // energy kept per bounce
	RADIUS: 5.0,           // AoE radius (m)
	DMG_CENTER: 120,       // damage at the center
	DMG_EDGE: 20,          // damage at RADIUS (linear falloff to 0 beyond)
	// BOX ARENAS ONLY. The box arena's floor really is the plane y=0 (matches
	// applyCommand GROUND_Y). A mesh map has no such plane: CTF-Visage's deck sits at
	// world y ~-25.35, i.e. BELOW zero, so clamping to 0 teleported every grenade ~24m
	// into the sky on its first tick and detonated it in the void. Mesh maps take their
	// floor from the geometry instead (the down-probe in update()), so this constant is
	// now read only on the box-arena branch.
	GROUND_Y: 0,
	// Clearance kept between a resting grenade and the surface under it. Also the lift
	// applied to the splash line-of-sight origin, so a grenade sitting ON the deck does
	// not have that same deck count as the wall that blocks its own blast.
	SKIN: 0.12
}

// ---------------------------------------------------------------------------
// Swept world-geometry query
// ---------------------------------------------------------------------------
// "Does static map geometry lie on the segment origin -> origin + dir*len?" Returns the
// distance along the segment, or Infinity when the segment is clear.
//
// This is deliberately NOT a new geometry query: it forwards to
// server/lagCompensatedHitscanCheck.js's nearestWorldHit — the same function hitscan
// occlusion and BotController's line-of-sight already use, against the same
// this.occluderMeshes (subdivided OBJ submeshes on a mesh map, Obstacle boxes on a box
// arena). One implementation decides every "is this blocked" question on the server.
//
// The Ray is module-scoped and mutated in place: this runs per projectile per tick and
// Flak fires 5 pellets, so allocating a Ray + two Vector3s per query would be pure
// garbage. The server is single-threaded and nearestWorldHit never retains the ray.
//
// `dir` MUST be unit length — nearestWorldHit's bounding-sphere pre-reject projects
// onto it and would mis-cull otherwise.
const _sweepRay = new BABYLON.Ray(new BABYLON.Vector3(0, 0, 0), new BABYLON.Vector3(0, 0, 1), 1)
const sweepWorld = (meshes, ox, oy, oz, dx, dy, dz, len) => {
	if (!meshes || meshes.length === 0 || !(len > 0)) return Infinity
	_sweepRay.origin.set(ox, oy, oz)
	_sweepRay.direction.set(dx, dy, dz)
	// bound the ray itself, not just the pre-reject: an unbounded ray would report the
	// far side of the map as a "hit" and cost triangle tests all the way there.
	_sweepRay.length = len
	return nearestWorldHit(meshes, _sweepRay, len)
}

// Earliest fraction t in [0,1] at which the segment p -> p+s enters the sphere of
// radius r about c, or -1 if it never does. Smaller root of |p + t*s - c|^2 = r^2.
//
// This replaces a POINT test at the tick position. A point test samples ONE point of
// this segment, so it only lands a hit when a tick boundary happens to fall inside the
// target sphere. At full-ADS Plasma the segment is 2.19m long and the sphere is 0.90m
// across, so most geometrically real hits fell between two ticks and were silently
// dropped — the weapon advertised as the precise dart was the least reliable in the
// game. Sweeping the segment makes the hit independent of tick phase.
const segmentSphereT = (px, py, pz, sx, sy, sz, cx, cy, cz, r) => {
	const mx = px - cx, my = py - cy, mz = pz - cz
	const cc = mx * mx + my * my + mz * mz - r * r
	if (cc <= 0) return 0                      // started inside the sphere
	const a = sx * sx + sy * sy + sz * sz
	if (a <= 0) return -1                      // not moving, and outside
	const b = mx * sx + my * sy + mz * sz
	if (b >= 0) return -1                      // outside and moving away
	const disc = b * b - a * cc
	if (disc < 0) return -1                    // misses the sphere entirely
	const t = (-b - Math.sqrt(disc)) / a
	return (t >= 0 && t <= 1) ? t : -1
}

// Phase 4 MEGA-HEALTH pickup tuning (locked design numbers). Server-only.
const MEGA = {
	// X/Z are the BOX-ARENA placement only. The arena CENTER is occupied by the reactor
	// landmark (OBSTACLE_SPECS: x0 z0, 4x4), so the pickup sits 6m north of it — open
	// floor, still the visual "heart" of the arena, verified clear of every obstacle +
	// wall (reactor z-max=2; nearest cover (-5,9)/(5,-9) both clear x=0,z=6).
	//
	// MESH MAPS IGNORE X/Z (see megaSpawnPos): OBSTACLE_SPECS does not exist there, and
	// world (0, 6) on CTF-Visage is a tower column whose top is world y -17.43 — the
	// pickup sat 18.4m above it and ~25m above the walkable deck, so with RADIUS 2.2
	// the proximity test could never pass and the entire mechanic was dead while
	// clients rendered a glowing amber box floating in the sky. Mesh maps take their
	// position from this.map.mega (common/mapMesh.js) instead.
	X: 0,
	Y: 1.0,                // bob height ABOVE THE FLOOR — the box arena's floor is the
	                       // plane y=0, a mesh map's is this.map.mega.y; both add this.
	Z: 6,
	HEAL: 100,             // added on pickup
	MAX: 150,              // overheal cap: min(150, hp+HEAL)
	RADIUS: 2.2,           // pickup radius (living players only)
	RESPAWN: 60.0,         // seconds from taken -> available again
	CHARGE_LEAD: 5.0,      // seconds before respawn the CHARGING tell (rising hum) starts
	OVERHEAL_GRACE: 3.0,   // seconds after pickup before overheal starts decaying
	OVERHEAL_RATE: 2.0     // HP/sec decay while hitpoints > 100 (after the grace)
}

// Slack added to every side of the derived network view box (world units): headroom
// for jump/rocket arcs, grenades and FX that briefly leave the floor's footprint.
const VIEW_MARGIN = 16

// UT-STYLE SPAWN tuning (v1). SPAWN_POINTS below SPAWN_MIN_HEADROOM metres of clearance
// are dropped (Visage's 20 are all headroom 15, so none drop). Each surviving point is
// drop-probed to the real floor and the player is placed SPAWN_REST above it so
// applyCommand gravity settles them cleanly (same intent as the legacy "y a hair above
// the floor" note) — this is what makes the re-extracted UT y-values (~1m off the old
// hand-tuned spawns) land on the deck instead of inside/below it.
const SPAWN_MIN_HEADROOM = 4
const SPAWN_REST = 0.5
const SPAWN_PROBE_UP = 2.0
const SPAWN_PROBE_DOWN = 6.0

// ---------------------------------------------------------------------------
// TDM (Team Deathmatch) v1 — the first real game mode. All numbers are design
// constants; the match runs perpetually with bots and a human joins mid-ACTIVE.
// ---------------------------------------------------------------------------
// Friendly fire: a shot on a TEAMMATE deals 0 damage and scores nothing (TDM only).
// Single tunable. FFA bypasses this entirely — everyone can damage everyone.
const FRIENDLY_FIRE = false
// GAME MODE — TDM (two teams) or FFA (free-for-all, individual frags). Default TDM.
// Resolved per-instance in the constructor from (in order): env MODE=FFA|TDM, the
// constructor's modeArg (the rotation entry's effective mode — serverMain passes it),
// the map registry's `mode` field, else TDM.
const GAME_MODE = { TDM: MATCH_MODE.TDM, FFA: MATCH_MODE.FFA }
// The score cap is the DIFFICULTY dial and ENDS the match early the moment a team
// (TDM) or a player (FFA) reaches it — at any time, including overtime. Kept at 40 as
// the tunable starting difficulty (NOT a blowout number).
const FRAG_LIMIT = 40
// Regulation runs to 10:00 — a decided match fills the ~10-minute block window. The
// score cap can still end it earlier. TIE_CHECK_MS is the 8:00 mark: if the score is
// EXACTLY tied there we go to SUDDEN DEATH immediately; otherwise play on to 10:00.
// MATCH_SECONDS is a DEV/TEST override only (e.g. MATCH_SECONDS=20 to fast-forward a
// match end and watch the rotation restart); production leaves it unset. The tie-check
// keeps its 8:00/10:00 ratio (80% of regulation) so the state machine is exercised
// identically at any length.
const _matchSeconds = parseInt(process.env.MATCH_SECONDS || '', 10)
const TIME_LIMIT_MS = _matchSeconds > 0 ? _matchSeconds * 1000 : 10 * 60 * 1000 // 10:00 regulation
const TIE_CHECK_MS = Math.round(TIME_LIMIT_MS * 0.8)                            // 8:00 sudden-death tie-check
// MATCH_END intermission (winner banner + final scores) before the scores/kills
// reset and a fresh ACTIVE match begins.
const INTERMISSION_MS = 15 * 1000
// How often the low-rate MatchState entity re-publishes the ticking countdown while
// nothing else changed (score/phase/winner changes publish immediately). ~2Hz.
const MATCH_PUBLISH_MS = 500

class GameInstance {
	static RESPAWN_DELAY_MS = 2500

	constructor(mapArg, modeArg) {
		const engine = new BABYLON.NullEngine()
		engine.enableOfflineSupport = false
		const scene = new BABYLON.Scene(engine)
		scene.collisionsEnabled = true
		//const camera = new BABYLON.ArcRotateCamera("Camera", 0, 0.8, 100, BABYLON.Vector3.Zero(), scene)

		// Runtime map selection. Resolve the constructor arg (map id | record) to a
		// canonical registry record; with no arg the default is CTF-Visage, so this
		// instance is byte-identical to the live game. setActiveMap() syncs the module-
		// level active-map bindings (USE_MESH_MAP / MAP_MESH / KILL_Y in mapMesh.js) that the pure
		// applyCommand and server/navGraph read — keeping map selection a RUNTIME value
		// without changing applyCommand's (entity, command) signature.
		this.map = mapArg ? getMapRecord(mapArg) : getMapRecord(DEFAULT_MAP_ID)
		setActiveMap(this.map)
		this.useMeshMap = this.map.useMeshMap
		this.killY = this.map.killY

		this.instance = new nengi.Instance(nengiConfig, { port: 8079 })
		niceInstanceExtension(this.instance)

		// game-related state
		// Mesh map: skip the box arena and load the artist OBJ as collision geometry
		// (async — ready within ~1s of boot, before anyone connects). Box arenas keep the
		// setupObstacles path. this.obstacles stays a Map either way (used elsewhere).
		this.mapReady = false
		// Static world geometry the server's hitscan resolution occludes against
		// (server/lagCompensatedHitscanCheck.js). Mesh maps fill this from the artist
		// OBJ once _loadMapMesh resolves; box arenas fill it from the Obstacle boxes
		// immediately. Plain babylon meshes either way, so one occlusion path serves both.
		// It stays EMPTY during the async mesh load at boot -> no occlusion for that
		// window, i.e. exactly the old behaviour. Deliberate: failing open for the ~1s
		// before anyone can connect is far safer than a server that silently eats every
		// shot, and mapReady gates nothing else about damage.
		this.occluderMeshes = []
		// The nengi AABB every client's view is cut from (see deriveViewBox). Set BEFORE
		// _loadMapMesh so there is no window where it is undefined; the mesh-derived box
		// replaces it once the OBJ resolves, which is well before anyone can connect.
		this.viewBox = this.defaultViewBox()
		if (this.useMeshMap) {
			this.obstacles = new Map()
			this._loadMapMesh(scene)
		} else {
			this.obstacles = setupObstacles(this.instance)
			this.occluderMeshes = [...this.obstacles.values()].map(o => o.mesh).filter(Boolean)
			this.mapReady = true
		}
		this.projectiles = new Set()
		// Phase 3: thrown frag grenades (mirrors this.projectiles). Server-only
		// physics (gravity+bounce+fuse) + AoE detonation live in update().
		this.grenades = new Set()

		// UT-STYLE PICKUPS (v1): live Pickup entities on the map (weapon/ammo/health/
		// armor/powerup). Filled by setupPickups() once the collision mesh is ready (mesh
		// maps load async — see _loadMapMesh), so the drop-probe runs against real
		// geometry. Box arenas carry no PICKUPS block, so this stays empty for them.
		this.pickups = []

		// Phase 4: the ONE mega-health pickup, on contested ground at bob height.
		// Present (AVAILABLE) from boot; update() runs the proximity heal + 60s respawn
		// clock and drives its networked `state` (which the client renders the tell off).
		const megaPos = this.megaSpawnPos()
		this.megaHealth = new MegaHealthPickup(megaPos.x, megaPos.y, megaPos.z)
		this.megaHealth.state = MEGA_STATE.AVAILABLE
		this.instance.addEntity(this.megaHealth)
		// (the rest is just attached to client objects when they connect)

		// TDM MATCH STATE. Team scores live on the instance (authoritative); the
		// MatchState entity is the low-rate wire carrier the HUD reads. The match runs
		// perpetually — boot straight into an ACTIVE match so a human always joins one
		// in progress (no lobby / warmup gate).
		this.teamScore = [0, 0]
		this.matchPhase = MATCH_PHASE.ACTIVE
		this.matchStartAt = Date.now()
		this.matchEndAt = 0
		this.matchWinner = MATCH_WINNER.DRAW
		this._matchPublishAt = 0
		// fires the 8:00 sudden-death tie-check exactly once per match (reset each match).
		this._tieChecked = false
		// GAME MODE resolution (env override → rotation modeArg → map registry `mode`
		// → default TDM). modeArg is the rotation entry's EFFECTIVE mode string
		// ('FFA'|'TDM') from serverMain; env MODE stays the dev/probe escape hatch.
		const envMode = (process.env.MODE || '').toUpperCase()
		const argMode = (modeArg || '').toUpperCase()
		this.gameMode = envMode === 'FFA' ? GAME_MODE.FFA
			: envMode === 'TDM' ? GAME_MODE.TDM
			: argMode === 'FFA' ? GAME_MODE.FFA
			: argMode === 'TDM' ? GAME_MODE.TDM
			: (this.map && typeof this.map.mode === 'string' && this.map.mode.toUpperCase() === 'FFA'
				? GAME_MODE.FFA : GAME_MODE.TDM)
		console.log(`[match] mode=${this.gameMode === GAME_MODE.FFA ? 'FFA' : 'TDM'}`)
		// Park it HIGH above the play space but INSIDE the nengi view AABB: centred in
		// x/z, near the top of the box in y. That keeps it replicated to every client
		// (the AABB culler reads its x/y/z) while putting its bare historian hitbox where
		// no shot ever travels (walkable ceiling is far below). See MatchState.js.
		const msX = this.viewBox.x
		const msY = this.viewBox.y + this.viewBox.halfHeight * 0.85
		const msZ = this.viewBox.z
		this.matchState = new MatchState(msX, msY, msZ)
		this.matchState.phase = this.matchPhase
		this.matchState.timeRemainingMs = TIME_LIMIT_MS
		this.matchState.winner = this.matchWinner
		this.matchState.mode = this.gameMode
		this.instance.addEntity(this.matchState)

		// AI players: real PlayerCharacter entities driven by BotController through
		// the same applyCommand physics + performShot weapon authority as humans.
		// Each bot is wrapped in a client-like handle whose rawEntity and
		// smoothEntity are the SAME entity, so damagePlayer/respawnPlayer and the
		// hitscan victim resolution work identically for bots and people.
		this._nameCounter = 0
		// server-only: smooth nid -> human callsign (bots never appear here). Used to
		// replay existing human names to late joiners and cleaned up on disconnect.
		this._humanNames = new Map()
		this.bots = []
		// BOT AUTO-FILL (default ON). BOT_FILL = target TOTAL combatants (humans +
		// bots), default 6; the server tops the arena up with bots and swaps them out
		// 1:1 as humans join/leave (see _rebalanceBots). BOT_FILL=0 disables. Legacy
		// BOTS=N still means a FIXED bot count with no autofill (probes/harnesses
		// depend on an exact roster), and takes precedence when set.
		this._humanCount = 0 // humans past the nengi handshake ('connect' fired)
		if (process.env.BOTS !== undefined) {
			this._botFillTarget = 0 // fixed mode: never rebalance
			const botCount = parseInt(process.env.BOTS, 10) || 0
			for (let i = 0; i < botCount; i++) this.addBot(i)
		} else {
			const fill = parseInt(process.env.BOT_FILL, 10)
			this._botFillTarget = Number.isNaN(fill) ? 6 : Math.max(0, fill)
			this._rebalanceBots()
		}

		// GODMODE: real players are immortal (set GODMODE=1/true). Bots still take
		// damage so you can frag them and watch death anims while wandering unkillable.
		this._godmode = process.env.GODMODE === '1' || process.env.GODMODE === 'true'
		if (this._godmode) console.log('[GODMODE] real players are immortal')

		// PROOF OF BLOOD: server-side block engine — players mine $BLOOD with
		// hashpower earned in combat (kills; objective events when modes exist).
		// Blocks close on wall clock (BLOOD_BLOCK_MS overrides the 10-min default
		// for testing only); state persists in data/blood-ledger.json.
		this.bloodLedger = new BloodLedger({ dataDir: 'data' })

		// FRAGBENCH v0: the sanctioned-agent endpoint (FRAGBENCH=1 to enable). External
		// strategist processes drive real PlayerCharacters through AgentBotController —
		// same authority path as every bot/human. See server/AgentGateway.js.
		this.agentGateway = null
		if (process.env.FRAGBENCH === '1' || process.env.FRAGBENCH === 'true') {
			this.agentGateway = new AgentGateway(this)
		}

		this.instance.on('connect', ({ client, callback }) => {
			// PER player-related state, attached to clients

			// create a entity for this client
			const rawEntity = new PlayerCharacter()
			rawEntity.mesh.checkCollisions = true

			// TDM: auto-balance onto the team with fewer players (tie -> team 0). Set
			// BEFORE the spawn so we spawn on the assigned team's spawn points.
			rawEntity.teamId = this.assignTeam()

			// spread spawns out — spawning everyone at the exact origin puts players
			// INSIDE each other's collision boxes, and moveWithCollisions can't escape
			// from inside a collider (you'd be frozen until the other player moves)
			const spawn = this.spawnPoint(rawEntity.teamId)
			rawEntity.x = spawn.x
			rawEntity.y = spawn.y || 0
			rawEntity.z = spawn.z
			this._recordSpawn(rawEntity)

			// make the raw entity only visible to this client
			const channel = this.instance.createChannel()
			channel.subscribe(client)
			channel.addEntity(rawEntity)
			//this.instance.addEntity(rawEntity)
			client.channel = channel

			// smooth entity is visible to everyone
			const smoothEntity = new PlayerCharacter()
			smoothEntity.mesh.checkCollisions = false
			smoothEntity.x = rawEntity.x
			smoothEntity.y = rawEntity.y
			smoothEntity.z = rawEntity.z
			this.instance.addEntity(smoothEntity)

			// Human players are flagged with HUMAN_NAME_SENTINEL on both entities; their
			// real callsign (typed at the menu) arrives via SetNameCommand and is
			// broadcast to everyone as a PlayerName message. Bots still use the round-
			// robin PLAYER_NAMES index (see addBot). Same lockstep rule as hitpoints —
			// the victim reads raw (private channel), everyone else reads smooth.
			rawEntity.nameIndex = HUMAN_NAME_SENTINEL
			smoothEntity.nameIndex = HUMAN_NAME_SENTINEL

			// mirror the assigned team onto the smooth entity — remote clients read THAT
			// one for team colors (same lockstep rule as hitpoints / nameIndex).
			smoothEntity.teamId = rawEntity.teamId

			// tell the client which entities it controls + where it spawned
			this.instance.message(new Identity(rawEntity.nid, smoothEntity.nid, rawEntity.x, rawEntity.y, rawEntity.z), client)

			// establish a relation between this entity and the client
			rawEntity.client = client
			client.rawEntity = rawEntity
			smoothEntity.client = client
			client.smoothEntity = smoothEntity
			client.positions = []

			// The network view is a FIXED box sized to the MAP's walkable floor, so
			// nothing in the playable world is ever network-culled — players,
			// projectiles and pickups all stay visible and their meshes never get
			// disposed. Still deliberately NOT re-centered on the player (there is no
			// 3D view culler in nengi yet). See deriveViewBox for how it is measured
			// and why it is per-axis and off-origin. Copied per client because nengi
			// mutates the view object.
			client.view = { ...this.viewBox }

			// accept the connection
			callback({ accepted: true, text: 'Welcome!' })

			// replay existing human players' names to the new joiner so their nametags
			// resolve immediately (their SetNameCommand fired before this client existed)
			this._humanNames.forEach((name, nid) => {
				this.instance.message(new PlayerName(nid, name), client)
			})

			// AUTO-FILL: a human took a slot — retire one fill bot to hold the target
			// headcount (prefers a dead / lowest-scoring one; see _rebalanceBots).
			this._humanCount++
			this._rebalanceBots()
		})

		this.instance.on('disconnect', client => {
			// clean up per client state.
			// NOTE: a socket can connect and drop *before* completing nengi's handshake
			// (never reaching the 'connect' handler that assigns these), so everything
			// here may be undefined. Guard each cleanup — an unguarded throw in this
			// handler would take down the whole server on any half-open connection.
			if (client.rawEntity) {
				client.rawEntity.mesh.dispose()
				this.instance.removeEntity(client.rawEntity)
			}
			if (client.smoothEntity) {
				this._humanNames.delete(client.smoothEntity.nid)
				client.smoothEntity.mesh.dispose()
				this.instance.removeEntity(client.smoothEntity)
			}
			if (client.channel) {
				client.channel.destroy()
			}
			// AUTO-FILL: only count down clients that counted UP (rawEntity is assigned
			// in 'connect'; a pre-handshake drop never incremented _humanCount).
			if (client.rawEntity) {
				this._humanCount = Math.max(0, this._humanCount - 1)
				this._rebalanceBots()
			}
		})

		this.instance.on('command::MoveCommand', ({ command, client, tick }) => {
			// move this client's entity
			const entity = client.rawEntity

			applyCommand(entity, command, this.obstacles)

			// Phase 3: frag-grenade throw. The client edge-triggers throwInput (rising
			// edge only), but we also gate server-side on charges + cooldown so a
			// spoofed always-true throwInput can't dump grenades. Uses the aim vector
			// carried in the command (same ray applyCommand looks along).
			if (command.throwInput) {
				this.throwGrenade(client, command)
			}

			client.positions.push({
				x: entity.x,
				y: entity.y,
				z: entity.z,
				rotation: entity.rotation
			})
		})

		this.instance.on('command::SwitchWeaponCommand', ({ command, client, tick }) => {
			const entity = client.rawEntity
			// UT-STYLE OWNERSHIP GATE (v1): refuse a switch to an unowned weapon (mirrors
			// the applyCommand gate + weapon.fire()). Server-authoritative.
			if (entity && command.index !== undefined && command.index >= 0 && command.index < weapons.length
				&& (entity.ownedWeapons === undefined || (entity.ownedWeapons & (1 << command.index)))) {
				// swap commitment: start the equip lock when the index actually changes,
				// matching the client's switchWeapon() + applyCommand so fire() gates in
				// lockstep. (This handler sets currentWeaponIndex directly, so the next
				// MoveCommand's applyCommand won't see a change — set it here too.)
				if (command.index !== entity.currentWeaponIndex) {
					entity.equipTimer = (weapons[command.index] && weapons[command.index].drawTime) || 0
				}
				entity.currentWeaponIndex = command.index
				// mirror to the smooth entity — remote clients read THAT one (same
				// lockstep rule as hitpoints in damagePlayer); without this everyone
				// appears to hold weapon 0 forever
				if (client.smoothEntity) client.smoothEntity.currentWeaponIndex = command.index
			}
		})

		this.instance.on('command::DevUpdateWeaponConfigCommand', ({ command, client, tick }) => {
			// weapon config is global + authoritative — only honor this in local dev
			if (process.env.ALLOW_DEV_TOOLS !== '1') return
			if (command.index !== undefined && command.index >= 0 && command.index < weapons.length) {
				const w = weapons[command.index]
				w.type = command.type === 0 ? 'hitscan' : 'projectile'
				w.fireCooldown = command.fireCooldown
				w.reloadTime = command.reloadTime
				w.magazineCapacity = command.magazineCapacity
				w.maxReserveAmmo = command.maxReserveAmmo
				w.damage = command.damage
				w.range = command.range
				w.projectileSpeed = command.projectileSpeed
				console.log(`[DEV] Authoritative weapon config updated at runtime for index ${command.index} (${w.name}):`, w)

				// Adjust the client's player entity weaponsState limits immediately
				const entity = client.rawEntity
				if (entity && entity.weaponsState && entity.weaponsState[command.index]) {
					const state = entity.weaponsState[command.index]
					if (state.magazineAmmo > w.magazineCapacity) {
						state.magazineAmmo = w.magazineCapacity
					}
					if (state.reserveAmmo > w.maxReserveAmmo) {
						state.reserveAmmo = w.maxReserveAmmo
					}
				}
			}
		})

		this.instance.on('command::FireCommand', ({ command, client, tick }) => {
			// CEASEFIRE: no shots resolve during the MATCH_END intermission (bots hold
			// trigger in the bot loop; damagePlayer is gated too — belt and braces).
			if (this.matchPhase === MATCH_PHASE.MATCH_END) return
			// shoot from the perspective of this client's entity
			this.performShot(client)
		})

		this.instance.on('command::SetNameCommand', ({ command, client }) => {
			// a human's chosen callsign: keyed by smooth nid (the shared identity),
			// stored server-side for late-joiner replay, and broadcast to everyone.
			if (!client.smoothEntity) return
			const name = decodeName(command)
			const nid = client.smoothEntity.nid
			this._humanNames.set(nid, name)
			this.instance.messageAll(new PlayerName(nid, name))
		})
	}

	// Fire the shooter's current weapon and resolve its effects. `shooter` is a
	// client OR a bot handle — anything with rawEntity/smoothEntity (bots point
	// both at the same entity) and optionally latency. Shared by the FireCommand
	// handler and the bot AI so both go through identical weapon authority.
	performShot(shooter) {
		const entity = shooter.rawEntity
		const smoothEntity = shooter.smoothEntity

		const ray = fire(entity)
		if (!ray) return
		const config = ray.config
		const timeAgo = (shooter.latency || 0) + 100

		if (config.type === 'hitscan') {
			// Deterministic per-weapon spread (common/firePattern.js): the SAME
			// seeded pattern the firing client predicted (seed derives from
			// nid/weapon/ammo on both sides), so the wall marks a player painted
			// are the rays that judged damage. One entry for single-bullet
			// weapons, a rosette for the shotgun.
			const offsets = shotPattern(config, ray.seed, ray.heat, ray.aimFactor)
			// RANGE + OCCLUSION budget for every pellet of this shot.
			//
			// `range` is a HARD CUTOFF on hitscan reach, not a damage curve: nothing in
			// common/damageFalloff.js reads it (falloff is driven purely by falloffStart/
			// falloffEnd/falloffMinMult), so it has no damage semantics to regress —
			// today it is simply never enforced, which is how a Shotgun (range 30) can
			// kill across the whole map. But the cutoff must never truncate the weapon's
			// effective falloff window: the ADS pistol's ads.rangeMult 1.75 pushes
			// falloffEnd 40 -> 70, past its range of 50, and clipping at 50 would delete
			// the designed "aimed pistol keeps the 3-shot kill at range". So the reach is
			// max(range, ADS-extended falloffEnd) — a real cutoff for every weapon, and
			// still the full authored falloff curve for the pistol.
			const reach = Math.max(config.range || 0, falloffRange(config, ray.aimFactor).end) || Number.MAX_VALUE
			const world = { meshes: this.occluderMeshes, maxDistance: reach }
			offsets.forEach(off => {
				const d = applyPattern(ray.direction, off)
				const pelletRay = new BABYLON.Ray(ray.origin, new BABYLON.Vector3(d.x, d.y, d.z))
				const hits = lagCompensatedHitscanCheck(this.instance, pelletRay, timeAgo, world)
				// a single pellet ray can intersect BOTH of a victim's entities
				// (raw + smooth are the same player at slightly different
				// lag-compensated spots) — dedupe per pellet so one pellet is
				// one hit, applied once to the player's canonical state
				const damagedThisPellet = new Set()
				hits.forEach(hit => {
					// lagCompensatedHitscanCheck now returns { entity, zone, distance } so the
					// authoritative body-zone rides each confirmed hit (v1: hitscan only).
					const victim = hit.entity
					if (victim.nid !== entity.nid && victim.nid !== smoothEntity.nid) {
						if (victim instanceof PlayerCharacter && victim.isAlive &&
							victim.client && !damagedThisPellet.has(victim.client)) {
							damagedThisPellet.add(victim.client)
							// Distance-based damage falloff (common/damageFalloff.js): opt-in
							// per weapon, flat for weapons without a falloff window. Distance is
							// shooter (ray.origin) -> victim position; ADS (ray.aimFactor, the
							// ramp this shot fired with) extends the pistol's full-damage range.
							const dist = BABYLON.Vector3.Distance(ray.origin, victim.mesh.position)
							const dmg = Math.round(config.damage * damageFalloffMult(config, dist, ray.aimFactor))
							// hit.zone (head/torso/legs) -> the per-zone multiplier is applied
							// authoritatively in damagePlayer, NOT here (outside applyCommand).
							this.damagePlayer(victim.client, shooter, dmg, config.name, config.index, hit.zone)
						}
					}
				})
			})

			// Send WeaponFired to observers with the weapon identity + spread
			// inputs so they render the exact same pattern + per-weapon FX
			this.instance.addLocalMessage(new WeaponFired(
				smoothEntity.nid,
				smoothEntity.x,
				smoothEntity.y,
				smoothEntity.z,
				ray.direction.x,
				ray.direction.y,
				ray.direction.z,
				config.index,
				ray.seed,
				ray.heat,
				ray.aimFactor
			))
		} else if (config.type === 'projectile') {
			// Projectile weapon. Flak (config.pellets > 1) fires a cone burst of
			// shrapnel; Plasma (no pellets) fires one bolt. Each pellet is its own
			// Projectile entity carrying the shrapnel bounce budget + slow debuff.
			const pellets = (config.pellets && config.pellets > 1) ? config.pellets : 1
			for (let i = 0; i < pellets; i++) {
				// jitter each pellet within a cone of half-angle ~spreadBase around the
				// aim vector (single-pellet weapons keep the exact aim). Uses the shared
				// applyPattern basis math; Math.random is acceptable here — projectiles
				// are server-authoritative and NOT part of the reconciled client sim.
				let d = ray.direction
				if (pellets > 1) {
					const spread = config.spreadBase || 0.03
					const off = { dx: (Math.random() - 0.5) * 2 * spread, dy: (Math.random() - 0.5) * 2 * spread }
					d = applyPattern({ x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }, off)
				}
				const proj = new Projectile(ray.origin.x, ray.origin.y, ray.origin.z)
				proj.dirX = d.x
				proj.dirY = d.y
				proj.dirZ = d.z
				// ADS speeds the bolt (aimFactor 0..1 * the weapon's projSpeedMult) so
				// aimed shots need less lead at range (Hale). Non-ADS weapons unaffected.
				const _af = Math.min(1, Math.max(0, ray.aimFactor || 0))
				const _psm = (config.ads && config.ads.projSpeedMult) ? (1 + (config.ads.projSpeedMult - 1) * _af) : 1
				proj.speed = (config.projectileSpeed || 30) * _psm
				// ADS also THINS the bolt (aimFactor 0..1 * the weapon's projSizeMult):
				// aimed = a smaller collision radius (a precise dart) vs the fat hip ball.
				// hip (aimFactor 0) keeps the full default radius; non-ADS weapons unaffected.
				const _pzm = (config.ads && config.ads.projSizeMult) ? (1 + (config.ads.projSizeMult - 1) * _af) : 1
				proj.radius = proj.radius * _pzm
				proj.damage = config.damage || 25
				proj.ownerNid = entity.nid
				proj.weaponIndex = config.index
				proj.bounceRemaining = config.bounceCount || 0
				proj.slowFactor = config.slowFactor || 0
				proj.slowDuration = config.slowDuration || 0
				proj.velocity = new BABYLON.Vector3(d.x, d.y, d.z).scale(proj.speed)
				proj.lifeTime = 3.0 // 3 seconds max lifetime

				this.instance.addEntity(proj)
				this.projectiles.add(proj)
			}
		}
	}

	// Phase 3: spawn a thrown frag grenade for `shooter` (a client OR bot handle).
	// Gated on charges + throwCooldown so it fires only on a real, allowed throw.
	// Launch is from the eye/aim position along the aim vector, pitched 15° up.
	throwGrenade(shooter, command) {
		const entity = shooter.rawEntity
		if (!entity || !entity.isAlive) return
		if (entity.throwCooldown > 0) return
		if (entity.grenadeCharges <= 0) return

		// spend a charge + start the min-interval lock. Mirror the count to the
		// smooth entity so any smooth-reading HUD stays in lockstep (the HUD reads
		// the client's own raw entity, but keep them consistent like hitpoints).
		entity.grenadeCharges -= 1
		entity.throwCooldown = GRENADE.THROW_INTERVAL
		if (shooter.smoothEntity) shooter.smoothEntity.grenadeCharges = entity.grenadeCharges

		// aim vector from the command (already normalized-ish camera forward)
		let ax = command.camRayX, ay = command.camRayY, az = command.camRayZ
		const aLen = Math.hypot(ax, ay, az) || 1
		ax /= aLen; ay /= aLen; az /= aLen

		// pitch the launch 15° ABOVE the aim vector: rotate the aim about the
		// horizontal axis perpendicular to it (i.e. add upward tilt). Cheap approach:
		// blend in +Y then renormalize, scaled so the resulting angle rises ~15°.
		const pitch = (GRENADE.PITCH_DEG * Math.PI) / 180
		// horizontal component of the aim (for building the tilt)
		const hLen = Math.hypot(ax, az) || 0.0001
		// new direction: keep heading, raise elevation by `pitch`
		const curElev = Math.asin(Math.max(-1, Math.min(1, ay)))
		const newElev = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, curElev + pitch))
		const cosE = Math.cos(newElev)
		const dx = (ax / hLen) * cosE
		const dz = (az / hLen) * cosE
		const dy = Math.sin(newElev)

		// launch position: the player's eye (roughly head height above the entity)
		const eyeY = entity.y + 0.6
		const grenade = new Grenade(entity.x + dx * 0.5, eyeY + dy * 0.5, entity.z + dz * 0.5)
		grenade.velocity = new BABYLON.Vector3(dx, dy, dz).scale(GRENADE.SPEED)
		grenade.ownerNid = entity.nid
		grenade.fuse = GRENADE.FUSE
		grenade.restitution = GRENADE.RESTITUTION

		this.instance.addEntity(grenade)
		this.grenades.add(grenade)
	}

	// Phase 3: AoE detonation. Damages every living player within RADIUS (including
	// the thrower — self-damage is intentional) with LINEAR falloff from DMG_CENTER
	// at 0m to DMG_EDGE at RADIUS, 0 beyond. Attributes damage to the thrower so
	// frags credit correctly. Routes through damagePlayer so kills/messages/feedback
	// fire, applying to raw+smooth in lockstep. Removing the entity triggers the
	// client explosion FX (Grenade factory delete → renderer.grenadeExplosion).
	detonateGrenade(grenade) {
		const gx = grenade.x, gy = grenade.y, gz = grenade.z

		// resolve the thrower handle (client or bot) from ownerNid
		let attacker = null
		this.instance.clients.forEach(ac => {
			if (ac.rawEntity && ac.rawEntity.nid === grenade.ownerNid) attacker = ac
		})
		if (!attacker) attacker = this.bots.find(b => b.rawEntity.nid === grenade.ownerNid) || null

		// every candidate victim (humans + bots), each hit at most once
		const targets = []
		this.instance.clients.forEach(c => targets.push(c))
		targets.push(...this.bots)

		targets.forEach(c => {
			const v = c.rawEntity
			if (!v || !v.isAlive) return
			const dx = v.x - gx, dy = v.y - gy, dz = v.z - gz
			const dist = Math.hypot(dx, dy, dz)
			if (dist >= GRENADE.RADIUS) return

			// LINE OF SIGHT. The radius test on its own is a pure Math.hypot with no
			// occlusion, so a blast damages straight THROUGH a wall. That was harmless
			// only because grenades never survived to detonate anywhere useful on a mesh
			// map; fixing the floor above would have turned zero damage into 5m
			// through-wall damage, which is strictly worse. So both ship together.
			//
			// Same query and same rule as hitscan occlusion: geometry strictly BETWEEN
			// the blast and the victim blocks it, geometry behind the victim does not.
			// Only paid for players already inside the 5m radius, over a <=5m ray.
			if (this.occluderMeshes.length > 0) {
				// lift the origin off whatever the grenade is resting on, or the deck
				// under it counts as the wall that blocks its own blast
				const oy = gy + GRENADE.SKIN
				const lx = v.x - gx, ly = v.y - oy, lz = v.z - gz
				const lLen = Math.hypot(lx, ly, lz)
				if (lLen > 0.001 &&
					sweepWorld(this.occluderMeshes, gx, oy, gz, lx / lLen, ly / lLen, lz / lLen, lLen) < lLen) return
			}

			// linear falloff: t=0 at center → DMG_CENTER, t=1 at edge → DMG_EDGE
			const t = dist / GRENADE.RADIUS
			const dmg = Math.round(GRENADE.DMG_CENTER + (GRENADE.DMG_EDGE - GRENADE.DMG_CENTER) * t)
			if (dmg <= 0) return
			this.damagePlayer(c, attacker, dmg, 'grenade', 0)
		})

		// remove the grenade — its factory.delete on each client fires the blast FX
		this.instance.removeEntity(grenade)
		if (grenade.mesh && grenade.mesh.dispose) grenade.mesh.dispose()
		this.grenades.delete(grenade)
	}

	// Phase 4: drive the mega-health pickup each tick. When AVAILABLE, proximity-check
	// every living player (humans + bots) within RADIUS → heal to min(MAX, hp+HEAL),
	// arm their overheal grace timer, then take it (state→HIDDEN, respawnAt = now+60s).
	// While taken, flip to CHARGING in the last CHARGE_LEAD seconds (drives the client's
	// rising-hum tell + scale-in), then back to AVAILABLE at respawnAt. Heal is applied
	// to raw+smooth in lockstep (same rule as damagePlayer). `now` is wall-clock ms.
	updateMegaHealth(now) {
		const mh = this.megaHealth
		if (!mh) return

		if (mh.state === MEGA_STATE.AVAILABLE) {
			// every candidate grabber (humans + bots)
			const targets = []
			this.instance.clients.forEach(c => targets.push(c))
			targets.push(...this.bots)
			for (const c of targets) {
				const raw = c.rawEntity
				const smooth = c.smoothEntity
				if (!raw || !raw.isAlive) continue
				const dx = raw.x - mh.x, dy = raw.y - mh.y, dz = raw.z - mh.z
				if (Math.hypot(dx, dy, dz) > MEGA.RADIUS) continue

				// GRAB (first-come, no ownership). Heal to the overheal cap; arm the grace
				// timer so the >100 portion holds for OVERHEAL_GRACE before decaying.
				const hp = Math.min(MEGA.MAX, raw.hitpoints + MEGA.HEAL)
				raw.hitpoints = hp
				if (smooth) smooth.hitpoints = hp
				raw.overhealDecayTimer = MEGA.OVERHEAL_GRACE
				if (smooth) smooth.overhealDecayTimer = MEGA.OVERHEAL_GRACE

				// take it: hide + start the respawn clock. The AVAILABLE→HIDDEN transition
				// is what the client reacts to (pickup chime + hum stop).
				mh.state = MEGA_STATE.HIDDEN
				mh.respawnAt = now + MEGA.RESPAWN * 1000
				console.log(`Player ${raw.nid} grabbed MEGA-HEALTH → HP ${hp}`)
				break
			}
			return
		}

		// taken: run the respawn clock. CHARGING in the final CHARGE_LEAD seconds so the
		// client can time the grab (rising hum + scale/fade-in), then AVAILABLE.
		if (now >= mh.respawnAt) {
			mh.state = MEGA_STATE.AVAILABLE
		} else if (now >= mh.respawnAt - MEGA.CHARGE_LEAD * 1000) {
			if (mh.state !== MEGA_STATE.CHARGING) mh.state = MEGA_STATE.CHARGING
		}
	}

	// UT-STYLE PICKUPS (v1): the generalized sibling of updateMegaHealth. Each tick, for
	// every AVAILABLE pickup, proximity-check every living player (humans + bots) against
	// its OWN authoritative mesh position (idempotent — the AVAILABLE guard means a taken
	// pickup can't be granted twice). On a grab, apply the type-specific effect
	// (grantPickup), flip state→HIDDEN and start the per-type respawn clock; while taken,
	// flip to CHARGING in the final CHARGE_LEAD seconds, then back to AVAILABLE. FULLY
	// SERVER-AUTHORITATIVE — the client never asserts a pickup; it only mirrors its own
	// refill off the networked ownedWeapons / state (see Simulator). `now` is wall-clock ms.
	//
	// COST: O(pickups × players) cheap squared-distance tests, no allocation in the hot
	// loop, no raycast (positions are static). On Visage (~50 pickups) with a couple of
	// players this is a few hundred float ops per tick — negligible against the collision
	// budget the mesh-map notes measure in whole percent.
	updatePickups(now) {
		const list = this.pickups
		if (!list || list.length === 0) return

		const targets = []
		this.instance.clients.forEach(c => targets.push(c))
		for (const b of this.bots) targets.push(b)

		const R2 = PICKUP_RADIUS * PICKUP_RADIUS
		let removed = false
		for (const pk of list) {
			if (pk._removed) continue
			// DROP-ON-DEATH weapons: no respawn clock — they either get grabbed or DESPAWN
			// at pk.despawnAt (30s). Removed from the world entirely on grab/despawn so the
			// client deletes the mesh (map pickups only ever HIDE via `state`).
			if (pk.isDrop) {
				if (now >= pk.despawnAt) {
					this.instance.removeEntity(pk); pk._removed = true; removed = true
					continue
				}
				for (const c of targets) {
					const raw = c.rawEntity
					if (!raw || !raw.isAlive) continue
					const dx = raw.x - pk.x, dy = raw.y - pk.y, dz = raw.z - pk.z
					if (dx * dx + dy * dy + dz * dz > R2) continue
					if (this.grantPickup(c, pk)) {
						this.instance.removeEntity(pk); pk._removed = true; removed = true
						break
					}
				}
				continue
			}
			if (pk.state === MEGA_STATE.AVAILABLE) {
				for (const c of targets) {
					const raw = c.rawEntity
					if (!raw || !raw.isAlive) continue
					const dx = raw.x - pk.x, dy = raw.y - pk.y, dz = raw.z - pk.z
					if (dx * dx + dy * dy + dz * dz > R2) continue
					// grantPickup returns false when there is nothing to gain (ammo for an
					// unowned weapon, health at cap, an already-full weapon) — in that case
					// the pickup is LEFT available.
					if (!this.grantPickup(c, pk)) continue
					pk.state = MEGA_STATE.HIDDEN
					pk.respawnAt = now + (pk.respawnMs || 30000)
					break
				}
			} else if (now >= pk.respawnAt) {
				pk.state = MEGA_STATE.AVAILABLE
			} else if (now >= pk.respawnAt - CHARGE_LEAD_SECONDS * 1000) {
				if (pk.state !== MEGA_STATE.CHARGING) pk.state = MEGA_STATE.CHARGING
			}
		}
		if (removed) this.pickups = list.filter(p => !p._removed)
	}

	// DROP-ON-DEATH: spawn a Pickup for each of a dead player's owned NON-PISTOL weapons
	// at the death location (small XZ jitter), carrying that weapon's CURRENT ammo. Each
	// drop is drop-probed to the real floor (never spawn floating/unreachable); on a probe
	// miss we fall back to the exact death spot (where the victim was standing — guaranteed
	// reachable) rather than losing the weapon. Drops despawn after DROP_DESPAWN_SECONDS.
	// Server-authoritative; drops render as ordinary WEAPON pickups (weaponIndex on the
	// wire) so no client factory change is needed — the isDrop/carried*/despawnAt fields
	// are server-only. Returns the count dropped (for the kill log). `now` is wall-clock ms.
	dropWeaponsOnDeath(raw, now) {
		if (!raw || !raw.weaponsState) return 0
		const despawnMs = DROP_DESPAWN_SECONDS * 1000
		let count = 0
		for (let wi = 0; wi < weapons.length; wi++) {
			if (wi === SPAWN_WEAPON_INDEX) continue // the spawn pistol never drops
			if (!(raw.ownedWeapons & (1 << wi))) continue
			const st = raw.weaponsState[wi]
			const carriedMag = st ? (st.magazineAmmo || 0) : 0
			const carriedReserve = st ? (st.reserveAmmo || 0) : 0
			let dropX = raw.x + (Math.random() - 0.5) * (DROP_JITTER * 2)
			let dropZ = raw.z + (Math.random() - 0.5) * (DROP_JITTER * 2)
			const floorY = this._dropProbeY(dropX, raw.y, dropZ)
			let dropY
			if (floorY != null) {
				dropY = floorY + (REST_HEIGHT[PICKUP_TYPE.WEAPON] || 0.1)
			} else {
				// jittered spot has no floor — fall back to the exact (reachable) death spot
				dropX = raw.x; dropZ = raw.z; dropY = raw.y
			}
			const pk = new Pickup(dropX, dropY, dropZ, PICKUP_TYPE.WEAPON, wi)
			pk.isDrop = true
			pk.carriedMag = carriedMag
			pk.carriedReserve = carriedReserve
			pk.despawnAt = now + despawnMs
			pk.state = MEGA_STATE.AVAILABLE
			this.instance.addEntity(pk)
			this.pickups.push(pk)
			count++
		}
		return count
	}

	// Apply a pickup's effect to a grabber. Returns true if the pickup was consumed (so
	// it should hide + start its respawn clock) or false if there was nothing to gain
	// (leave it available). Server-authoritative; heal is applied to raw+smooth in
	// lockstep (like damagePlayer). Ammo/ownership live only on the raw entity (ammo is
	// not networked; the client mirrors its OWN refill off the networked ownedWeapons +
	// pickup state — see Simulator._updatePickups).
	grantPickup(c, pk) {
		const raw = c.rawEntity
		const smooth = c.smoothEntity
		// DROP-ON-DEATH weapon (a corpse's dropped gun; renders as a WEAPON pickup but
		// carries the victim's exact ammo and never refills to full). Always consumed on
		// touch (returns true → updatePickups removes it). If the grabber does NOT own the
		// weapon, they gain it + the carried mag/reserve; if they already own it, the
		// carried ammo is banked into their reserve (capped).
		if (pk.isDrop) {
			const wi = pk.weaponIndex
			const cfg = weapons[wi]
			const st = raw.weaponsState && raw.weaponsState[wi]
			const owned = (raw.ownedWeapons & (1 << wi)) !== 0
			if (!owned) {
				raw.ownedWeapons |= (1 << wi)
				if (smooth) smooth.ownedWeapons = raw.ownedWeapons
				if (st) { st.magazineAmmo = pk.carriedMag; st.reserveAmmo = pk.carriedReserve }
			} else if (st && cfg) {
				st.reserveAmmo = Math.min(cfg.maxReserveAmmo, st.reserveAmmo + pk.carriedReserve + pk.carriedMag)
			}
			return true
		}
		if (pk.type === PICKUP_TYPE.WEAPON) {
			const wi = pk.weaponIndex
			const cfg = weapons[wi]
			const st = raw.weaponsState && raw.weaponsState[wi]
			const owned = (raw.ownedWeapons & (1 << wi)) !== 0
			const full = st && st.magazineAmmo >= cfg.magazineCapacity && st.reserveAmmo >= cfg.maxReserveAmmo
			if (owned && full) return false // nothing to gain — leave it
			raw.ownedWeapons |= (1 << wi)
			if (smooth) smooth.ownedWeapons = raw.ownedWeapons
			if (st) { st.magazineAmmo = cfg.magazineCapacity; st.reserveAmmo = cfg.maxReserveAmmo }
			return true
		}
		if (pk.type === PICKUP_TYPE.AMMO) {
			const wi = pk.weaponIndex
			if (!(raw.ownedWeapons & (1 << wi))) return false // unowned weapon — ignore
			const cfg = weapons[wi]
			const st = raw.weaponsState && raw.weaponsState[wi]
			if (!st || st.reserveAmmo >= cfg.maxReserveAmmo) return false // already full
			st.reserveAmmo = cfg.maxReserveAmmo
			return true
		}
		if (pk.type === PICKUP_TYPE.HEALTH) {
			if (raw.hitpoints >= HEALTH_CAP) return false // full — leave it
			const hp = Math.min(HEALTH_CAP, raw.hitpoints + HEALTH_HEAL)
			raw.hitpoints = hp
			if (smooth) smooth.hitpoints = hp
			return true
		}
		if (pk.type === PICKUP_TYPE.ARMOR) {
			if ((raw.armor || 0) >= ARMOR_CAP) return false // full — leave it
			const a = Math.min(ARMOR_CAP, (raw.armor || 0) + ARMOR_PICKUP)
			raw.armor = a
			if (smooth) smooth.armor = a
			return true
		}
		if (pk.type === PICKUP_TYPE.POWERUP) {
			// UDamage: (re)start the timed outgoing-damage buff. Always consumed (a fresh
			// pickup refreshes the full duration, UT-style).
			raw.udamageTimer = UDAMAGE_SECONDS
			if (smooth) smooth.udamageTimer = UDAMAGE_SECONDS
			return true
		}
		return false
	}

	// Phase 4: decay each player's overheal (hitpoints > 100) at OVERHEAL_RATE/sec,
	// but only after the per-player grace timer expires. Never touches base health
	// (floors at 100). Server-authoritative + applied to raw+smooth in lockstep like
	// damagePlayer — deliberately OUTSIDE the reconciled applyCommand path (hitpoints
	// isn't client-predicted, so this can't perturb prediction). Fractional decay is
	// accumulated on the raw entity's float hitpoints and floored to the wire UInt8.
	updateOverhealDecay(delta) {
		const decay = (raw, smooth) => {
			if (!raw || !raw.isAlive) return
			if (raw.hitpoints <= 100) { raw.overhealDecayTimer = 0; return }
			if (raw.overhealDecayTimer > 0) {
				raw.overhealDecayTimer -= delta
				if (raw.overhealDecayTimer < 0) raw.overhealDecayTimer = 0
				return
			}
			const hp = Math.max(100, raw.hitpoints - MEGA.OVERHEAL_RATE * delta)
			raw.hitpoints = hp
			if (smooth) smooth.hitpoints = hp
		}
		this.instance.clients.forEach(c => decay(c.rawEntity, c.smoothEntity))
		this.bots.forEach(b => decay(b.rawEntity, b.smoothEntity))
	}

	addBot(index) {
		const entity = new PlayerCharacter()
		entity.mesh.checkCollisions = true
		// TDM: bots count in the auto-balance exactly like humans. Assign BEFORE spawn so
		// the bot spawns on its team's spawn points.
		entity.teamId = this.assignTeam()
		const spawn = this.spawnPoint(entity.teamId)
		entity.x = spawn.x
		entity.y = spawn.y || 0
		entity.z = spawn.z
		// spread the loadouts: rifle / smg / shotgun / pistol
		entity.currentWeaponIndex = index % weapons.length
		// UT-STYLE OWNERSHIP (v1): bots own the FULL arsenal (they never pick weapons up)
		// so they behave exactly as before this feature. Refill the ammo the constructor
		// zeroed for the non-pistol slots.
		entity.ownedWeapons = PlayerCharacter.ALL_WEAPONS
		entity.weaponsState.forEach((state, i) => {
			state.magazineAmmo = weapons[i].magazineCapacity
			state.reserveAmmo = weapons[i].maxReserveAmmo
		})
		entity.nameIndex = this._nameCounter++ % PLAYER_NAMES.length
		this.instance.addEntity(entity)

		const handle = { bot: true, rawEntity: entity, smoothEntity: entity, respawnAt: null }
		handle.controller = new BotController(entity, entity.currentWeaponIndex)
		entity.client = handle // hitscan victims resolve to their owner via .client
		this.bots.push(handle)
		console.log(`Bot ${entity.nid} joined with ${weapons[entity.currentWeaponIndex].name}`)
	}

	// Retire one bot through the SAME teardown the human disconnect path uses: dispose
	// the collision mesh, remove the entity from nengi (a bot's raw and smooth are the
	// SAME entity — one removal covers both), and drop the handle from this.bots so the
	// think/respawn/fall-death/scoreboard loops stop seeing it. Anything that still
	// holds its nid (in-flight projectile/grenade ownerNid) already null-guards its
	// `this.bots.find(...)` lookup, so a retired attacker just becomes unattributed.
	removeBot(handle) {
		const i = this.bots.indexOf(handle)
		if (i === -1) return
		this.bots.splice(i, 1)
		if (handle.rawEntity) {
			const nid = handle.rawEntity.nid // removeEntity reclaims the nid (-1 after)
			if (handle.rawEntity.mesh) handle.rawEntity.mesh.dispose()
			this.instance.removeEntity(handle.rawEntity)
			console.log(`Bot ${nid} retired (auto-fill)`)
		}
	}

	// AUTO-FILL rebalance: keep humans + fill bots == BOT_FILL target. Called at boot
	// and on every human connect/disconnect. No-ops in legacy fixed-BOTS mode
	// (_botFillTarget 0 there AND no BOT_FILL path ever runs — see the constructor).
	// FragBench agent bots are sanctioned external players, NOT filler: they count
	// toward the headcount like humans and are never retired here.
	_rebalanceBots() {
		if (process.env.BOTS !== undefined) return // legacy fixed-count mode
		const fillBots = this.bots.filter(b => !b.agent)
		const nonFill = this._humanCount + (this.bots.length - fillBots.length)
		// humans (+agents) alone can exceed the target: desired clamps at 0, never below.
		const desired = Math.max(0, this._botFillTarget - nonFill)
		for (let i = fillBots.length; i < desired; i++) this.addBot(i)
		for (let i = fillBots.length; i > desired; i--) {
			// prefer retiring a DEAD bot (invisible exit — nobody sees a fighter vanish
			// mid-duel), else the lowest-scoring one (least disturbance to the match).
			const pick = fillBots
				.sort((a, b) => (a.rawEntity.isAlive - b.rawEntity.isAlive)
					|| ((a.rawEntity.kills | 0) - (b.rawEntity.kills | 0)))
				.shift()
			this.removeBot(pick)
		}
	}

	// FRAGBENCH v0: an agent bot is a regular bot handle whose controller accepts
	// external strategist intent (AgentBotController). It lives in this.bots so every
	// existing path — think loop, respawn, teams, match scoring — treats it identically.
	addAgentBot(label) {
		const entity = new PlayerCharacter()
		entity.mesh.checkCollisions = true
		entity.teamId = this.assignTeam()
		const spawn = this.spawnPoint(entity.teamId)
		entity.x = spawn.x
		entity.y = spawn.y || 0
		entity.z = spawn.z
		// same contract as addBot: agents own the full arsenal (they can't reach
		// pickups reliably in v0 — pickup routing is a deferred intent verb)
		entity.currentWeaponIndex = 0
		entity.ownedWeapons = PlayerCharacter.ALL_WEAPONS
		entity.weaponsState.forEach((state, i) => {
			state.magazineAmmo = weapons[i].magazineCapacity
			state.reserveAmmo = weapons[i].maxReserveAmmo
		})
		entity.nameIndex = this._nameCounter++ % PLAYER_NAMES.length
		this.instance.addEntity(entity)
		const handle = { bot: true, agent: true, rawEntity: entity, smoothEntity: entity, respawnAt: null }
		handle.controller = new AgentBotController(entity, entity.currentWeaponIndex)
		handle.controller.agentLabel = label
		entity.client = handle
		this.bots.push(handle)
		console.log(`[fragbench] agent "${label}" joined as nid ${entity.nid}`)
		return handle
	}

	removeAgentBot(handle) {
		const i = this.bots.indexOf(handle)
		if (i === -1) return
		this.bots.splice(i, 1)
		this.instance.removeEntity(handle.rawEntity)
		console.log(`[fragbench] agent "${handle.controller.agentLabel}" left (nid ${handle.rawEntity.nid})`)
	}

	// every living entity `except` could fight: human raw entities + bots
	combatants(except) {
		const out = []
		this.instance.clients.forEach(client => {
			const e = client.rawEntity
			if (e && e.isAlive && e !== except) out.push(e)
		})
		this.bots.forEach(bot => {
			if (bot.rawEntity.isAlive && bot.rawEntity !== except) out.push(bot.rawEntity)
		})
		return out
	}

	// a fresh spawn location: spread out from the origin so players never spawn
	// inside each other's collision boxes (moveWithCollisions can't escape from
	// inside a collider), and clear of the obstacle ring
	// Load the artist OBJ into the scene as collision geometry (server-authoritative).
	// Reads the file from disk and imports via a data URL (node has no static file
	// server; xhr2 is already polyfilled at the top). Strips mtllib — collision needs
	// geometry only. Proven headless by scripts/verify-meshmap.ts.
	async _loadMapMesh(scene) {
		try {
			const fs = require('fs')
			// Babylon 9's OBJ loader default-mirrors X vs 4.0.3 (USE_LEGACY_BEHAVIOR now
			// defaults false); all spawn/killY/light data is calibrated on the legacy
			// orientation, so keep legacy on BOTH sides (client sets it too). NOTE: the
			// class lives on the loaders module, NOT the BABYLON namespace, under tsx.
			OBJFileLoader.USE_LEGACY_BEHAVIOR = true
			const obj = fs.readFileSync('public' + this.map.dir + this.map.file, 'utf8').replace(/^mtllib.*$/gm, '')
			// PERF: the OBJ is handed to babylon as a data URL. Babylon tests the string
			// against /^data:([^,]+\/[^,]+)?;base64,/ to detect base64. CTF-Visage's OBJ has
			// NO comma in 431KB, so [^,]+ spans the whole file and the regex backtracks over
			// all ~24k '/' in the face lines — 93% of load time, 7.4s. An empty media type
			// followed by a comma ('data:,') is a valid data URL that caps the backtrack at
			// byte 5: Visage load 7433ms -> 45ms (165x), geometry BIT-IDENTICAL (verified).
			const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', 'data:,' + obj, scene, null, '.obj')
			// upright the Z-up OBJ (rotate the whole map about X), then bake world matrices
			// so collision uses the rotated geometry — MUST match the client (mapMesh.js).
			const root = new BABYLON.TransformNode('mapRoot', scene)
			res.meshes.forEach(m => { if (!m.parent) m.parent = root })
			root.rotation.x = this.map.rotationX || 0
			root.scaling.setAll(this.map.scale || 1)
			root.computeWorldMatrix(true)
			let n = 0
			const colliders = []
			res.meshes.forEach(m => {
				if (m.getTotalVertices && m.getTotalVertices() > 0) {
					m.computeWorldMatrix(true)
					// PERF: subdivide the MOVEMENT colliders into ~12-triangle submeshes, exactly
					// like the hitscan occluders below. The OBJ groups faces by MATERIAL, so one
					// "mesh" (e.g. the whole floor) can span the entire map — its single bounding
					// volume culls nothing, so moveWithCollisions tests every player against all of
					// its triangles EVERY tick (~1ms+/player). babylon's per-submesh AABB cull
					// (SubMesh.canIntersects) then bites: measured 16-player tick collision from
					// ~79% to ~7.6% of the 25ms budget. Subdivided IN PLACE: the server is headless
					// (no shadow/light bake here — that is client-side, HTTP-loaded), so only the
					// collision path reads these meshes, and in-place shares the VertexBuffers (no
					// geometry clone, ~2.5MB of SubMesh objects for the whole map). Bit-identical to
					// the whole mesh on trajectories (same triangles, nearest hit wins) — verified
					// 8 players x 300 ticks @ 0.000000mm and golden-collision clean.
					const parts = Math.max(1, Math.ceil((m.getTotalIndices() / 3) / 12))
					if (parts > 1) m.subdivide(parts)
					if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
					m.checkCollisions = true
					colliders.push(m)
					n++
				}
			})
			// Hitscan OCCLUDERS (server/lagCompensatedHitscanCheck.js). The raw OBJ groups
			// faces by MATERIAL, so one "mesh" can span the entire map — its bounding volume
			// tells a ray nothing, half of them enclose the shooter, and every pellet ends up
			// testing all ~6900 triangles (measured 227us/pellet on CTF-Visage). Subdividing
			// into ~12-triangle submeshes gives babylon's per-submesh bounding-box cull
			// (AbstractMesh.intersects -> subMesh.canIntersects) something to bite on and takes
			// that to ~34us/pellet — 6.7x, ~270us for a worst-case 8-pellet shotgun blast.
			// MEASURED, not assumed: a per-mesh submesh octree (createOrUpdateSubmeshesOctree,
			// available via @babylonjs/core/Culling/Octrees) on top of this is worth only ~4%
			// here — too few submeshes per mesh to pay for itself — so we do not build one.
			//
			// These are CLONES: babylon clones SHARE the source geometry (no vertex data is
			// duplicated) but carry their own submesh list, and they are left disabled with
			// checkCollisions off. So the movement collision path still runs against the
			// un-subdivided meshes above, exactly as it did before this change.
			const occluders = []
			colliders.forEach((m, i) => {
				const c = m.clone('occluder_' + i, null)
				c.parent = m.parent
				c.computeWorldMatrix(true)
				const parts = Math.max(1, Math.ceil((c.getTotalIndices() / 3) / 12))
				if (parts > 1) c.subdivide(parts)
				if (c.refreshBoundingInfo) c.refreshBoundingInfo(true)
				c.checkCollisions = false
				c.isPickable = false
				c.setEnabled(false)
				occluders.push(c)
			})
			// publish only once every world matrix / bounding volume above is baked, so a
			// concurrent shot never sees a half-built collider
			this.occluderMeshes = occluders
			// Size the network view box to the real geometry now that it is loaded. This
			// runs off the un-subdivided COLLIDERS (not the occluder clones) and only
			// reads vertex data, so it disturbs nothing above.
			const derived = this.deriveViewBox(colliders)
			if (derived) this.viewBox = derived
			const vb = this.viewBox
			console.log(`[view] box centre(${vb.x.toFixed(2)}, ${vb.y.toFixed(2)}, ${vb.z.toFixed(2)}) `
				+ `half(${vb.halfWidth.toFixed(2)}, ${vb.halfHeight.toFixed(2)}, ${vb.halfDepth.toFixed(2)})`)
			this.mapReady = true
			console.log(`[map] mesh collider loaded: ${n} meshes (${this.map.file})`)

			// UT-STYLE PICKUPS: now that occluderMeshes is published, drop-probe the
			// registry PICKUPS onto the floor and spawn a Pickup entity per surviving item.
			// Runs AFTER the mesh is ready so every probe tests real geometry.
			this.pickups = setupPickups(this).created
		} catch (e) { console.error('[map] mesh load FAILED:', e) }
	}

	// diagnostic: stamp spawn pos/time on the raw entity so fall-death can report how
	// long after spawn (and from where) a player fell.
	_recordSpawn(raw) {
		if (!raw) return
		raw._spawnT = Date.now()
		raw._spawnPos = { x: raw.x, y: raw.y, z: raw.z }
		raw._minY = raw.y
		raw._everGrounded = false
		if (this.useMeshMap) console.log(`[spawn] nid=${raw.nid} @(${raw.x.toFixed(1)},${raw.y.toFixed(1)},${raw.z.toFixed(1)})`)
	}

	// Cast a ray straight DOWN through the collision mesh from `worldY`+up and return the
	// floor's world y under (x,z), or null if there is no floor in the probe window.
	// Reuses the hitscan occluder meshes — the same query setupPickups uses.
	_dropProbeY(x, worldY, z, up = SPAWN_PROBE_UP, down = SPAWN_PROBE_DOWN) {
		const meshes = this.occluderMeshes
		if (!meshes || meshes.length === 0) return null
		const origin = new BABYLON.Vector3(x, worldY + up, z)
		const ray = new BABYLON.Ray(origin, new BABYLON.Vector3(0, -1, 0), up + down)
		const dist = nearestWorldHit(meshes, ray, up + down)
		return Number.isFinite(dist) ? origin.y - dist : null
	}

	spawnPoint(teamId = null) {
		if (this.useMeshMap) {
			const sc = this.map.scale || 1
			// Prefer the UT-extracted SPAWN_POINTS (20, team-tagged, yaw, headroom) on the
			// enriched record; drop low-headroom entries and drop-probe each to the floor.
			// Fall back to the legacy `spawns` list for any map without SPAWN_POINTS.
			const pts = this.map.SPAWN_POINTS
			if (Array.isArray(pts) && pts.length) {
				const usable = pts.filter(p => p.headroom === undefined || p.headroom >= SPAWN_MIN_HEADROOM)
				let pool = usable.length ? usable : pts
				// TDM: spawn on the requesting team's own points. If a team has NONE (a map
				// with untagged spawns), fall back to the full pool rather than failing.
				if (teamId !== null) {
					const teamPool = pool.filter(p => p.team === teamId)
					if (teamPool.length) pool = teamPool
				}
				const p = pool[Math.floor(Math.random() * pool.length)]
				const wx = p.x * sc + (Math.random() - 0.5) * 1.2
				const wz = p.z * sc + (Math.random() - 0.5) * 1.2
				const floorY = this._dropProbeY(wx, p.y * sc, wz)
				// on a probe miss, fall back to the native y (never worse than the legacy
				// behaviour, which used the native y verbatim)
				const wy = floorY != null ? floorY + SPAWN_REST : p.y * sc
				return { x: wx, y: wy, z: wz, yaw: p.yaw }
			}
			// legacy fallback: pick a floor spawn; small XZ jitter; y a hair above the floor.
			const s = this.map.spawns[Math.floor(Math.random() * this.map.spawns.length)]
			return { x: s.x * sc + (Math.random() - 0.5) * 1.2, z: s.z * sc + (Math.random() - 0.5) * 1.2, y: s.y * sc }
		}
		// Spawn at one of the two tower bases (Facing Worlds). Random pick among the
		// symmetric SPAWN_POINTS with a small jitter so two players picking the same
		// point don't spawn inside each other's collider. Server-side only (not the
		// deterministic movement path), so Math.random is fine here.
		// TDM: if the box arena's spawns carry team tags, honour them; otherwise use all.
		let boxPool = SPAWN_POINTS
		if (teamId !== null) {
			const teamPool = SPAWN_POINTS.filter(p => p.team === teamId)
			if (teamPool.length) boxPool = teamPool
		}
		const p = boxPool[Math.floor(Math.random() * boxPool.length)]
		return { x: p.x + (Math.random() - 0.5) * 2, z: p.z + (Math.random() - 0.5) * 2, y: 0 }
	}

	// WORLD position of the mega-health pickup. Mesh maps read this.map.mega (native
	// units, like spawns/killY) and add MEGA.Y as the bob height above that floor
	// point; box arenas keep their MEGA.X/Y/Z placement over the y=0 floor plane. A
	// mesh map with no `mega` entry falls back to the box position and warns rather
	// than silently parking the pickup somewhere unreachable — which is the bug this
	// whole method exists to kill.
	megaSpawnPos() {
		if (this.useMeshMap) {
			if (this.map.mega) {
				const sc = this.map.scale || 1
				return {
					x: this.map.mega.x * sc,
					y: this.map.mega.y * sc + MEGA.Y,
					z: this.map.mega.z * sc
				}
			}
			console.warn(`[mega] ${this.map.file} has no 'mega' entry in common/mapMesh.js — `
				+ `falling back to the box-arena position (${MEGA.X}, ${MEGA.Y}, ${MEGA.Z}), `
				+ `which is almost certainly not on this map's floor.`)
		}
		return { x: MEGA.X, y: MEGA.Y, z: MEGA.Z }
	}

	// ---- network view box -------------------------------------------------------
	// nengi culls entities against a per-client AABB (node_modules/nengi/core/instance/
	// BasicSpace.js, queryAreaEMap3D — a strict min/max test on all three axes with
	// DIMENSIONALITY 3). An entity outside a client's box is simply never inserted into
	// that client's view: no model, no nametag, no corpse. It is deliberately NOT
	// re-centred on the player (nengi has no 3D view culler yet), so it must be a fixed
	// box that covers the whole playable world.
	//
	// It used to be a symmetric ±64 cube AT THE ORIGIN, sized for a 44-unit box arena.
	// On CTF-Visage that hard-culls real play space: the walkable floor runs to world
	// x = +102.18, so ~39% of it — and 2 of the 8 spawn points (x 69.23 and 78.78) —
	// sat outside the box. A player there was invisible to everyone else while still
	// able to shoot them (hitscan uses its own ±999999 area), which reads as a ghost.
	//
	// The box is now sized to the MAP: per-axis half-extents around the map's own
	// centre, not the origin. nengi's aabb carries its own x/y/z centre and separate
	// halfWidth/halfHeight/halfDepth, so an asymmetric off-origin box costs nothing —
	// and it matters here, because Visage's walkable z spans only ~52m against ~138m
	// of x. MEASURED on CTF-Visage: the derived box is centre(33.39, -20.47, -1.49)
	// half(84.79, 52.61, 41.84) = 1.49e6 m3, and it holds 2126/2126 walkable-floor
	// sample points vs 1190/2126 (56.0%) for the old ±64 cube. A symmetric
	// origin-centred cube covering the same world would need ±118 = 13.20e6 m3, i.e.
	// 8.8x the volume for no gain.
	//
	// Fallback used only for the ~1s async mesh load at boot (nobody has connected
	// yet). Mesh maps declare `walkable` in common/mapMesh.js; _loadMapMesh replaces
	// this with the real thing derived from the mesh as soon as the OBJ is in.
	defaultViewBox() {
		if (this.useMeshMap && this.map.walkable) {
			const sc = this.map.scale || 1
			const w = this.map.walkable
			return this.viewBoxFrom(
				{ x: w.minX * sc, y: w.minY * sc, z: w.minZ * sc },
				{ x: w.maxX * sc, y: w.maxY * sc, z: w.maxZ * sc }
			)
		}
		// box arena: the old ±64 origin cube, which scripts/verify-map.ts asserts every
		// box map fits inside. Unchanged on purpose.
		return { x: 0, y: 0, z: 0, halfWidth: 64, halfHeight: 64, halfDepth: 64 }
	}

	// Turn a world-space min/max into a nengi aabb, union'd with everything else that
	// must be replicated: the spawn points (authoritative positions — if one ever sat
	// outside the floor AABB the box must still cover it) and the kill plane (players
	// falling to their death stay visible until the server kills them at this.killY).
	viewBoxFrom(min, max) {
		const sc = this.map.scale || 1
		if (this.useMeshMap) {
			for (const s of this.map.spawns) {
				min.x = Math.min(min.x, s.x * sc); max.x = Math.max(max.x, s.x * sc)
				min.y = Math.min(min.y, s.y * sc); max.y = Math.max(max.y, s.y * sc)
				min.z = Math.min(min.z, s.z * sc); max.z = Math.max(max.z, s.z * sc)
			}
			min.y = Math.min(min.y, this.killY * sc)
		}
		const m = VIEW_MARGIN
		return {
			x: (min.x + max.x) / 2,
			y: (min.y + max.y) / 2,
			z: (min.z + max.z) / 2,
			halfWidth: (max.x - min.x) / 2 + m,
			halfHeight: (max.y - min.y) / 2 + m,
			halfDepth: (max.z - min.z) / 2 + m
		}
	}

	// Walkable-floor AABB straight off the loaded mesh: sweep every collider triangle
	// in WORLD space and keep the near-horizontal ones. Deriving this (rather than
	// hardcoding another number) is what makes the view box correct for the next map
	// without anyone having to remember to measure it.
	//
	// The test is on |n.y|, NOT n.y, on purpose: OBJ winding is not consistent across
	// our maps — DM-W-Grove's floors come out with n.y = -1.000 while CTF-Visage's
	// come out +1 — and the horizontal extent is IDENTICAL under either convention
	// (measured on both maps), so being sign-agnostic buys correctness on inverted
	// maps for free and avoids having to guess a per-map winding.
	deriveViewBox(colliders) {
		const min = { x: Infinity, y: Infinity, z: Infinity }
		const max = { x: -Infinity, y: -Infinity, z: -Infinity }
		const a = new BABYLON.Vector3(), b = new BABYLON.Vector3(), c = new BABYLON.Vector3()
		const v = new BABYLON.Vector3()
		let tris = 0
		for (const m of colliders) {
			const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
			const idx = m.getIndices()
			if (!pos || !idx) continue
			const wm = m.getWorldMatrix()
			const get = (i, out) => {
				v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
				BABYLON.Vector3.TransformCoordinatesToRef(v, wm, out)
			}
			for (let i = 0; i < idx.length; i += 3) {
				get(idx[i], a); get(idx[i + 1], b); get(idx[i + 2], c)
				const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
				const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
				const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
				const len = Math.hypot(nx, ny, nz)
				if (len < 1e-9 || Math.abs(ny / len) < 0.7) continue
				tris++
				for (const p of [a, b, c]) {
					if (p.x < min.x) min.x = p.x; if (p.x > max.x) max.x = p.x
					if (p.y < min.y) min.y = p.y; if (p.y > max.y) max.y = p.y
					if (p.z < min.z) min.z = p.z; if (p.z > max.z) max.z = p.z
				}
			}
		}
		if (!tris) {
			console.warn('[view] no walkable triangles found in the map mesh — keeping the declared view box')
			return null
		}
		console.log(`[view] walkable floor from ${tris} tris: `
			+ `x[${min.x.toFixed(2)}..${max.x.toFixed(2)}] y[${min.y.toFixed(2)}..${max.y.toFixed(2)}] `
			+ `z[${min.z.toFixed(2)}..${max.z.toFixed(2)}]`)
		return this.viewBoxFrom(min, max)
	}

	// PROOF OF BLOOD name resolution — the ledger keys balances by a stable display
	// name: humans by their callsign (_humanNames, keyed by smooth nid; fallback
	// PLAYER-<nid> if they never sent one), bots by their roster name, FragBench
	// agents by 'agent:<label>' so benchmark earnings stay attributable per model.
	_bloodName(client) {
		if (!client || !client.smoothEntity) return null
		if (client.bot) {
			if (client.agent && client.controller && client.controller.agentLabel) {
				return 'agent:' + client.controller.agentLabel
			}
			const name = PLAYER_NAMES[client.smoothEntity.nameIndex]
			return name || ('PLAYER-' + client.smoothEntity.nid)
		}
		return this._humanNames.get(client.smoothEntity.nid) || ('PLAYER-' + client.smoothEntity.nid)
	}

	// Canonical damage: a player's authoritative hitpoints live on the CLIENT's
	// pair of entities and must move in lockstep — the victim reads their own
	// rawEntity (private channel), everyone else reads the smoothEntity. Applying
	// damage to whichever entity a ray happened to hit desyncs the two views.
	damagePlayer(victimClient, attackerClient, damage, sourceName, weaponIndex, zone = null) {
		const raw = victimClient.rawEntity
		const smooth = victimClient.smoothEntity
		if (!raw || !raw.isAlive) return
		// CEASEFIRE during the MATCH_END intermission: the winner banner + final scores
		// are a protected moment — no damage lands (hitscan, projectile, grenade splash
		// alike), so nobody dies "behind" the DEFEAT card and the final score is final.
		// Fall deaths stay live (they bypass damagePlayer) — walking off the deck during
		// the intermission is still on you.
		if (this.matchPhase === MATCH_PHASE.MATCH_END) return
		// GODMODE: real players take no damage (bots still do — go frag them)
		if (this._godmode && !victimClient.bot) return

		// TDM FRIENDLY FIRE (off by default): a shot on a TEAMMATE deals 0 damage, no
		// kill, no score. Self-damage (own grenade splash) is preserved — only a
		// DISTINCT same-team attacker is blocked (attacker/victim are handles here).
		// FFA has no teams: everyone can damage everyone, so this block is skipped.
		if (this.gameMode !== GAME_MODE.FFA && !FRIENDLY_FIRE && attackerClient && attackerClient !== victimClient
			&& attackerClient.rawEntity && raw.teamId === attackerClient.rawEntity.teamId) {
			return
		}

		// BODY-ZONE multiplier — AUTHORITATIVE, applied HERE (outside the reconciled
		// applyCommand path), never on the predicted client path. `zone` is the server-
		// classified head/torso/legs from lagCompensatedHitscanCheck; it is null for
		// non-hitscan damage (projectiles, grenades, fall deaths) which take NO zone
		// scaling (v1 is hitscan-only). The client NEVER asserts a zone — the whole path
		// is rebuilt server-side from movement/aim input. Per-weapon zoneMultipliers with
		// a global default (common/weaponsConfig.js). Rounded after scaling so the wire
		// damage (UInt8) matches the hitpoints actually deducted.
		const wcfg = weapons[weaponIndex]
		const zmults = (wcfg && wcfg.zoneMultipliers) ? wcfg.zoneMultipliers : DEFAULT_ZONE_MULTIPLIERS
		const zmult = zone ? (zmults[zone] != null ? zmults[zone] : 1) : 1
		const isHeadshot = zone === 'head'
		if (zmult !== 1) damage = Math.round(damage * zmult)
		// Headshot COUNTER — a server-side hook for future token issuance (damage is
		// authoritative and will later gate tokens). Counted at the authoritative branch,
		// never trusting the client. (timeAgo = latency+100 in performShot is the one
		// client-influenced lever — a client inflating its reported latency widens its
		// rewind window; NOT fixed here, flagged for a later hardening pass.)
		if (isHeadshot) {
			this._headshots = (this._headshots || 0) + 1
			if (attackerClient && attackerClient.rawEntity) {
				attackerClient._headshots = (attackerClient._headshots || 0) + 1
			}
		}

		// UDAMAGE — while the ATTACKER's powerup timer is live, DOUBLE the outgoing damage
		// (UDAMAGE_MULT), applied AFTER the zone multiplier so it STACKS with headshots
		// (that is UT behaviour — flagged for tuning). Rounded so the wire damage matches
		// the hitpoints actually deducted. Self-damage (own splash) also doubles, matching UT.
		const atkRaw = attackerClient && attackerClient.rawEntity
		if (atkRaw && atkRaw.udamageTimer > 0) damage = Math.round(damage * UDAMAGE_MULT)

		// ARMOR — classic Quake green-armor split. The armor soaks ARMOR_ABSORB of the
		// (already zone/UDamage-scaled) hit until depleted; the remainder passes to hp. We
		// reduce `damage` IN PLACE to the net hp damage so hpBefore/overkill/wire-damage all
		// reflect what actually hit health. Server-authoritative; armor lockstep raw+smooth.
		if (raw.armor > 0 && damage > 0) {
			const absorbed = Math.min(raw.armor, Math.floor(damage * ARMOR_ABSORB))
			raw.armor -= absorbed
			smooth.armor = raw.armor
			damage -= absorbed
		}

		// hp BEFORE this hit — overkill is damage beyond what the kill needed
		const hpBefore = raw.hitpoints
		const hp = Math.max(0, hpBefore - damage)
		raw.hitpoints = hp
		smooth.hitpoints = hp
		const wasKill = hp <= 0
		console.log(`Player ${raw.nid} hit by ${sourceName}! HP: ${hp}`)

		// combat events use SMOOTH nids — the canonical identity every client shares
		// (each client learns its own raw+smooth pair via Identity; bots share one
		// entity). attackerClient may be null or a socketless bot handle.
		const victimNid = smooth.nid
		const isRealAttacker = attackerClient && !attackerClient.bot && attackerClient.smoothEntity
		const attackerNid = attackerClient && attackerClient.smoothEntity ? attackerClient.smoothEntity.nid : victimNid

		// DamageTaken → the victim only (skip bots: no socket). directionYaw points
		// from the victim toward the attacker so the client can draw a directional arc.
		if (!victimClient.bot) {
			let dirYaw = 0
			if (attackerClient && attackerClient.smoothEntity) {
				const src = attackerClient.smoothEntity
				dirYaw = Math.atan2(src.x - smooth.x, src.z - smooth.z)
			}
			this.instance.message(new DamageTaken(attackerNid, Math.min(255, damage), dirYaw), victimClient)
		}

		// HitConfirmed → the attacker only (real clients; bots have no socket)
		if (isRealAttacker) {
			this.instance.message(new HitConfirmed(victimNid, Math.min(255, damage), wasKill, isHeadshot), attackerClient)
		}

		if (wasKill) {
			raw.isAlive = false
			smooth.isAlive = false
			// freeze the corpse where it dropped (applyCommand ignores dead players
			// on both sides, so client prediction stays in sync through death)
			raw.velX = 0; raw.velY = 0; raw.velZ = 0
			raw.deaths = Math.min(255, raw.deaths + 1)
			smooth.deaths = raw.deaths
			victimClient.respawnAt = Date.now() + GameInstance.RESPAWN_DELAY_MS
			// A frag is only credited for killing SOMEONE ELSE. A self-kill (own grenade
			// splash where attacker === victim) never increments the killer's kills — this
			// keeps the kills stat honest AND lets FFA use kills directly as the frag score
			// (a suicide must not read as +1 frag). deaths still increments above.
			if (attackerClient && attackerClient !== victimClient && attackerClient.rawEntity) {
				const ak = Math.min(255, attackerClient.rawEntity.kills + 1)
				attackerClient.rawEntity.kills = ak
				attackerClient.smoothEntity.kills = ak
				// PROOF OF BLOOD: every credited frag is 100 hashpower toward the
				// current block (same self-kill gate as the kills stat — a suicide
				// mines nothing). Objective hashes (CTF/DOM) wire in when those
				// modes exist; only DM/TDM/FFA are live today, so kills-only is v0.
				const killerName = this._bloodName(attackerClient)
				if (killerName) this.bloodLedger.recordHash(killerName, 100, 'kill')
			}

			// Mode-aware frag scoring (TDM team score / FFA individual). Also drives the
			// frag-cap early-end and the SUDDEN_DEATH first-frag decision.
			this.scoreKill(attackerClient, victimClient)

			// Killed → broadcast to EVERYONE via instance.messageAll. (addLocalMessage
			// is NOT usable here: nengi local events are spatially culled and REQUIRE
			// x/y in their schema — Killed carries none — and they decode through the
			// localMessages protocol map, not `messages`, so an addLocalMessage(Killed)
			// silently never reaches any client. messageAll uses the same per-client
			// message path HitConfirmed/DamageTaken already work through, delivered to
			// every connected socket.) overkill = damage past what the kill needed. If
			// there's no attacker, killerNid = victimNid (suicide-style, unattributed).
			const overkill = Math.min(255, Math.max(0, damage - hpBefore))
			this.instance.messageAll(new Killed(attackerNid, victimNid, weaponIndex || 0, overkill, isHeadshot))

			// DROP-ON-DEATH: scatter the victim's owned non-pistol weapons (carrying their
			// current ammo) at the death location. Armor is lost on death (not dropped).
			const nDropped = this.dropWeaponsOnDeath(raw, Date.now())

			console.log(`Player ${raw.nid} died from ${sourceName}! (dropped ${nDropped} weapon${nDropped === 1 ? '' : 's'})`)
		}
	}

	// UT99-style respawn: full health, fresh ammo for every weapon (same weapon
	// still equipped), at a new spawn point. The client learns the teleport via
	// reconciliation (its dead entity predicted staying put, the server says
	// spawn point → snap) and mirrors the ammo reset when it observes its own
	// isAlive flip back to true (Simulator._updateHud).
	respawnPlayer(client) {
		// TDM: respawn on the player's OWN team spawns; teamId persists across death
		// (never reset here), so a respawn keeps the same team.
		const teamId = client.rawEntity ? client.rawEntity.teamId : null
		const spawn = this.spawnPoint(teamId)
		for (const entity of [client.rawEntity, client.smoothEntity]) {
			if (!entity) continue
			entity.x = spawn.x
			entity.y = spawn.y || 0
			entity.z = spawn.z
			entity.hitpoints = 100
			entity.isAlive = true
			// UT-STYLE: armor + UDamage are LOST on death — a fresh spawn has neither.
			entity.armor = 0
			entity.udamageTimer = 0
			entity.velX = 0; entity.velY = 0; entity.velZ = 0
			if (entity === client.rawEntity) this._recordSpawn(entity)
			// Phase 4: clear any pending overheal decay so a respawn is a clean 100
			entity.overhealDecayTimer = 0
			// Phase 3: refresh grenades to full on respawn (mirrors the ammo reset)
			entity.grenadeCharges = GRENADE.MAX_CHARGES
			entity.throwCooldown = 0
			entity.rechargeAccum = 0
			// UT-STYLE OWNERSHIP RESET (v1): a respawn returns the player to pistol-only
			// (+ pistol ammo); every other weapon reverts to unowned with ZERO ammo. Bots
			// keep the full arsenal so they still fight (they never pick weapons up).
			const spawnOwned = client.bot ? PlayerCharacter.ALL_WEAPONS : PlayerCharacter.PISTOL_ONLY
			entity.ownedWeapons = spawnOwned
			entity.weaponsState.forEach((state, i) => {
				const owned = (spawnOwned & (1 << i)) !== 0
				state.magazineAmmo = owned ? weapons[i].magazineCapacity : 0
				state.reserveAmmo = owned ? weapons[i].maxReserveAmmo : 0
				state.cooldownTimer = 0
				state.onCooldown = false
				state.reloading = false
				state.reloadTimer = 0
				state.heat = 0
			})
			// a respawn always re-equips the pistol so a human never spawns holding a
			// weapon they no longer own (which fire()/switch would then refuse).
			if (!client.bot) entity.currentWeaponIndex = SPAWN_WEAPON_INDEX
		}
		// the client ignores server x/y/z for its own entity (it predicts them),
		// so hand the teleport over explicitly — same contract as Identity's spawn.
		// Bots have no socket to message; the server-side teleport IS their move.
		// spawn.y goes on the wire now — the client used to assume 0 (box-arena floor)
		// and fell ~24m out of the sky on every respawn on a mesh map.
		if (!client.bot) this.instance.message(new Respawned(spawn.x, spawn.y || 0, spawn.z), client)
		console.log(`${client.bot ? 'Bot' : 'Player'} ${client.rawEntity.nid} respawned at (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`)
	}

	// ---- TDM team/match helpers -------------------------------------------------

	// Head count per team across EVERY player (humans + bots), each counted once.
	countTeams() {
		const n = [0, 0]
		this.instance.clients.forEach(c => { if (c.rawEntity && (c.rawEntity.teamId === 0 || c.rawEntity.teamId === 1)) n[c.rawEntity.teamId]++ })
		this.bots.forEach(b => { if (b.rawEntity && (b.rawEntity.teamId === 0 || b.rawEntity.teamId === 1)) n[b.rawEntity.teamId]++ })
		return n
	}

	// Auto-balance: the team with fewer players; a tie goes to team 0. Counts the
	// EXISTING roster (the new player is assigned this result, then added).
	assignTeam() {
		const n = this.countTeams()
		return n[0] <= n[1] ? 0 : 1
	}

	// ---- Scoring (mode-aware) ---------------------------------------------------
	// Scores only mutate while the match is LIVE (ACTIVE or SUDDEN_DEATH); they freeze
	// through the MATCH_END intermission.
	_scoringLive() {
		return this.matchPhase === MATCH_PHASE.ACTIVE || this.matchPhase === MATCH_PHASE.SUDDEN_DEATH
	}

	// Raw team-score mutation (no phase gate, no cap check — callers gate via scoreKill/
	// scoreSelfKill and the cap is checked in _afterScore). May go negative on a suicide.
	_addTeamScore(team, delta) {
		if (team !== 0 && team !== 1) return
		this.teamScore[team] += delta
	}

	// Every player's frag score in FFA (== networked kills), sorted DESC. Humans + bots,
	// each once. Used for tie-checks, the leader, and the cap.
	_ffaScores() {
		const arr = []
		this.instance.clients.forEach(c => { if (c.rawEntity) arr.push(c.rawEntity.kills | 0) })
		this.bots.forEach(b => { if (b.rawEntity) arr.push(b.rawEntity.kills | 0) })
		arr.sort((a, b) => b - a)
		return arr
	}

	// EXACTLY tied at the top? TDM: the two team scores equal. FFA: the top-TWO players
	// tied (spec). With <2 players there is no top-two tie (the lone leader stands).
	scoresTied() {
		if (this.gameMode === GAME_MODE.FFA) {
			const s = this._ffaScores()
			return s.length >= 2 && s[0] === s[1]
		}
		return this.teamScore[0] === this.teamScore[1]
	}

	// The leading score (TDM: higher team; FFA: top player). Drives the cap check.
	leaderScore() {
		if (this.gameMode === GAME_MODE.FFA) {
			const s = this._ffaScores()
			return s.length ? s[0] : 0
		}
		return Math.max(this.teamScore[0], this.teamScore[1])
	}

	// Post-score bookkeeping: in SUDDEN_DEATH the first frag / lead change (any break of
	// the tie) decides the match; in ACTIVE the frag cap ends it early the moment it's hit.
	_afterScore() {
		if (this.matchPhase === MATCH_PHASE.SUDDEN_DEATH) {
			if (!this.scoresTied()) this.endMatch()
			return
		}
		if (this.matchPhase === MATCH_PHASE.ACTIVE) {
			if (this.leaderScore() >= FRAG_LIMIT) this.endMatch()
		}
	}

	// A kill by `attackerClient` on `victimClient`. TDM: +1 to the attacker's team on an
	// enemy kill, else -1 to the victim's own team. FFA: the frag score IS the attacker's
	// networked kills (already incremented in the kill branch for a genuine enemy frag), so
	// there is nothing to add — just run the cap / sudden-death check.
	scoreKill(attackerClient, victimClient) {
		if (!this._scoringLive()) return
		if (this.gameMode === GAME_MODE.FFA) {
			// FFA score == kills (already applied). No suicide penalty in v1, so the server's
			// winner (max kills) matches the client leaderboard exactly.
		} else {
			const raw = victimClient.rawEntity
			const enemyKill = attackerClient && attackerClient !== victimClient
				&& attackerClient.rawEntity && attackerClient.rawEntity.teamId !== raw.teamId
			if (enemyKill) this._addTeamScore(attackerClient.rawEntity.teamId, +1)
			else this._addTeamScore(raw.teamId, -1)
		}
		this._afterScore()
	}

	// An unattributed / self death (void fall, own grenade). TDM: -1 to the victim's own
	// team. FFA: no score change (kills is untouched). May decide a TDM sudden-death lead.
	scoreSelfKill(raw) {
		if (!this._scoringLive()) return
		if (this.gameMode !== GAME_MODE.FFA) this._addTeamScore(raw.teamId, -1)
		this._afterScore()
	}

	// ACTIVE/SUDDEN_DEATH -> MATCH_END. Winner = higher team (TDM); FFA winner is an
	// INDIVIDUAL — the client derives its own victory/defeat from the authoritative
	// per-player kills, so `winner` stays DRAW (unused) in FFA. Scores freeze until reset.
	endMatch() {
		if (!this._scoringLive()) return
		this.matchPhase = MATCH_PHASE.MATCH_END
		this.matchEndAt = Date.now()
		if (this.gameMode === GAME_MODE.FFA) {
			this.matchWinner = MATCH_WINNER.DRAW // unused in FFA (individual winner)
		} else if (this.teamScore[0] > this.teamScore[1]) this.matchWinner = MATCH_WINNER.TEAM0
		else if (this.teamScore[1] > this.teamScore[0]) this.matchWinner = MATCH_WINNER.TEAM1
		else this.matchWinner = MATCH_WINNER.DRAW
		this._matchPublishAt = 0 // force an immediate publish of the end state
		const score = this.gameMode === GAME_MODE.FFA
			? `top=${this.leaderScore()}` : `${this.teamScore[0]}-${this.teamScore[1]}`
		console.log(`[match] MATCH_END winner=${this.matchWinner} ${score}`)
	}

	// ACTIVE -> SUDDEN_DEATH. Entered when scores are exactly tied at the 8:00 check or at
	// 10:00. No clock; the next frag / lead change ends it (via _afterScore -> endMatch).
	enterSuddenDeath() {
		if (this.matchPhase !== MATCH_PHASE.ACTIVE) return
		this.matchPhase = MATCH_PHASE.SUDDEN_DEATH
		this._matchPublishAt = 0 // force an immediate publish of the overtime state
		console.log('[match] SUDDEN_DEATH — next frag wins')
	}

	// MATCH_END -> ACTIVE. Reset team scores + every player's kills/deaths + the tie-check,
	// restart the clock. Persistent server: the next match just begins (bots keep playing).
	resetMatch(now) {
		this.matchPhase = MATCH_PHASE.ACTIVE
		this.teamScore[0] = 0
		this.teamScore[1] = 0
		this.matchStartAt = now
		this.matchEndAt = 0
		this.matchWinner = MATCH_WINNER.DRAW
		this._tieChecked = false
		const clearScore = (raw, smooth) => {
			if (raw) { raw.kills = 0; raw.deaths = 0 }
			if (smooth) { smooth.kills = 0; smooth.deaths = 0 }
		}
		this.instance.clients.forEach(c => clearScore(c.rawEntity, c.smoothEntity))
		this.bots.forEach(b => clearScore(b.rawEntity, b.smoothEntity))
		this._matchPublishAt = 0 // force an immediate publish of the fresh state
		console.log('[match] new ACTIVE match started')
	}

	// Drive the match state machine + publish the low-rate MatchState entity. Called once
	// per server tick. Regulation is 10:00 with an 8:00 tie-check; the frag cap can end it
	// earlier (handled in _afterScore); an exact tie at 8:00 or 10:00 goes to SUDDEN_DEATH,
	// which is then ended by the next frag. MATCH_END holds the intermission, then resets.
	updateMatch(now) {
		if (this.matchPhase === MATCH_PHASE.ACTIVE) {
			const elapsed = now - this.matchStartAt
			// 8:00 tie-check (once): exactly tied -> sudden death now; else play on to 10:00.
			if (!this._tieChecked && elapsed >= TIE_CHECK_MS) {
				this._tieChecked = true
				if (this.scoresTied()) this.enterSuddenDeath()
			}
			// 10:00 regulation end: leader wins; still exactly tied -> sudden death.
			if (this.matchPhase === MATCH_PHASE.ACTIVE && elapsed >= TIME_LIMIT_MS) {
				if (this.scoresTied()) this.enterSuddenDeath()
				else this.endMatch()
			}
		}
		if (this.matchPhase === MATCH_PHASE.MATCH_END) {
			if (now - this.matchEndAt >= INTERMISSION_MS) {
				// MAP ROTATION: when serverMain armed onMatchCycle (rotation-driven boot),
				// the end of the intermission hands off to a process restart on the NEXT
				// map instead of resetting in place — clients have had the full banner +
				// scores moment by now. The callback never returns (process.exit).
				if (this.onMatchCycle) { this.onMatchCycle(); return }
				this.resetMatch(now)
			}
		}
		// countdown: real time only during ACTIVE regulation; 0 in overtime / intermission.
		const remaining = this.matchPhase === MATCH_PHASE.ACTIVE
			? Math.max(0, TIME_LIMIT_MS - (now - this.matchStartAt)) : 0
		this.publishMatchState(now, remaining)
	}

	// Write the MatchState entity fields (nengi delta-compresses, so identical writes
	// cost nothing on the wire). Publish immediately on any score/phase/winner change;
	// otherwise re-publish the ticking countdown at ~MATCH_PUBLISH_MS (2Hz).
	publishMatchState(now, remaining) {
		const ms = this.matchState
		if (!ms) return
		const changed = ms.phase !== this.matchPhase
			|| ms.teamScore0 !== this.teamScore[0]
			|| ms.teamScore1 !== this.teamScore[1]
			|| ms.winner !== this.matchWinner
			|| ms.mode !== this.gameMode
		if (!changed && now < this._matchPublishAt) return
		this._matchPublishAt = now + MATCH_PUBLISH_MS
		ms.phase = this.matchPhase
		ms.teamScore0 = this.teamScore[0]
		ms.teamScore1 = this.teamScore[1]
		ms.winner = this.matchWinner
		ms.mode = this.gameMode
		// quantize the countdown to 100ms so tiny per-tick drift doesn't churn the wire
		ms.timeRemainingMs = Math.max(0, Math.round(remaining / 100) * 100)
	}

	update(delta, tick, now) {
		// Pin the module-level active map to THIS instance's map before ticking. A tick is
		// synchronous, so every applyCommand call below (and any reconciliation replay of
		// these commands) sees a constant active map — deterministic, and multi-instance
		// safe even when one process hosts instances with different maps.
		setActiveMap(this.map)
		this.instance.emitCommands()

		// respawn any players whose death timer has run out
		const wallNow = Date.now()
		// PROOF OF BLOOD: advance the block clock every tick (closes + persists
		// blocks internally when the wall-clock window elapses)
		this.bloodLedger.tick(wallNow)
		this.instance.clients.forEach(client => {
			if (client.respawnAt && wallNow >= client.respawnAt) {
				client.respawnAt = null
				this.respawnPlayer(client)
			}
		})

		// Fall-death: anyone who drops below this.killY (walked off a ledge into the void)
		// dies — unattributed, routed through the same death bookkeeping as a frag.
		if (this.useMeshMap) {
			const killY = this.killY * (this.map.scale || 1)
			const fallKill = (raw, smooth, arm) => {
				if (!raw) return
				if (raw.isAlive) { raw._minY = Math.min(raw._minY ?? raw.y, raw.y); if (raw.grounded) raw._everGrounded = true }
				if (!raw.isAlive || raw.y >= killY) return
				const dt = raw._spawnT ? ((Date.now() - raw._spawnT) / 1000).toFixed(1) : '?'
				const sp = raw._spawnPos ? `(${raw._spawnPos.x.toFixed(1)},${raw._spawnPos.y.toFixed(1)},${raw._spawnPos.z.toFixed(1)})` : '?'
				console.log(`[fall] nid=${smooth.nid} died @(${raw.x.toFixed(1)},${raw.y.toFixed(1)},${raw.z.toFixed(1)}) minY=${(raw._minY ?? raw.y).toFixed(1)} everGrounded=${!!raw._everGrounded} +${dt}s after spawn ${sp}`)
				raw.isAlive = false; smooth.isAlive = false
				raw.velX = 0; raw.velY = 0; raw.velZ = 0
				raw.deaths = Math.min(255, raw.deaths + 1); smooth.deaths = raw.deaths
				// A void death is a suicide: TDM -1 to the victim's own team; FFA takes no
				// score change (kills unchanged). May decide a SUDDEN_DEATH lead change (TDM).
				this.scoreSelfKill(raw)
				arm(Date.now() + GameInstance.RESPAWN_DELAY_MS)
				this.instance.messageAll(new Killed(smooth.nid, smooth.nid, 0, 0, false))
			}
			this.instance.clients.forEach(client => {
				if (client.rawEntity && client.smoothEntity) fallKill(client.rawEntity, client.smoothEntity, t => { client.respawnAt = t })
			})
			this.bots.forEach(bot => {
				if (bot.rawEntity) fallKill(bot.rawEntity, bot.smoothEntity, t => { bot.respawnAt = t })
			})
		}

		// drive the bots: respawn, think, move, shoot — all through the same
		// code paths a human's commands take
		this.bots.forEach(bot => {
			if (bot.respawnAt && wallNow >= bot.respawnAt) {
				bot.respawnAt = null
				this.respawnPlayer(bot)
			}
			const entity = bot.rawEntity
			if (!entity.isAlive) return
			const command = bot.controller.think(delta, wallNow, this.combatants(entity), this.occluderMeshes)
			applyCommand(entity, command, this.obstacles)
			// only attempt the shot when the weapon can actually fire — fire()
			// would reject it anyway, but noisily (WEAPON_FIRE_FAIL log per tick)
			const state = entity.weaponsState[entity.currentWeaponIndex]
			// CEASEFIRE: bots hold the trigger through the MATCH_END intermission — no
			// muzzle flash / tracer noise behind the winner banner (damage is already
			// zeroed in damagePlayer; this keeps the moment VISUALLY calm too).
			if (this.matchPhase === MATCH_PHASE.MATCH_END) return
			if (command.fireInput && !state.onCooldown && !state.reloading && state.magazineAmmo > 0) {
				this.performShot(bot)
			}
		})

		// Update all active projectiles
		this.projectiles.forEach(proj => {
			// SWEPT step. Everything below resolves against the SEGMENT the bolt covers
			// this tick, [p0 -> p0 + v*delta], not against the end point alone. Keep the
			// start and the step vector; `segLen` is the distance travelled this tick.
			const p0x = proj.x, p0y = proj.y, p0z = proj.z
			const sx = proj.velocity.x * delta
			const sy = proj.velocity.y * delta
			const sz = proj.velocity.z * delta
			const segLen = Math.hypot(sx, sy, sz)

			proj.x = p0x + sx
			proj.y = p0y + sy
			proj.z = p0z + sz
			proj.lifeTime -= delta

			// Check if out of lifetime
			if (proj.lifeTime <= 0) {
				this.instance.removeEntity(proj)
				if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
				this.projectiles.delete(proj)
				return
			}

			// WORLD GEOMETRY. On a mesh map this.obstacles is EMPTY by construction (see
			// the constructor), so the obstacle loop further down can never stop a bolt:
			// before this, every Plasma bolt and Flak pellet flew through both towers and
			// the bridge for its full 3s life (195m / 135m) and Flak's bounceCount was
			// dead code. The map mesh is the world here, so sweep the step against it.
			//
			// Box arenas keep the obstacle loop below: there the Obstacle boxes ARE the
			// world geometry, that loop already handles them, and it is what carries the
			// shrapnel bounce. Running both would double-resolve the same boxes and the
			// (earlier) world sweep would pre-empt every bounce.
			let worldT = Infinity
			if (this.useMeshMap && segLen > 0) {
				const d = sweepWorld(this.occluderMeshes, p0x, p0y, p0z,
					sx / segLen, sy / segLen, sz / segLen, segLen)
				if (d < segLen) worldT = d / segLen
			}

			// Check collisions with players (humans and bots alike). Take the EARLIEST
			// entry along the segment, so a bolt that would cross two players hits the
			// near one — the old loop took whoever came first in iteration order.
			const projectileTargets = []
			this.instance.clients.forEach(c => projectileTargets.push(c))
			projectileTargets.push(...this.bots)
			let bestT = Infinity
			let bestClient = null
			projectileTargets.forEach(c => {
				const target = c.rawEntity
				if (!target || !target.isAlive || target.nid === proj.ownerNid) return
				// Swept sphere check (radius = proj.radius, default 0.75m; aimed Plasma
				// bolts spawn with a smaller radius — see spawn).
				const t = segmentSphereT(p0x, p0y, p0z, sx, sy, sz, target.x, target.y, target.z, proj.radius)
				if (t < 0 || t >= bestT) return
				// Vertical band, kept from the old test but now evaluated AT THE CROSSING
				// rather than at the tick position. Non-binding while proj.radius <= 1
				// (the crossing point is ON the sphere, so |dy| <= radius there); it only
				// starts to matter if a future weapon spawns a fatter bolt.
				if (Math.abs(target.y - (p0y + sy * t)) >= 1.0) return
				bestT = t
				bestClient = c
			})

			// A wall crossed BEFORE the victim blocks the bolt; a wall behind them does
			// not (same distance-along-the-ray rule the hitscan occlusion uses).
			if (bestClient && bestT <= worldT) {
				const c = bestClient
				// place the bolt at the crossing so the removal FX lands on the victim
				proj.x = p0x + sx * bestT
				proj.y = p0y + sy * bestT
				proj.z = p0z + sz * bestT
				let attacker = null
				this.instance.clients.forEach(ac => {
					if (ac.rawEntity && ac.rawEntity.nid === proj.ownerNid) attacker = ac
				})
				if (!attacker) attacker = this.bots.find(b => b.rawEntity.nid === proj.ownerNid) || null
				this.damagePlayer(c, attacker, proj.damage, 'projectile', proj.weaponIndex)

				// Plasma slow-on-hit: refresh (don't stack) the debuff on the
				// victim. Set on BOTH raw+smooth in lockstep — same rule as
				// damagePlayer's hp sync (the victim reads raw, everyone smooth).
				if (proj.slowFactor > 0 && c.rawEntity && c.rawEntity.isAlive) {
					c.rawEntity.slowTimer = proj.slowDuration
					c.rawEntity.slowFactor = proj.slowFactor
					if (c.smoothEntity) {
						c.smoothEntity.slowTimer = proj.slowDuration
						c.smoothEntity.slowFactor = proj.slowFactor
					}
				}

				this.instance.removeEntity(proj)
				if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
				this.projectiles.delete(proj)
				return
			}

			// Struck the map. Park the bolt exactly on the surface so the client's impact
			// FX fires at the wall, then kill it.
			if (worldT < Infinity) {
				proj.x = p0x + sx * worldT
				proj.y = p0y + sy * worldT
				proj.z = p0z + sz * worldT
				this.instance.removeEntity(proj)
				if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
				this.projectiles.delete(proj)
				return
			}

			// Check collisions with obstacles
			for (const obstacle of this.obstacles.values()) {
				const dx = obstacle.x - proj.x
				const dy = obstacle.y - proj.y
				const dz = obstacle.z - proj.z
				const dist = Math.hypot(dx, dy, dz)

				// Obstacle is 3x3x3 size box, so bounding radius is ~2.0
				if (dist < 2.0) {
					// Flak shrapnel with bounces left: reflect off the struck face
					// instead of dying. Obstacles are axis-aligned; pick the axis the
					// bolt is travelling toward the box center along most strongly
					// (cheap, robust — this is shrapnel, not a physics showcase) and
					// negate that velocity + dir component.
					if (proj.bounceRemaining > 0) {
						const vx = proj.velocity.x, vy = proj.velocity.y, vz = proj.velocity.z
						// component of the box-center direction the bolt is closing on
						const ax = Math.abs(dx) * (vx * dx > 0 ? 1 : 0)
						const ay = Math.abs(dy) * (vy * dy > 0 ? 1 : 0)
						const az = Math.abs(dz) * (vz * dz > 0 ? 1 : 0)
						if (ax >= ay && ax >= az && ax > 0) {
							proj.velocity.x = -vx; proj.dirX = -proj.dirX
						} else if (ay >= ax && ay >= az && ay > 0) {
							proj.velocity.y = -vy; proj.dirY = -proj.dirY
						} else if (az > 0) {
							proj.velocity.z = -vz; proj.dirZ = -proj.dirZ
						} else {
							// fallback: reflect the dominant travel axis
							const mx = Math.abs(vx), my = Math.abs(vy), mz = Math.abs(vz)
							if (mx >= my && mx >= mz) { proj.velocity.x = -vx; proj.dirX = -proj.dirX }
							else if (my >= mz) { proj.velocity.y = -vy; proj.dirY = -proj.dirY }
							else { proj.velocity.z = -vz; proj.dirZ = -proj.dirZ }
						}
						proj.bounceRemaining -= 1
						// nudge out of the box along the new velocity so we don't
						// re-collide with the same obstacle next frame
						proj.x += proj.velocity.x * delta
						proj.y += proj.velocity.y * delta
						proj.z += proj.velocity.z * delta
						break
					}
					this.instance.removeEntity(proj)
					if (proj.mesh && proj.mesh.dispose) proj.mesh.dispose()
					this.projectiles.delete(proj)
					break
				}
			}
		})

		// Phase 3: update thrown frag grenades — gravity + velocity integration,
		// bounce off floor/obstacles with restitution, fuse countdown → AoE detonation.
		// Cheap server-only physics (no client prediction). Snapshot to an array first
		// so detonateGrenade can safely mutate this.grenades mid-iteration.
		this.grenades.forEach(g => {
			// gravity + integrate
			const gp0x = g.x, gp0y = g.y, gp0z = g.z
			g.velocity.y -= GRENADE.GRAVITY * delta
			g.x += g.velocity.x * delta
			g.y += g.velocity.y * delta
			g.z += g.velocity.z * delta

			// FLOOR BOUNCE. Reflect Y with restitution + damp horizontal a touch so it
			// settles instead of skating forever. Only WHERE the floor is differs by map.
			if (this.useMeshMap) {
				// A mesh map has no floor plane — CTF-Visage's deck is at world y ~-25.35,
				// so the old unconditional clamp to GROUND_Y=0 shoved every grenade ~24m
				// into the sky on tick 1 and detonated it in the void: grenades did zero
				// damage on this map, always. Ask the geometry instead.
				//
				// Probe straight DOWN from the height the grenade started this tick, at the
				// x/z it is landing on, over exactly the distance it fell (+SKIN). That is a
				// swept floor test — a fast grenade cannot fall through a thin deck between
				// ticks — and it costs one short ray only while descending.
				const fall = gp0y - g.y
				if (fall > 0) {
					const reach = fall + GRENADE.SKIN
					const d = sweepWorld(this.occluderMeshes, g.x, gp0y, g.z, 0, -1, 0, reach)
					if (d < reach) {
						g.y = gp0y - d + GRENADE.SKIN
						if (g.velocity.y < 0) {
							g.velocity.y = -g.velocity.y * g.restitution
							g.velocity.x *= 0.8
							g.velocity.z *= 0.8
							// kill tiny residual bounces so it comes to rest-ish
							if (g.velocity.y < 0.6) g.velocity.y = 0
						}
					}
				}

				// WALL STOP. The down-probe only knows about surfaces underneath, so sweep
				// the HORIZONTAL part of the step too: a purely horizontal ray that hits
				// something is unambiguously a wall (no surface normal needed, which is why
				// the floor case is a separate query — at a shallow landing the dominant
				// travel axis is horizontal and reflecting on that would bounce a grenade
				// backwards off the deck). Reflect the dominant horizontal axis with
				// restitution, mirroring the box-arena obstacle fallback below.
				const hx = g.x - gp0x, hz = g.z - gp0z
				const hLen = Math.hypot(hx, hz)
				if (hLen > 0) {
					const reach = hLen + GRENADE.SKIN
					const d = sweepWorld(this.occluderMeshes, gp0x, g.y, gp0z, hx / hLen, 0, hz / hLen, reach)
					if (d < reach) {
						const back = Math.max(0, d - GRENADE.SKIN) / hLen
						g.x = gp0x + hx * back
						g.z = gp0z + hz * back
						if (Math.abs(g.velocity.x) >= Math.abs(g.velocity.z)) g.velocity.x = -g.velocity.x * g.restitution
						else g.velocity.z = -g.velocity.z * g.restitution
					}
				}
			} else if (g.y <= GRENADE.GROUND_Y) {
				// Box arena: the floor really is the plane y=0. Unchanged.
				g.y = GRENADE.GROUND_Y
				if (g.velocity.y < 0) {
					g.velocity.y = -g.velocity.y * g.restitution
					g.velocity.x *= 0.8
					g.velocity.z *= 0.8
					// kill tiny residual bounces so it comes to rest-ish
					if (g.velocity.y < 0.6) g.velocity.y = 0
				}
			}

			// obstacle bounce (reuse the projectile's axis-aligned box test). Reflect
			// the closing axis with restitution rather than removing the grenade.
			for (const obstacle of this.obstacles.values()) {
				const ox = obstacle.x - g.x
				const oy = obstacle.y - g.y
				const oz = obstacle.z - g.z
				const dist = Math.hypot(ox, oy, oz)
				if (dist < 2.0) {
					const vx = g.velocity.x, vy = g.velocity.y, vz = g.velocity.z
					const ax = Math.abs(ox) * (vx * ox > 0 ? 1 : 0)
					const ay = Math.abs(oy) * (vy * oy > 0 ? 1 : 0)
					const az = Math.abs(oz) * (vz * oz > 0 ? 1 : 0)
					if (ax >= ay && ax >= az && ax > 0) { g.velocity.x = -vx * g.restitution }
					else if (ay >= ax && ay >= az && ay > 0) { g.velocity.y = -vy * g.restitution }
					else if (az > 0) { g.velocity.z = -vz * g.restitution }
					else {
						const mx = Math.abs(vx), my = Math.abs(vy), mz = Math.abs(vz)
						if (mx >= my && mx >= mz) g.velocity.x = -vx * g.restitution
						else if (my >= mz) g.velocity.y = -vy * g.restitution
						else g.velocity.z = -vz * g.restitution
					}
					// nudge out along the new velocity so we don't re-collide next tick
					g.x += g.velocity.x * delta
					g.y += g.velocity.y * delta
					g.z += g.velocity.z * delta
					break
				}
			}

			// fuse: detonate regardless of bounces
			g.fuse -= delta
			if (g.fuse <= 0) {
				this.detonateGrenade(g)
			}
		})

		// Phase 3: tick each combatant's throw cooldown + grenade recharge. Recharge
		// accrues 1 charge per RECHARGE_TIME up to MAX_CHARGES (independent of the
		// min-interval throwCooldown). Applied to both the raw + smooth entity so the
		// networked grenadeCharges stays in lockstep for the HUD.
		const tickGrenades = (raw, smooth) => {
			if (!raw) return
			// UDamage powerup countdown (server-authoritative; networked for the buff render).
			// Same decrement shape as the grenade timers — OUTSIDE the reconciled applyCommand
			// path, so it can never perturb client movement prediction.
			if (raw.udamageTimer > 0) {
				raw.udamageTimer -= delta
				if (raw.udamageTimer < 0) raw.udamageTimer = 0
				if (smooth) smooth.udamageTimer = raw.udamageTimer
			}
			if (raw.throwCooldown > 0) {
				raw.throwCooldown -= delta
				if (raw.throwCooldown < 0) raw.throwCooldown = 0
			}
			if (raw.grenadeCharges < GRENADE.MAX_CHARGES) {
				raw.rechargeAccum += delta
				if (raw.rechargeAccum >= GRENADE.RECHARGE_TIME) {
					raw.rechargeAccum -= GRENADE.RECHARGE_TIME
					raw.grenadeCharges += 1
					if (smooth) smooth.grenadeCharges = raw.grenadeCharges
				}
			} else {
				raw.rechargeAccum = 0
			}
		}
		this.instance.clients.forEach(client => tickGrenades(client.rawEntity, client.smoothEntity))
		this.bots.forEach(bot => tickGrenades(bot.rawEntity, bot.smoothEntity))

		// Phase 4: mega-health pickup (proximity heal + 60s respawn clock) and the
		// per-player overheal decay. Server-authoritative, outside client prediction.
		this.updateMegaHealth(wallNow)
		this.updatePickups(wallNow)
		this.updateOverhealDecay(delta)

		// TDM: advance the match state machine (win check, intermission, reset) and
		// publish the low-rate MatchState entity. After scoring events this tick so a
		// frag-limit / time-limit win is reflected the same tick it occurs.
		this.updateMatch(wallNow)

		// for each player ...
		this.instance.clients.forEach(client => {
			const { rawEntity, smoothEntity } = client

			// the network view is a fixed full-arena box (set on connect) and is
			// intentionally never re-centered — nothing is culled at this scale

			// smooth entity will follow raw entity's path at *up to* 110% of the
			// fastest legit movement (dodge speed) — falls can briefly exceed this
			// and catch up on landing
			const movementBudget = MAX_SPEED * 1.1 * delta
			followPath(smoothEntity, client.positions, movementBudget)
			smoothEntity.rotationX = rawEntity.rotationX
			smoothEntity.rotationY = rawEntity.rotationY
		})

		// TECHNICALLY we should call scene.render(), but as this game is so simple and
		// computeWorldMatrix is called on every object after it is moved, i skipped it.
		// that's all scene.render() was going to do for us

		// when instance.updates, nengi sends out snapshots to every client
		this.instance.update()
	}
}

export default GameInstance
