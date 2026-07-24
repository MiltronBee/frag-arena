import * as BABYLON from './babylon.js'
import BABYLONRenderer from './graphics/BABYLONRenderer'
import InputSystem from './InputSystem'
import MoveCommand from '../common/command/MoveCommand'
import DeployCommand from '../common/command/DeployCommand'
import SpectatorHeartbeatCommand from '../common/command/SpectatorHeartbeatCommand'
import FireCommand from '../common/command/FireCommand'
import SwitchWeaponCommand from '../common/command/SwitchWeaponCommand'
import DevUpdateWeaponConfigCommand from '../common/command/DevUpdateWeaponConfigCommand'
import SetNameCommand from '../common/command/SetNameCommand'
import { decodeName, sanitizeName } from '../common/playerNames'
import { TELEPORT_KEEP_YAW } from '../common/message/Teleported'
import createFactories from './factories/createFactories'
import reconcilePlayer from './reconcilePlayer'
import applyCommand, { DODGE_DIRS } from '../common/applyCommand'
import { setActiveMap } from '../common/mapMesh'
import { getMapRecord, DEFAULT_MAP_ID } from '../common/mapRegistry'
import TouchControls, { isTouchDevice } from './TouchControls'
import { fire } from '../common/weapon'
import { shotPattern, applyPattern } from '../common/firePattern'
import { falloffRange } from '../common/damageFalloff'
import Viewmodel from './graphics/Viewmodel'
import WeaponAudio from './graphics/WeaponAudio'
import MusicManager from './graphics/MusicManager'
import FragLayer from './graphics/FragLayer'
import MenuControls from './graphics/MenuControls'
import ProgressReadout from './graphics/ProgressReadout'
import IntrusionFeed from './graphics/IntrusionFeed'
import { resolveWeaponFx } from './graphics/firingFx'
import { assets, weapons } from './assets/assetManifest'
import { SPAWN_WEAPON_INDEX } from '../common/weaponsConfig'
import preloadAssets from './graphics/assetPreloader'
import { MEGA_STATE } from '../common/entity/MegaHealthPickup'
import { MATCH_PHASE, MATCH_WINNER, MATCH_MODE } from '../common/entity/MatchState'
import { PICKUP_TYPE, PICKUP_RADIUS } from '../common/pickupConfig'
import { FLAG_STATE } from '../common/entity/Flag'
import { CP_OWNER } from '../common/entity/ControlPoint'
import { OBJECTIVE_EVENT } from '../common/message/ObjectiveEvent'

// Aim-safe positional camera pulse on a confirmed LOCAL flesh hit (world units of
// velocity impulse fed to the existing recoil spring; never rotates aim). Kept small
// on purpose — research flags camera shake as the effect most likely to hurt
// readability / cause sickness in a fast shooter. Set to 0 to disable entirely.
const CONFIRM_KICK = 0.05

// Phase 4: the mega-health CHARGING lead (ms) — mirrors GameInstance MEGA.CHARGE_LEAD
// (5s). Drives the client scale-in + hum ramp duration so the tell tracks the server's
// state=CHARGING window.
const MEGA_CHARGE_LEAD_MS = 5000

// ignoring certain data from the sever b/c we will be predicting these properties on the client
const ignoreProps = ['x', 'y', 'z', 'velX', 'velY', 'velZ']
const shouldIgnore = (myId, update) => {
	if (update.nid === myId) {
		if (ignoreProps.indexOf(update.prop) !== -1) {
			return true
		}
	}
	return false
}

class Simulator {
	constructor(client) {
		this.client = client
		// Map selection is a RUNTIME value on the client too. The /mapinfo handshake
		// (clientMain.boot) asks the server which map this instance runs and stashes
		// it on window.__SERVER_MAP_ID__ before we get here; no answer → default map
		// (identical to the pre-handshake behavior). setActiveMap pins the module-level
		// active-map bindings that the client's own applyCommand PREDICTION and
		// reconciliation read, so prediction and the server agree on USE_MESH_MAP;
		// the renderer is told the same record explicitly.
		this.map = getMapRecord((typeof window !== 'undefined' && window.__SERVER_MAP_ID__) || DEFAULT_MAP_ID)
		setActiveMap(this.map)
		this.renderer = new BABYLONRenderer(this.map)
		this.input = new InputSystem()
		this.obstacles = new Map()
		this.movers = new Map()          // nid -> Mover entity (UT lifts; client-side carry clamp reads these)
		this.characterModels = new Map() // nid -> CharacterModel (other players' visuals)
		this._nameRegistry = new Map()   // nid -> callsign string (overhead nametags + kill feed)
		this._projectiles = new Map()    // nid -> {entity, prev pos} for the plasma streak
		this._grenades = new Map()       // nid -> {entity, t0} for the Phase 3 fuse blink
		this._megaHealth = null          // the Phase 4 mega-health pickup entity (bob/spin/hum tell)
		this._megaState = -1             // last-seen networked pickup state (drives transitions)
		this._pickups = new Map()        // nid -> Pickup entity (UT-style map items; bob/spin off state)
		this._flags = new Map()          // nid -> Flag entity (CTF markers; recolor + HUD chips)
		this._controlPoints = new Map()  // nid -> ControlPoint entity (DOM markers; recolor + HUD chips)
		this._objHudSig = null           // last painted objective-HUD signature (skip DOM churn)
		this._lastOwned = undefined      // last-seen ownedWeapons bitmask (drives the local ammo-refill mirror)

		// procedural weapon audio (WebAudio). Silent until resume() runs from a user
		// gesture (enter-arena / pointer-lock / touch).
		this.audio = new WeaponAudio()

		// background music (HTMLAudio, separate from the WebAudio SFX bus): menu
		// theme on the entry screen, in-match track once the arena is entered. Like
		// this.audio it stays silent until unlock() runs from a user gesture; the
		// same pointerdown/touchstart/enter handlers below drive both.
		this.music = new MusicManager()

		// kill-feedback / "juice" layer (kill feed, frag banner, hitmarker upgrade,
		// corpses, gibs, directional damage arc, own-death camera). Isolated from the
		// sim: the message handlers below just forward events to it. See FragLayer.js.
		this.fragLayer = new FragLayer(this)

		// AIM-SAFE camera recoil: a POSITION-only kick spring. It never rotates the
		// camera, so the fire ray + MoveCommand aim (both rotation-only) are byte-
		// identical — zero authority/cadence change. Reset from the entity each frame,
		// so it self-clears and can never drift the view.
		this._camKick = new BABYLON.Vector3(0, 0, 0)
		this._camKickVel = new BABYLON.Vector3(0, 0, 0)

		// AIM-SAFE VISUAL camera recoil (Layer B): a ROTATION offset (pitch climb +
		// signed yaw drift + subtle roll) applied to the render camera AFTER the fire
		// ray + MoveCommand aim are read each frame, and fully REMOVED before the next
		// read — the identical apply-late / remove-first pattern FragLayer.applyDeathCamera
		// ships. Because getForwardRay() is read only while the offset is zero (see
		// update()), the shot ray + aim bytes the server judges are byte-identical with
		// or without recoil. `_recoilApplied` tracks exactly what we added last frame so
		// it can be subtracted before the next read (a plain += would compound into aim).
		// `visClimb` is the capped sustained-fire lean; `_recoilFov` is the transient
		// shotgun FOV punch (world camera only). Radians throughout (camKick is degrees;
		// converted at impulse time).
		this._recoil = new BABYLON.Vector3(0, 0, 0)      // current spring offset (pitch=x, yaw=y, roll=z)
		this._recoilVel = new BABYLON.Vector3(0, 0, 0)
		this._recoilApplied = new BABYLON.Vector3(0, 0, 0) // what we added to the camera last frame
		// reusable basis vectors + scratch for the per-frame spatial-audio listener
		// sync (see update()), so orienting the WebAudio listener never allocates.
		this._FWD = new BABYLON.Vector3(0, 0, 1)  // Vector3.Forward() (LH), cached
		this._UP = new BABYLON.Vector3(0, 1, 0)   // Vector3.Up(), cached
		this._lfwdScratch = new BABYLON.Vector3()
		this._lupScratch = new BABYLON.Vector3()
		this._recoilTension = 900
		this._recoilDamping = 60
		this._visClimb = 0
		this._recoilFov = null // { t0, amount, inMs, outMs } transient FOV punch

		// ADS (aim-down-sights) presentation state. _adsT eases 0(hip)..1(aimed) over
		// the weapon's in/out time and drives the composed world-camera FOV + look
		// sensitivity ONLY (never the aim ray). _adsSuppressUntilRelease forces a fresh
		// aim press after a weapon switch so a newly equipped gun never auto-aims.
		this._adsT = 0
		this._adsSuppressUntilRelease = false
		this._pumpDip = null // { t, vel } frame-clock shotgun/flak pump-dip timer

		// first-person weapon, swap with 1-4 / Q / wheel. Only the EQUIPPED weapon's
		// rig lives in the scene: multiple copies of the same skeleton coexisting
		// cross-wire each other's poses in Babylon 4.0.3, so we dispose + reload on
		// switch (the .glb is browser-cached; the swap hitch is negligible).
		// Start on the pistol — the only weapon a fresh spawn owns. The server entity
		// constructor and the Respawned handler both equip it; starting on 0 here put
		// an empty rifle in your hands on first join.
		this.weaponIndex = SPAWN_WEAPON_INDEX
		this.viewmodel = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[SPAWN_WEAPON_INDEX])
		this.viewmodel.setActive(true)
		this._viewmodelSwapId = 0
		this._viewmodelSwapQueue = Promise.resolve()
		this._setupWeaponSwitching()

		// isTouch must be known before the settings UI is built so the touch-only
		// rows (touch sensitivity, invert-Y) can be shown/hidden correctly
		this.isTouch = isTouchDevice()

		// Load settings with defaults. Desktop mouse sensitivity (`sens`) and touch
		// look sensitivity (`touchSens`) are persisted independently so tuning one
		// never disturbs the other.
		this.sensitivity = parseFloat(localStorage.getItem('sens') || '1.0')
		this.touchSensitivity = parseFloat(localStorage.getItem('touchSens') || '1.0')
		this.touchInvertY = localStorage.getItem('touchInvertY') === 'true'
		this.fov = parseInt(localStorage.getItem('fov') || '95', 10)
		this.renderer.camera.fov = (this.fov * Math.PI) / 180
		this._setupSettingsUI()

		// phones/tablets get the joystick + drag-look overlay instead of
		// pointer lock (which doesn't exist on mobile browsers)
		if (this.isTouch) {
			this.touchControls = new TouchControls(this)
		}
		this._setupGameUI()

		// main-menu affordances: callsign, wallet stub, how-to, plate keyboard nav +
		// selection, and the ISSUANCE / WHITEPAPER / ROADMAP / SETTINGS section wiring.
		// Presentation-only; it calls back into two Simulator methods (openSettings +
		// menu audio ticks) but never touches the entry gate / netcode.
		this._menuControls = new MenuControls(this)

		// nerdy fake-hardware LED loading readout (Part B). Blends the real gates into
		// one 0..100 target, eases the shown value each frame, holds 99.99 while assets
		// are done but server gates are pending, and mirrors onto the splash echo.
		this._progress = new ProgressReadout(this)

		// fake "hacking into a secure system" terminal feed (Part D). Pure flavor: appends
		// invented intrusion-log lines while the gate is closed, climaxes green on READY /
		// red on disconnect. Reads the same gate fields ProgressReadout does; owns its own
		// randomized cadence timers (stopped on arena entry). aria-hidden theater only.
		this._intrusionFeed = new IntrusionFeed(this)
		this._intrusionFeed.start()

		// SPLASH audio-unlock race (Part A). The inline splash controller can't reach
		// audio.resume()/music.unlock() (they live here in the bundle). Expose a hook it
		// calls on the Solana card tap; if the tap lands BEFORE the bundle boots, this
		// won't exist yet — so we ALSO install a one-shot document gesture listener that
		// performs the unlock on the very next gesture anywhere. Both are idempotent and
		// coexist with the existing PLAY-click / pointer-lock unlock paths (further
		// fallbacks). Common case: bundle up in <1s, the tap itself unlocks.
		this._installSplashAudioUnlock()

		// preload the heavy GLBs (third-person body + weapons) while the player is
		// on the entry screen, so nothing big downloads mid-match. Gates the ENTER
		// button (see _syncEntryState) and drives the loading bar.
		const arenaReady = (this.renderer.arenaDressing && this.renderer.arenaDressing._ready) || Promise.resolve()
		preloadAssets(this.renderer, arenaReady, (frac, stage) => this._setAssetProgress(frac, stage))
			.then(() => { this._assetsReady = true; this._setAssetProgress(1, 'FINALIZING'); this._syncEntryState(); this.audio.readyGo() })

		// dev-only tooling: the server ignores DevUpdateWeaponConfigCommand in
		// production, so predicting with modified configs would only desync us
		this.devToolsEnabled = process.env.NODE_ENV !== 'production'
		this.devInspectorOpen = false
		if (this.devToolsEnabled) this._setupDevInspector()

		this.myRawId = -1
		this.mySmoothId = -1

		this.myRawEntity = null
		this._pendingTeleport = null // Teleported that beat our entity create (see handler)
		this.mySmoothEntity = null

		// MENU SAFETY (v1): when the last DeployCommand went out (0 = none pending).
		// The server no longer spawns us on connect — the PLAY click / auto-rejoin
		// calls requestDeploy() and the Identity + entity-create snapshot is the ack.
		// update() re-sends while an intent is pending and no entity has arrived
		// (paced slower than the server's 3s deploy rate limit).
		this._deployRequestedAt = 0

		client.factory = createFactories({
			/* dependency injection */
			simulator: this,
		})

		client.entityUpdateFilter = (update) => {
			return shouldIgnore(this.myRawId, update)
		}

		client.on('message::Identity', message => {
			// these are the ids of our two entities.. we just store them here on simulator until
			// we receive these entities over the network (see: createPlayerFactory)
			this.myRawId = message.rawId
			this.mySmoothId = message.smoothId
			// our own x/y/z updates are ignored (we predict them), so the server hands
			// us the spawn point here; applied when the raw entity arrives
			// y is carried too (see Identity.js). createPlayerFactory currently applies
			// only x/z — the entity's y already arrives correct on the create-snapshot —
			// but keeping y here means the two sources can't disagree.
			this.spawnPos = { x: message.x, y: message.y, z: message.z }
			console.log('identified as', message)

			// tell the server our chosen callsign (typed at the menu, saved by
			// MenuControls). The server broadcasts it as a PlayerName message so every
			// client's nametag + kill feed shows the real name instead of a random one.
			const callsign = sanitizeName(localStorage.getItem('callsign') || '')
			this.client.addCommand(new SetNameCommand(callsign))
		})

		// a human player's real callsign (server broadcast). Register it under the
		// smooth nid (same key as the CharacterModel map) and update any live nametag.
		client.on('message::PlayerName', message => {
			const name = decodeName(message)
			this._nameRegistry.set(message.smoothNid, name)
			const model = this.characterModels.get(message.smoothNid)
			if (model) model.setName(name)
		})

		client.on('message::Respawned', message => {
			// server respawn teleport for our own predicted entity (own x/y/z
			// snapshots are ignored, so this message is the only way we move)
			if (!this.myRawEntity) return
			this.myRawEntity.x = message.x
			// y comes from the server now. It used to be hardcoded to 0 — correct only
			// on a box arena, whose floor WAS the plane y=0. On a mesh map the server
			// respawns you on the artist's floor (CTF-Visage: world y ~-24.2), so the
			// old `= 0` teleported the client ~24m into the air and it fell back down
			// every single respawn, mispredicting its own position (and every shot
			// origin / muzzle FX) for the whole ~1.6s fall.
			this.myRawEntity.y = message.y
			this.myRawEntity.z = message.z
			this.myRawEntity.velX = 0
			this.myRawEntity.velY = 0
			this.myRawEntity.velZ = 0

			// UT-STYLE LOADOUT RESET: a respawn returns us to pistol-only (the server does
			// the same authoritatively). Reset our predicted inventory + re-equip the pistol
			// so the HUD/viewmodel match and fire()/switch gate on the right ownership.
			this.myRawEntity.ownedWeapons = 1 << SPAWN_WEAPON_INDEX
			this._lastOwned = 1 << SPAWN_WEAPON_INDEX
			if (this.myRawEntity.weaponsState) {
				this.myRawEntity.weaponsState.forEach((st, i) => {
					const owned = i === SPAWN_WEAPON_INDEX
					st.magazineAmmo = owned ? weapons[i].magazineCapacity : 0
					st.reserveAmmo = owned ? weapons[i].maxReserveAmmo : 0
					st.onCooldown = false; st.cooldownTimer = 0; st.reloading = false; st.reloadTimer = 0; st.heat = 0
				})
			}
			if (this.weaponIndex !== SPAWN_WEAPON_INDEX) this.switchWeapon(SPAWN_WEAPON_INDEX) // force-equip the pistol

			// local respawn cue (this message is our own re-entry — see guard above)
			this.audio.respawn()

			// clear own-death camera drop/roll + red wash (FragLayer owns them)
			this.fragLayer.onRespawned()
		})

		client.on('message::Teleported', message => {
			// server portal teleport for our own predicted entity — same explicit-
			// handover contract as Respawned (own x/y/z snapshots are ignored, so
			// this message is the only way the server moves us). UNLIKE respawn it
			// carries velocity (horizontal speed redirected along the exit facing)
			// and touches NOTHING about the loadout — weapons/ammo survive a portal.
			//
			// A teleport can BEAT our own entity create (a spawn placed inside a
			// trigger: DEV_SPAWN_AT probes, or a future map-data mistake — the
			// server's 0.5s spawn grace can expire before a cold page finishes its
			// join handshake). Dropping the one-shot message here desynced the
			// client at the entry forever (probe-teleport-baroque caught it), so
			// stash it instead; createPlayerFactory flushes it the moment
			// myRawEntity exists.
			if (!this.myRawEntity) { this._pendingTeleport = message; return }
			this._applyTeleported(message)
		})

		// --- kill-feedback messages: forward straight to the FragLayer, which owns
		// all the DOM/FX. Simulator stays a thin router here (no UI logic).

		// attacker-only: upgrade the predicted hitmarker to the confirmed/kill marker
		client.on('message::HitConfirmed', message => {
			this.fragLayer.onHitConfirmed(message)
		})

		// broadcast: kill feed, frag banner, victim corpse/gib, own-death camera
		client.on('message::Killed', message => {
			this.fragLayer.onKilled(message)
			const myNid = this.mySmoothEntity ? this.mySmoothEntity.nid : null
			const suicide = message.killerNid === message.victimNid
			const iKilled = myNid != null && message.killerNid === myNid && !suicide && message.victimNid !== myNid
			const iDied = myNid != null && message.victimNid === myNid
			// local-player death sting + medal reset (streak/multi-kill end on my death)
			if (iDied) {
				this.audio.death()
				this._onLocalDeath()
			}
			// FIRST BLOOD: the first non-suicide kill of the match, announced only if I got it.
			if (!suicide && !this._firstKillSeen) {
				this._firstKillSeen = true
				if (iKilled) {
					this.audio.announce('first_blood', { gain: 0.9, minGap: 0 })
					if (this.fragLayer) this.fragLayer.showMedal('FIRST BLOOD')
				}
			}
			// KILL MEDALS for the local player (multi-kill window + no-death streak).
			if (iKilled) this._onLocalKill()
		})

		// victim-only: directional damage arc + scaled red screen wash
		client.on('message::DamageTaken', message => {
			this.fragLayer.onDamageTaken(message)
		})

		// broadcast: CTF/DOM objective event -> killfeed line + announcer callout
		client.on('message::ObjectiveEvent', message => {
			this._onObjectiveEvent(message)
		})

		client.on('message::WeaponFired', message => {
			if (this.mySmoothEntity && message.sourceId === this.mySmoothEntity.nid) {
				// hide our own shots.. we'll predict those instead
				return
			}
			// remote shooter: play their body's shoot one-shot overlay so observers
			// see the gun recoil in-world. Keyed by smooth nid (same key as the
			// CharacterModel map). No-op if we have no model for them yet.
			const shooterModel = this.characterModels.get(message.sourceId)
			if (shooterModel) shooterModel.playShoot()
			// The message carries the weapon index + the shot's deterministic spread
			// inputs (seed/heat), so observers render the EXACT pellet pattern the
			// server judged damage with, plus the correct per-weapon FX + report.
			const spec = weapons[message.weaponIndex]
			const fx = resolveWeaponFx(spec)
			if (spec && spec.type === 'hitscan') {
				const offsets = shotPattern(spec, message.seed, message.heat, message.aimFactor)
				const maxTracers = (fx.tracer && fx.tracer.pelletTracers) || offsets.length
				// Bound the observer's wall marks to the SAME server-side reach the local fire
				// path uses: max(range, ADS-extended falloffEnd) via the shared falloffRange
				// helper (message.aimFactor is the shot's authoritative ADS ramp). Without this
				// a remote player's shots painted marks past weapon reach (issue #32).
				const reach = Math.max(spec.range || 0,
					falloffRange(spec, message.aimFactor).end) || Number.MAX_VALUE
				offsets.forEach((off, i) => {
					const d = applyPattern({ x: message.tx, y: message.ty, z: message.tz }, off)
					this.renderer.drawHitscan(
						{ x: message.x, y: message.y, z: message.z, tx: d.x, ty: d.y, tz: d.z },
						{ fx, muzzle: i === 0, tracer: i < maxTracers, reach }
					)
				})
			} else {
				this.renderer.drawHitscan(message, { fx })
			}
			const cam = this.renderer.camera.position
			const dist = Math.hypot(message.x - cam.x, message.y - cam.y, message.z - cam.z)
			// REMOTE shot: pass the shooter's world position so the panner spatializes it
			// (comes from THEIR direction). distance kept as a 2D fallback if audio has no
			// live ctx / panner. Own shots were filtered out above and play 2D (distance 0).
			this.audio.fire(message.weaponIndex, fx.report, {
				distance: dist,
				pos: { x: message.x, y: message.y, z: message.z },
			})
		})

		client.on('predictionErrorFrame', predictionErrorFrame => {
			// a reconcile frame can arrive during the connect race, before our own
			// raw entity's create snapshot has been processed. Nothing to reconcile
			// against yet, so skip until it exists (avoids a null deref on startup).
			if (!this.myRawEntity) { return }
			reconcilePlayer(predictionErrorFrame, this.client, this.myRawEntity)
			// UT LIFT CARRY: re-pin to the platform after the reconcile replay converges
			// our predicted entity (same idempotent clamp as the per-frame prediction),
			// so a mid-ride correction lands us back on the platform, not inside it.
			this._carryClampSelf()
		})

		this.input.onmousemove = (e) => {
			// DIY camera control, first person shooter style. While aimed, look speed is
			// scaled by the weapon's ADS multiplier (smoothly, via _adsT) — this reduces
			// how far a mouse delta rotates the camera; the fire ray is still whatever the
			// camera ends up pointing at, so aim stays authoritative.
			const s = this.sensitivity * this._adsSensFactor()
			this.renderer.camera.rotation.x += e.movementY * 0.001 * s
			this.renderer.camera.rotation.y += e.movementX * 0.001 * s

			// prevent us from doing flips
			if (this.renderer.camera.rotation.x > Math.PI * 0.499) {
				this.renderer.camera.rotation.x = Math.PI * 0.499
			}

			if (this.renderer.camera.rotation.x < -Math.PI * 0.499) {
				this.renderer.camera.rotation.x = -Math.PI * 0.499
			}
		}
	}

	// resolve a player's callsign by nid (used by the kill feed + overhead nametags).
	// Falls back to a generic label until the name is registered by the factory.
	getName(nid) { return this._nameRegistry.get(nid) || `Player ${nid}` }

	// touch-only camera seam: apply a yaw/pitch delta (radians) already computed
	// by TouchLook. Kept separate from the mouse `onmousemove` path so desktop
	// pointer-lock behavior is untouched; the pitch clamp here is byte-for-byte
	// the same as the mouse path above (no flips past ~±89.8°).
	applyTouchLookDelta(yawRad, pitchRad) {
		const cam = this.renderer.camera
		// while aimed, scale touch look speed by the weapon's ADS multiplier (same
		// smooth _adsT curve as the mouse path) — presentation only, aim ray unaffected.
		const s = this._adsSensFactor()
		cam.rotation.y += yawRad * s
		cam.rotation.x += pitchRad * s

		if (cam.rotation.x > Math.PI * 0.499) {
			cam.rotation.x = Math.PI * 0.499
		}

		if (cam.rotation.x < -Math.PI * 0.499) {
			cam.rotation.x = -Math.PI * 0.499
		}
	}

	// Eject one brass casing from the weapon's port (firingFx eject preset). The
	// camera-local port offset is transformed through the live camera matrix, and
	// the fling velocity is built on the camera basis (right + up + a touch back)
	// so brass always arcs off the gun's right side, whatever way we face.
	_spawnCasing(eject) {
		if (!eject) return
		const cam = this.renderer.camera
		const m = cam.getWorldMatrix()
		const pos = BABYLON.Vector3.TransformCoordinates(
			new BABYLON.Vector3(eject.x, eject.y, eject.z), m)
		const right = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Right(), m)
		const up = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Up(), m)
		const fwd = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Forward(), m)
		const vel = right.scale(1.3 + Math.random() * 0.7)
			.add(up.scale(1.8 + Math.random() * 0.6))
			.add(fwd.scale(-0.2 + Math.random() * 0.3))
		this.renderer.spawnCasing(pos, vel, eject)
	}

	// Inject a recoil impulse on fire. POSITION-only (world space): a shove back along
	// -aim, a slight rise, and a little lateral jitter. Never touches camera rotation,
	// so the fire ray + MoveCommand aim are unchanged. Gentler on touch (nausea).
	_applyCameraRecoil(recoil) {
		if (!recoil) return
		const scale = this.isTouch ? 0.55 : 1.0
		const fwd = this.renderer.camera.getForwardRay().direction
		const back = (recoil.back || 0) * scale
		const jit = (recoil.shake || 0) * 0.018 * scale
		this._camKickVel.x += -fwd.x * back + (Math.random() - 0.5) * jit
		this._camKickVel.y += (recoil.rise || 0) * scale + (Math.random() - 0.5) * jit * 0.5
		this._camKickVel.z += -fwd.z * back + (Math.random() - 0.5) * jit
	}

	// A confirmed local hit: nudge the SAME position-only recoil spring with a tiny
	// random pulse so a landed shot has a hair of weight. Never rotates the aim (the
	// fire ray / MoveCommand are untouched); the spring self-clears each frame and the
	// M-clamp in _springCameraRecoil bounds it. Deliberately small (CONFIRM_KICK) —
	// shake harms readability in a twitch shooter — and gentler on touch.
	_applyConfirmKick() {
		if (!CONFIRM_KICK) return
		const k = CONFIRM_KICK * (this.isTouch ? 0.5 : 1.0)
		this._camKickVel.x += (Math.random() - 0.5) * k
		this._camKickVel.y += (Math.random() - 0.5) * k * 0.5
		this._camKickVel.z += (Math.random() - 0.5) * k
	}

	// critically-ish damped spring returning the position kick to zero, clamped so a
	// sustained burst can never drift the view far.
	_springCameraRecoil(delta) {
		const dt = Math.min(delta || 0.016, 0.05)
		const tension = 240, damping = 24
		const k = this._camKick, v = this._camKickVel
		v.x += (-tension * k.x - damping * v.x) * dt
		v.y += (-tension * k.y - damping * v.y) * dt
		v.z += (-tension * k.z - damping * v.z) * dt
		k.x += v.x * dt; k.y += v.y * dt; k.z += v.z * dt
		const M = 0.14
		k.x = Math.max(-M, Math.min(M, k.x))
		k.y = Math.max(-M, Math.min(M, k.y))
		k.z = Math.max(-M, Math.min(M, k.z))
	}

	// Inject a VISUAL camera-recoil impulse on a local shot. ROTATION only, and it is
	// NEVER live when getForwardRay() is read (removed at the top of update(), re-applied
	// only after the fire command + prediction are done) — so the fire ray / MoveCommand
	// aim are byte-identical. `ray.heat` (client-predicted, same value the server charges
	// spread with) scales the per-shot kick so the felt kick mirrors the accuracy penalty
	// with zero netcode change. Degrees in the preset → radians here. Gentler on touch.
	//
	// The high-frequency per-shot KICK goes through the return spring (_recoil), while the
	// low-frequency sustained-fire CLIMB is a SEPARATE persistent offset (_visClimb, degrees)
	// that is NOT fed into the spring — folding climb into the velocity impulse hammered the
	// spring with the full accumulated lean every shot (Bug A). Both are applied to the
	// camera (and tracked in _recoilApplied) in update()'s apply block, so both stay aim-safe.
	_applyCamRecoil(camKick, heat) {
		if (!camKick) return
		const scale = (this.isTouch ? 0.55 : 1.0) * Math.PI / 180
		// per-weapon return spring (read by _springCamRecoil this frame + after)
		this._recoilTension = camKick.tension || 900
		this._recoilDamping = camKick.damping || 60
		const h = Math.min(1, Math.max(0, heat || 0))
		// per-shot pitch kick ONLY (no climb term): base + a heat-scaled bias.
		const pitchDeg = (camKick.pitch || 0) * (1 + (camKick.heatBias || 0) * h)
		// pitch UP is a NEGATIVE rotation.x (mouse-look uses +x = look down; see onmousemove)
		this._recoilVel.x -= pitchDeg * scale * this._springImpulseGain()
		// sustained-fire CLIMB accrues SEPARATELY as a capped persistent lean (degrees),
		// applied as a smooth offset in update() and bled off exponentially between shots.
		if (camKick.climb) this._visClimb = Math.min(this._visClimb + camKick.climb, camKick.climbMax || 1.2)
		const yaw = (camKick.yawDrift || 0) + (Math.random() - 0.5) * 2 * (camKick.yawJitter || 0)
		this._recoilVel.y += yaw * scale * this._springImpulseGain()
		// subtle roll, RANDOM sign, tiny magnitude (readability). Prefer the explicit
		// per-weapon camKick.roll (degrees) when the config supplies it; otherwise fall
		// back to a yawJitter-derived seed so heavier guns roll a touch more even on
		// presets that predate the roll channel. Random sign keeps it a shimmer, not a
		// systematic lean. Fed through _recoilVel.z / the return spring exactly like
		// pitch & yaw, so it rides the same apply-late/remove-first path in update() and
		// is never live when getForwardRay() is read → fire-ray byte-identical.
		const rollDeg = camKick.roll != null ? camKick.roll : (camKick.yawJitter || 0) * 0.6
		const rollSign = Math.random() < 0.5 ? -1 : 1
		this._recoilVel.z += rollSign * rollDeg * scale * this._springImpulseGain()

		// shotgun-only FOV concussion punch (world camera; the vmCamera has its own
		// fixed fov so the gun never distorts). Does NOT touch rotation → aim-safe.
		if (camKick.fov) {
			this._recoilFov = { t0: performance.now(), amount: camKick.fov.amount || 0.03,
				inMs: camKick.fov.inMs || 50, outMs: camKick.fov.outMs || 180 }
		}
		// shotgun pump dip: a small downward camera nod on the rack, timed to the
		// viewmodel/audio pump so the whole body agrees. Driven by a FRAME-CLOCK timer
		// (not setTimeout) so it obeys pause and can be cleared on weapon swap — a
		// wall-clock timer fired the dip on whatever gun was equipped 350ms later.
		if (camKick.pumpDip) {
			// capture the gain now (weapon may swap before the delayed dip fires)
			this._pumpDip = {
				t: (camKick.pumpDip.delay || 350) / 1000,
				vel: (camKick.pumpDip.pitch || 0.15) * scale * this._springImpulseGain()
			}
		}
	}

	// impulse gain: a critically-damped spring (ζ≈1) driven by a velocity impulse v0
	// peaks at v0/(ω·e), ω=sqrt(tension). To make the preset `pitch` (etc.) read DIRECTLY
	// as the peak angle in degrees regardless of per-weapon stiffness, inject
	// v0 = θ·ω·e — i.e. multiply the target angle by sqrt(tension)·e. Keeps the table's
	// numbers meaningful (rifle 0.35° really peaks ~0.35°, well inside the 1.5° clamp).
	_springImpulseGain() { return Math.sqrt(this._recoilTension || 900) * Math.E }

	// critically-ish damped spring returning the VISUAL recoil rotation offset to zero.
	// Integrated in FIXED SUBSTEPS (semi-implicit Euler, v before r) so it is frame-rate
	// independent and can never diverge: a single Euler step at the 0.05s dt cap gave
	// dt·sqrt(tension) ≈ 1.94, right at the 2.0 blow-up boundary → chatter (Bug B). At a
	// <=0.004s substep, dt·ω stays tiny (<=0.155 even at tension 1500) regardless of the
	// frame rate. Clamped so the KICK picture can never diverge more than ~1.5° from where
	// shots actually land; the sustained CLIMB lean is applied OUTSIDE this clamp.
	_springCamRecoil(delta) {
		let remaining = Math.min(delta || 0.016, 0.05)
		const SUB = 0.004
		const tension = this._recoilTension || 900, damping = this._recoilDamping || 60
		const r = this._recoil, v = this._recoilVel
		while (remaining > 0) {
			const dt = Math.min(remaining, SUB)
			v.x += (-tension * r.x - damping * v.x) * dt
			v.y += (-tension * r.y - damping * v.y) * dt
			v.z += (-tension * r.z - damping * v.z) * dt
			r.x += v.x * dt; r.y += v.y * dt; r.z += v.z * dt
			remaining -= dt
		}
		const P = 1.5 * Math.PI / 180 // ~1.5° pitch/yaw ceiling, 3° roll — bounds the KICK only
		r.x = Math.max(-P, Math.min(P, r.x))
		r.y = Math.max(-P, Math.min(P, r.y))
		r.z = Math.max(-2 * P, Math.min(2 * P, r.z))
		// bleed the sustained-fire climb accumulator down EXPONENTIALLY (frame-rate
		// independent) when not actively firing, so the next burst starts from a cool
		// baseline. Exp decay lets climb accumulate then settle smoothly; the old linear
		// dt·3 bleed drained faster than a burst could accrue → visible sawtooth (Bug C).
		if (this._visClimb > 0) this._visClimb = this._visClimb * Math.exp(-4.0 * (delta || 0.016))
		if (this._visClimb < 1e-4) this._visClimb = 0
	}

	// Apply a server Teleported message to our predicted entity (see the
	// message::Teleported handler for the contract; split out so a stashed
	// pre-entity message can be applied late via flushPendingTeleport).
	_applyTeleported(message) {
		this.myRawEntity.x = message.x
		this.myRawEntity.y = message.y
		this.myRawEntity.z = message.z
		this.myRawEntity.velX = message.velX
		this.myRawEntity.velY = message.velY
		this.myRawEntity.velZ = message.velZ
		// A teleport (and a jump-pad launch, which is a Teleported with unchanged position
		// and an upward velocity) is a spatial discontinuity — re-derive grounded from the
		// new location by going airborne for this tick. CRITICAL for jump pads: if we stayed
		// grounded, the next predicted applyCommand would zero velY (its walking-ground rule)
		// and kill the launch. grounded is NOT reconciled (only x/y/z/vel are), so the
		// airborne vertical sweep simply re-grounds us next tick on a normal floor teleport.
		this.myRawEntity.grounded = false

		// exit facing: the camera owns look yaw (mouse-look writes camera.rotation.y
		// and the MoveCommand aim ray derives from it — see onmousemove/update), so
		// snapping it here IS the authoritative turn. TELEPORT_KEEP_YAW = the
		// destination had no facing; keep the player's current view.
		if (message.yaw !== TELEPORT_KEEP_YAW && Number.isFinite(message.yaw)) {
			this.renderer.camera.rotation.y = message.yaw
		}

		// FX: brief fullscreen flash + a burst at the camera; sound is the respawn
		// clip pitched up (no dedicated teleport clip shipped yet — SFX pipeline).
		this.fragLayer.onTeleported()
		this.audio.teleport()
		this.renderer.teleportBurst(new BABYLON.Vector3(message.x, message.y + 0.9, message.z))
	}

	// Deferred Teleported that arrived before our raw entity existed — called by
	// createPlayerFactory right after it assigns myRawEntity (and applies the
	// Identity spawnPos, which a stashed teleport must override: server-side the
	// teleport happened AFTER the spawn).
	flushPendingTeleport() {
		if (!this._pendingTeleport || !this.myRawEntity) return
		this._applyTeleported(this._pendingTeleport)
		this._pendingTeleport = null
	}

	// UT LIFT CARRY (client half). Post-sim platform clamp on our own predicted entity
	// against the INTERPOLATED Mover entities. Pins a rider to the platform rest height
	// (RIDE_REST above the box's standable top) and grounds it, mirroring the server's
	// authoritative carry (server/movers.js) so both converge with no handover message.
	//
	// STICKY RIDE LATCH: boarding uses a tight vertical band, but once boarded we latch to
	// that mover (`_ridingMoverNid`) and keep carrying it — ignoring the band-below — until
	// the rider JUMPS (velY spike) or leaves the footprint. Without the latch a low frame
	// rate (headless probes hit ~8 fps) lets the interp platform + the airborne gravity drop
	// exceed the band in a single frame and the clamp loses the rider mid-rise; the latch is
	// the DESIGN's client-local "MoverRide" — robust to any FPS / interp jump. Constants are
	// duplicated from server/movers.js (importing the server module into the client bundle
	// would pull in babylon.node + node deps). Fail-soft: never throw inside prediction.
	_carryClampSelf() {
		const e = this.myRawEntity
		if (!e || !this.movers || this.movers.size === 0) return
		try {
			const RIDE_REST = 0.5316, SKIN = 0.2, BAND_ABOVE = 1.2, JUMP_EPS = 0.1
			// BOARD_BELOW is intentionally generous: a rider in the footprint whose feet are up
			// to this far BELOW the (interp) platform still boards — this catches a rider the
			// rising lift left behind before the client's first clamp ran (a Mover-snapshot /
			// low-FPS race), then the sticky latch keeps them glued. Kept < the lift travel
			// (6.84 m) so it never grabs someone standing in the shaft under a fully-raised lift.
			const BOARD_BELOW = 4.0
			// STATE-GATED COLLISION: make the client platform box SOLID only at rest
			// (AT_BOTTOM 0 / AT_TOP 2) so a rider gets real floor traction to walk on/off it;
			// keep it NON-colliding while MOVING (RISING 1 / DESCENDING 3) — a moving
			// checkCollisions box penetrates the predicted capsule and moveWithCollisions
			// ejects the rider out of the carry band (DESIGN option a's failure). At rest the
			// box is stationary, so there is nothing to eject; during motion the idempotent
			// clamp below does the carrying. This is what lets a rider both RIDE cleanly and
			// WALK OFF at the top.
			for (const m of this.movers.values()) {
				const wantSolid = (m.state === 0 || m.state === 2)
				if (m.mesh.checkCollisions !== wantSolid) m.mesh.checkCollisions = wantSolid
			}
			const onboard = (m) => {
				e.y = m.y + m.height * 0.5 + RIDE_REST // box centre -> surface -> ride height
				e.velY = 0
				e.grounded = true
				this._ridingMoverNid = m.nid
			}
			// still riding the latched mover?
			if (this._ridingMoverNid != null) {
				const m = this.movers.get(this._ridingMoverNid)
				if (m && e.velY <= JUMP_EPS) {
					const halfW = m.width * 0.5, halfD = m.depth * 0.5
					const dx = e.x - m.x, dz = e.z - m.z
					if (!(dx < -halfW - SKIN || dx > halfW + SKIN || dz < -halfD - SKIN || dz > halfD + SKIN)) {
						onboard(m) // stay glued regardless of vertical distance (carry up/down)
						return
					}
				}
				this._ridingMoverNid = null // jumped off / walked off / mover gone
			}
			// not riding: BOARD only within the tight grab band (on / just above the platform)
			for (const m of this.movers.values()) {
				const halfW = m.width * 0.5, halfD = m.depth * 0.5
				const top = m.y + m.height * 0.5
				const rideY = top + RIDE_REST
				const dx = e.x - m.x, dz = e.z - m.z
				if (dx < -halfW - SKIN || dx > halfW + SKIN) continue
				if (dz < -halfD - SKIN || dz > halfD + SKIN) continue
				if (e.y < rideY - BOARD_BELOW || e.y > rideY + BAND_ABOVE) continue
				if (e.velY > JUMP_EPS) continue
				onboard(m)
				return
			}
		} catch (err) { /* fail-soft — never break prediction over a mover glitch */ }
	}

	// Compose the transient shotgun FOV punch onto the LIVE base fov each frame (never
	// mutate the stored base). Ease in fast, out slow. World camera only. Aim-safe (FOV
	// is not orientation — getForwardRay() direction is unaffected by field of view).
	// cubic ease-out for the ADS transition — a linear FOV lerp reads cheap and jerks
	// at the endpoints (constant angular velocity); ease-out gives it weight.
	_adsEase(t) { return 1 - Math.pow(1 - t, 3) }

	// look-speed multiplier while aimed. FOCAL-LENGTH ("0%") matched, not a fixed
	// magic number: scale by the ratio of half-FOV tangents at the current (eased)
	// zoom so hand->pixel travel stays consistent as the view zooms in. 1.0 at hip.
	// Never mutates the stored sensitivity. (id-gameplay review: gemini-id.mjs.)
	_adsSensFactor() {
		const ads = weapons[this.weaponIndex] && weapons[this.weaponIndex].ads
		if (!ads || !this._adsT) return 1
		const t = this._adsEase(this._adsT)
		const curFov = this.fov + (ads.fov - this.fov) * t
		return Math.tan((curFov * Math.PI) / 360) / Math.tan((this.fov * Math.PI) / 360)
	}

	_applyRecoilFov() {
		const cam = this.renderer.camera
		// Composed world-camera FOV: base user FOV -> ADS interpolation -> transient
		// recoil punch. FOV is not orientation, so getForwardRay() is unaffected by any
		// of it → the aim ray + MoveCommand stay byte-identical whether aimed or not.
		const ads = weapons[this.weaponIndex] && weapons[this.weaponIndex].ads
		const t = this._adsEase(this._adsT || 0)
		const fovDeg = ads ? (this.fov + (ads.fov - this.fov) * t) : this.fov
		const base = (fovDeg * Math.PI) / 180
		const p = this._recoilFov
		if (!p) { if (cam.fov !== base) cam.fov = base; return }
		const age = performance.now() - p.t0
		let f
		if (age < p.inMs) {
			f = age / p.inMs
		} else if (age < p.inMs + p.outMs) {
			const k = (age - p.inMs) / p.outMs
			f = 1 - k * (2 - k) // ease-out quad (1 → 0)
		} else {
			this._recoilFov = null
			cam.fov = base
			return
		}
		cam.fov = base * (1 + p.amount * f)
	}

	// flash the crosshair hit marker. One reused timer (cleared each call) so repeated
	// hits never pile up timers. kill = the skull/rotating red-X kill treatment; `heavy`
	// (≥20 predicted dmg — pistol/shotgun) gets a slightly bigger pop. Durations here
	// MUST match the CSS keyframes (hit-pop 160ms, kill-pop 450ms) so the class is
	// removed exactly when the grow-in/out animation ends.
	_showHitMarker(kill, heavy, headshot) {
		const el = document.getElementById('hit-marker')
		if (!el) return
		el.classList.remove('hit-active', 'kill-active', 'hit-active-heavy', 'headshot-active')
		void el.offsetWidth // restart the CSS animation (SMG-rate re-triggers must not drop the marker)
		if (kill) {
			el.classList.add('kill-active')
			// a HEADSHOT kill keeps the kill marker; headshot-active rides along as a CSS
			// hook and FragLayer fires the "Headshot!" announcer separately.
			if (headshot) el.classList.add('headshot-active')
		} else if (headshot) {
			// distinct HEADSHOT marker (authoritative-only, never predicted). Degrades to
			// the existing heavy treatment so it reads stronger than a flesh hit even
			// before a bespoke .headshot-active CSS rule is authored.
			el.classList.add('hit-active', 'hit-active-heavy', 'headshot-active')
		} else {
			el.classList.add('hit-active')
			if (heavy) el.classList.add('hit-active-heavy')
		}
		clearTimeout(this._hitMarkerTimer)
		this._hitMarkerTimer = setTimeout(() => {
			el.classList.remove('hit-active', 'kill-active', 'hit-active-heavy', 'headshot-active')
		}, kill ? 450 : 160)
	}

	// plasma bolt bookkeeping (called from the Projectile factory). Each bolt is
	// oriented + stretched into a travel streak every frame; on delete it emits a
	// pooled energetic impact + a positional zap.
	registerProjectile(entity) {
		if (!entity) return
		this._projectiles.set(entity.nid, { entity, px: entity.x, py: entity.y, pz: entity.z })

		// Calculate visual start offset for muzzle origin blending
		let muzzleWorld = null
		if (entity.ownerNid === this.myRawId || entity.ownerNid === this.mySmoothId) {
			muzzleWorld = this.viewmodel ? this.viewmodel.muzzleWorldPos() : null
		} else {
			const model = this.characterModels.get(entity.ownerNid)
			if (model && model._weaponRoot) {
				muzzleWorld = model._weaponRoot.getAbsolutePosition()
			}
		}

		if (muzzleWorld) {
			entity.visualOffset = muzzleWorld.subtract(new BABYLON.Vector3(entity.x, entity.y, entity.z))
		} else {
			entity.visualOffset = new BABYLON.Vector3(0, 0, 0)
		}
	}

	unregisterProjectile(nid) {
		const rec = this._projectiles.get(nid)
		if (!rec) return
		this._projectiles.delete(nid)
		const e = rec.entity
		const pos = new BABYLON.Vector3(e.x, e.y, e.z)
		this.renderer.plasmaImpact(pos)
		const cam = this.renderer.camera.position
		// remote energy impact: spatialize from the projectile's world position.
		this.audio.impact('energy', {
			distance: BABYLON.Vector3.Distance(pos, cam),
			pos: { x: e.x, y: e.y, z: e.z },
		})
	}

	_updateProjectiles(delta) {
		if (this._projectiles.size === 0) return
		const STREAK = 3.2
		this._projectiles.forEach((rec) => {
			const e = rec.entity
			const mesh = e && e.mesh
			if (!mesh || (mesh.isDisposed && mesh.isDisposed())) return

			// Decay visual offset over time (smoothly interpolate to 0)
			if (e.visualOffset && e.visualOffset.lengthSquared() > 1e-6) {
				// decay by half every 0.05 seconds (approx. 3 frames at 60fps)
				const decay = Math.pow(0.5, delta / 0.05)
				e.visualOffset.scaleInPlace(decay)
			}

			// Apply visual offset to the mesh position
			mesh.position.set(e.x, e.y, e.z)
			if (e.visualOffset) {
				mesh.position.addInPlace(e.visualOffset)
			}

			const dx = e.x - rec.px, dy = e.y - rec.py, dz = e.z - rec.pz
			if ((dx * dx + dy * dy + dz * dz) > 1e-8) {
				mesh.lookAt(new BABYLON.Vector3(e.x + dx, e.y + dy, e.z + dz))
				mesh.scaling.set(1, 1, STREAK)
			}
			rec.px = e.x; rec.py = e.y; rec.pz = e.z
		})
	}

	// Phase 3 frag-grenade bookkeeping (called from the Grenade factory). Tracks the
	// spawn time so the arming light can blink FASTER as the 1.8s fuse nears 0; on
	// delete (server detonation) it fires the explosion FX + boom at the last position.
	registerGrenade(entity) {
		if (!entity) return
		this._grenades.set(entity.nid, { entity, t0: performance.now() })
	}

	unregisterGrenade(nid) {
		const rec = this._grenades.get(nid)
		if (!rec) return
		this._grenades.delete(nid)
		const e = rec.entity
		const pos = new BABYLON.Vector3(e.x, e.y, e.z)
		if (this.renderer.grenadeExplosion) this.renderer.grenadeExplosion(pos)
		const cam = this.renderer.camera.position
		if (this.audio.explosion) {
			this.audio.explosion({
				distance: BABYLON.Vector3.Distance(pos, cam),
				pos: { x: e.x, y: e.y, z: e.z },
			})
		}
	}

	// blink the grenade's arming light, accelerating toward the ~1.8s fuse. Presentation
	// only; the authoritative fuse + detonation live server-side.
	_updateGrenades() {
		if (this._grenades.size === 0) return
		const now = performance.now()
		const FUSE_MS = 1800
		this._grenades.forEach((rec) => {
			const e = rec.entity
			const mat = e && e.lightMat
			if (!mat) return
			const age = Math.min(now - rec.t0, FUSE_MS)
			const t = age / FUSE_MS
			// blink period shrinks from ~320ms down to ~70ms as the fuse runs out
			const period = 320 - 250 * t
			const on = (age % period) < period * 0.5
			mat.emissiveColor.set(on ? 1.0 : 0.15, on ? 0.35 : 0.05, on ? 0.1 : 0.02)
		})
	}

	// Phase 4 mega-health bookkeeping (called from the MegaHealthPickup factory).
	registerMegaHealth(entity) {
		if (!entity) return
		this._megaHealth = entity
		this._megaState = -1 // force the next _updateMegaHealth to run the transition
	}

	unregisterMegaHealth(nid) {
		if (this._megaHealth && this._megaHealth.nid === nid) this._megaHealth = null
		if (this.audio.megaHumStop) this.audio.megaHumStop()
		this._megaState = -1
	}

	// TDM: the low-rate MatchState entity (team scores / timer / phase / winner). Stored
	// so _updateHud can paint the team scoreboard + banner each frame off its networked
	// fields. Server-authoritative — the client only reads it, never asserts a score.
	registerMatchState(entity) {
		if (!entity) return
		this._matchState = entity
		// FFA UNIFORM RACE GUARD: player creates (and their teamId watch) can land in
		// the same snapshot BEFORE this MatchState — those models were tinted red/blue
		// under the default non-FFA read. Now that the mode is known, re-sweep every
		// existing model to the neutral matching-black uniform. Idempotent; TDM/CTF/DOM
		// need no sweep (team tint was already the right call).
		if (this.isFFA()) this.characterModels.forEach((model) => model.setNeutral())
	}
	unregisterMatchState(nid) {
		if (this._matchState && this._matchState.nid === nid) this._matchState = null
	}

	// FFA has no teams: everyone wears the matching black uniform (see
	// CharacterModel.setNeutral). False until MatchState arrives — callers that fire
	// earlier are corrected by the registerMatchState sweep above.
	isFFA() {
		return !!this._matchState && (this._matchState.mode | 0) === MATCH_MODE.FFA
	}

	// ── LOCAL KILL MEDALS (announcer) ────────────────────────────────────────────
	// Purely local + client-side: the server owns kills; this just voices UT-style medals
	// for the LOCAL player off the broadcast Killed feed. Reset each match (new-match phase
	// transition) and on the local player's death (ends multi-kill window + no-death streak).
	_resetMedals() {
		this._killStreak = 0
		this._multiTimes = []
		this._firstKillSeen = false
	}

	// local player died: a no-death streak and the rapid-succession window both end.
	_onLocalDeath() {
		this._killStreak = 0
		this._multiTimes = []
	}

	// local player got a frag: advance the multi-kill window (~4s) + the no-death streak,
	// and voice the highest medal earned. A milestone STREAK outranks a multi-kill on the
	// same frag (the announce cooldown drops the lower-priority second call).
	_onLocalKill() {
		const now = performance.now()
		this._multiTimes = (this._multiTimes || []).filter((t) => now - t <= 4000)
		this._multiTimes.push(now)
		const n = this._multiTimes.length
		this._killStreak = (this._killStreak || 0) + 1
		const streakClip = this._killStreak === 5 ? 'killing_spree'
			: this._killStreak === 10 ? 'rampage'
			: this._killStreak === 15 ? 'unstoppable'
			: this._killStreak === 20 ? 'godlike' : null
		const multiClip = n === 2 ? 'double_kill' : n === 3 ? 'triple_kill' : n >= 4 ? 'multi_kill' : null
		if (!this.audio) return
		// streak milestone (bigger deal) first, at minGap 0 so it always plays; the multi
		// callout then hits the default cooldown and is dropped when both land the same frag.
		if (streakClip) this.audio.announce(streakClip, { gain: 0.95, minGap: 0 })
		if (multiClip) this.audio.announce(multiClip, { gain: 0.85 })
		// visual counterpart (HUD2030 §C): the medal callout mirrors the highest
		// announce that fired — streak outranks multi, same as the audio priority.
		const medalText = streakClip ? streakClip.replace(/_/g, ' ').toUpperCase()
			: multiClip ? multiClip.replace(/_/g, ' ').toUpperCase() : null
		if (medalText && this.fragLayer) this.fragLayer.showMedal(medalText)
	}

	// The local player's FFA standing: my frags (my networked kills), the current TOP frags
	// across every player entity (server-authoritative kills — the client only READS them),
	// and whether I'm the leader. Used for the FFA scoreboard + the victory/defeat announcer.
	_ffaStanding() {
		let myFrags = 0
		if (this.myRawEntity && typeof this.myRawEntity.kills === 'number') myFrags = this.myRawEntity.kills | 0
		else if (this.mySmoothEntity && typeof this.mySmoothEntity.kills === 'number') myFrags = this.mySmoothEntity.kills | 0
		let topFrags = 0
		const ents = this.client && this.client.entities
		if (ents && ents.forEach) {
			ents.forEach((e) => {
				// only player entities carry a numeric `kills` (MatchState/Pickup/Mega do not).
				if (e && typeof e.kills === 'number' && e.kills > topFrags) topFrags = e.kills | 0
			})
		}
		if (myFrags > topFrags) topFrags = myFrags
		return { myFrags, topFrags, amTop: myFrags >= topFrags }
	}

	// Paint the scoreboard (TDM: both team scores / FFA: my frags vs the leader), the match
	// countdown, and the MATCH_END banner off the networked MatchState — and trigger the
	// match-event ANNOUNCER on phase transitions (fight / mode callout / victory / defeat /
	// sudden-death). Presentation + reaction only: the server owns phase, scores and winner;
	// the client never asserts any of them. Cheap: only touches the DOM when a field changes.
	_updateMatchHud() {
		const ms = this._matchState
		const board = document.getElementById('tdm-scoreboard')
		if (!ms || !board) return

		const mode = ms.mode | 0
		const ffa = mode === MATCH_MODE.FFA
		if (ffa !== this._lastFfa) {
			this._lastFfa = ffa
			board.setAttribute('data-mode', ffa ? 'ffa' : 'tdm')
			// relabel the two score slots for FFA (personal frags vs the leaderboard top).
			const redTag = board.querySelector('.tdm-side-red .tdm-tag')
			const blueTag = board.querySelector('.tdm-side-blue .tdm-tag')
			if (redTag) redTag.textContent = ffa ? 'YOU' : 'RED'
			if (blueTag) blueTag.textContent = ffa ? 'TOP' : 'BLUE'
		}

		// score readout. TDM: the two team scores. FFA: my frags (red slot) vs the current
		// leader's frags (blue slot) — a minimal personal/leaderboard readout.
		let s0, s1
		if (ffa) {
			const st = this._ffaStanding()
			s0 = st.myFrags; s1 = st.topFrags
		} else {
			s0 = ms.teamScore0 | 0; s1 = ms.teamScore1 | 0
		}
		if (s0 !== this._lastTdmS0) {
			this._lastTdmS0 = s0
			const el = document.getElementById('tdm-score-red')
			if (el) el.textContent = String(s0)
		}
		if (s1 !== this._lastTdmS1) {
			this._lastTdmS1 = s1
			const el = document.getElementById('tdm-score-blue')
			if (el) el.textContent = String(s1)
		}

		const phase = ms.phase | 0

		// countdown mm:ss (server quantizes to 100ms; ceil so it never shows 0:00 early).
		// SUDDEN_DEATH has no clock — show "OT" instead of a time.
		const secs = Math.max(0, Math.ceil((ms.timeRemainingMs | 0) / 1000))
		const timeText = phase === MATCH_PHASE.SUDDEN_DEATH
			? 'OT' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
		if (timeText !== this._lastTdmTimeText) {
			this._lastTdmTimeText = timeText
			const el = document.getElementById('tdm-timer')
			if (el) el.textContent = timeText
		}

		// which team is the local player on? Highlight it (data-myteam), read off our own
		// entity's replicated teamId (available once we've spawned). No-op highlight in FFA.
		const myTeam = this.myRawEntity ? this.myRawEntity.teamId
			: (this.mySmoothEntity ? this.mySmoothEntity.teamId : undefined)
		if (myTeam !== this._lastTdmMyTeam) {
			this._lastTdmMyTeam = myTeam
			board.setAttribute('data-myteam', ffa ? 'none' : myTeam === 0 ? 'red' : myTeam === 1 ? 'blue' : 'none')
		}

		// phase / winner banner
		const winner = ms.winner | 0
		if (phase !== this._lastTdmPhase || winner !== this._lastTdmWinner) {
			this._lastTdmPhase = phase
			this._lastTdmWinner = winner
			const banner = document.getElementById('tdm-banner')
			const ended = phase === MATCH_PHASE.MATCH_END
			board.classList.toggle('match-over', ended)
			board.classList.toggle('sudden-death', phase === MATCH_PHASE.SUDDEN_DEATH)
			if (banner) {
				banner.classList.toggle('is-visible', ended)
				if (ended) {
					let title, cls
					if (ffa) {
						const won = this._ffaStanding().amTop
						title = won ? 'VICTORY' : 'DEFEAT'
						// color law: gold underline for own victory, threat for defeat
						cls = won ? 'tdm-win' : 'tdm-red'
					} else {
						title = winner === MATCH_WINNER.TEAM0 ? 'RED WINS'
							: winner === MATCH_WINNER.TEAM1 ? 'BLUE WINS' : 'DRAW'
						cls = winner === MATCH_WINNER.TEAM0 ? 'tdm-red'
							: winner === MATCH_WINNER.TEAM1 ? 'tdm-blue' : ''
					}
					const tEl = document.getElementById('tdm-banner-title')
					const sEl = document.getElementById('tdm-banner-score')
					if (tEl) { tEl.textContent = title; tEl.className = cls }
					if (sEl) sEl.textContent = `${s0} — ${s1}`
				}
			}
		}

		// ── MATCH-EVENT ANNOUNCER (client reacts to MatchState transitions; no server code) ──
		// First observed phase seeds the guard so joining mid-match never fires a callout.
		if (this._annPhase === undefined) {
			this._annPhase = phase
		} else if (phase !== this._annPhase && this.audio) {
			this._annPhase = phase
			if (phase === MATCH_PHASE.ACTIVE) {
				// new match kicked off (out of the MATCH_END intermission): reset local kill
				// medals, then "Fight!" + a staggered mode callout (both heard past cooldown).
				this._resetMedals()
				this.audio.announce('fight', { gain: 0.9 })
				// staggered mode callout: CTF/DOM get their own voice; FFA gets none.
				const modeClip = mode === MATCH_MODE.CTF ? 'capture_the_flag'
					: mode === MATCH_MODE.DOM ? 'domination'
					: mode === MATCH_MODE.TDM ? 'team_deathmatch' : null
				if (modeClip) setTimeout(() => { if (this.audio) this.audio.announce(modeClip, { gain: 0.85, minGap: 0 }) }, 1400)
			} else if (phase === MATCH_PHASE.SUDDEN_DEATH) {
				// overtime tension cue (no bespoke sudden-death clip ships — reuse "Fight!").
				this.audio.announce('fight', { gain: 0.9 })
			} else if (phase === MATCH_PHASE.MATCH_END) {
				let won
				if (ffa) won = this._ffaStanding().amTop
				else won = (winner === MATCH_WINNER.TEAM0 && myTeam === 0)
					|| (winner === MATCH_WINNER.TEAM1 && myTeam === 1)
				const draw = !ffa && winner === MATCH_WINNER.DRAW
				this.audio.announce(draw ? 'draw' : won ? 'victory' : 'defeat', { gain: 0.95, minGap: 0 })
			}
		}
	}

	// Drive the mega-health pickup presentation off its networked `state`:
	//   AVAILABLE → visible, slow bob + spin + amber glow, ambient hum
	//   CHARGING  → scale/fade IN + rising-hum tell (final ~5s before respawn)
	//   HIDDEN    → hidden, hum off (taken or silently charging)
	// State TRANSITIONS fire the hum start/stop + the pickup chime (on AVAILABLE→HIDDEN,
	// i.e. a grab). Per-frame bob/spin/glow run while shown. Presentation only — the
	// heal + respawn clock are server-authoritative.
	_updateMegaHealth() {
		const e = this._megaHealth
		if (!e) return
		const mesh = e.mesh
		if (!mesh || (mesh.isDisposed && mesh.isDisposed())) return
		const model = e._healthModel
		const state = e.state
		const now = performance.now()
		const pos = { x: e.x, y: e.y, z: e.z }

		// ---- state transitions ----
		if (state !== this._megaState) {
			const prev = this._megaState
			this._megaState = state
			if (state === MEGA_STATE.HIDDEN) {
				// grab (was AVAILABLE) → chime; either way stop the hum
				if (prev === MEGA_STATE.AVAILABLE && this.audio.megaPickup) {
					const cam = this.renderer.camera.position
					this.audio.megaPickup({
						distance: BABYLON.Vector3.Distance(new BABYLON.Vector3(e.x, e.y, e.z), cam),
						pos,
					})
				}
				if (this.audio.megaHumStop) this.audio.megaHumStop()
				this._megaCharge0 = 0
			} else {
				// AVAILABLE or CHARGING → ensure the hum is running
				if (this.audio.megaHumStart) this.audio.megaHumStart(pos)
				if (state === MEGA_STATE.CHARGING) this._megaCharge0 = now
			}
		}

		// ---- per-frame visuals ----
		const shown = state !== MEGA_STATE.HIDDEN
		mesh.setEnabled(shown)
		if (model && model.setEnabled) model.setEnabled(shown)
		if (!shown) return

		// slow bob + spin on the model (the placeholder box is hidden but is the
		// positioned parent; spinning the model child gives the visible motion).
		if (model) {
			model.rotation.y = (now * 0.0011) % (Math.PI * 2)
			// bob is applied to the parent mesh Y around the networked base so the
			// glow child rides with it; kept small so it never leaves the pickup radius.
			// (Networked y is fixed at the bob-base; add a gentle sine here.)
		}
		// gentle vertical bob of the whole holder around the networked base position.
		const bob = Math.sin(now * 0.0025) * 0.12
		mesh.position.y = e.y + bob

		if (state === MEGA_STATE.CHARGING) {
			// scale/fade IN over the ~5s lead so nearby players can time the grab, and
			// climb the hum's pitch/level toward the respawn moment.
			const t = Math.max(0, Math.min(1, (now - (this._megaCharge0 || now)) / (MEGA_CHARGE_LEAD_MS)))
			if (model && model.scaling) model.scaling.setAll(this._megaBaseScale(model) * (0.2 + 0.8 * t))
			if (this.audio.megaHumCharge) this.audio.megaHumCharge((1 - t) * 5)
		} else {
			// AVAILABLE: restore full scale (in case we just came back from CHARGING).
			if (model && model.scaling) model.scaling.setAll(this._megaBaseScale(model))
		}
	}

	// Pickup FF: glow every OTHER player currently holding UDamage (their networked
	// udamageTimer > 0) magenta, via a lazily-created GlowLayer (the only selective-glow
	// layer the client/babylon.js barrel re-exports). A `customEmissiveColorSelector`
	// paints only the buffed players' meshes (tracked in _udGlowMeshes) regardless of
	// their material's own emissive, so no material is mutated. The layer is created only
	// when someone is buffed and DISPOSED the moment nobody is, so there is zero glow-pass
	// cost in the common case. Reads CharacterModel.meshes read-only (no CharacterModel
	// edit). Fully cosmetic + wrapped: a failure here never affects gameplay.
	_updateBuffGlow() {
		try {
			const models = this.characterModels
			if (!this._udGlowMeshes) this._udGlowMeshes = new Set()
			const glowSet = this._udGlowMeshes

			// rebuild the set of buffed remote-player meshes this frame (membership only
			// really changes on a buff start/stop, so this is a cheap map walk).
			glowSet.clear()
			if (models) {
				for (const [nid, model] of models) {
					if (nid === this.myRawId || nid === this.mySmoothId) continue
					if (!model || !model.meshes) continue
					const ent = this.client.entities.get ? this.client.entities.get(nid) : null
					if (ent && (ent.udamageTimer || 0) > 0) model.meshes.forEach((m) => glowSet.add(m))
				}
			}

			if (glowSet.size === 0) {
				// nobody buffed — tear the layer down so its render pass stops entirely
				if (this._udGlowLayer) { this._udGlowLayer.dispose(); this._udGlowLayer = null }
				return
			}
			if (!this._udGlowLayer) {
				const scene = this.renderer && this.renderer.scene
				if (!scene) return
				this._udGlowColor = new BABYLON.Color4(0.78, 0.28, 1.0, 1)
				const layer = new BABYLON.GlowLayer('udGlow', scene, { blurKernelSize: 24 })
				layer.intensity = 1.4
				layer.customEmissiveColorSelector = (mesh, _sub, _mat, result) => {
					if (glowSet.has(mesh)) result.set(this._udGlowColor.r, this._udGlowColor.g, this._udGlowColor.b, 1)
					else result.set(0, 0, 0, 0)
				}
				this._udGlowLayer = layer
			}
		} catch (e) { /* cosmetic buff glow — never fatal */ }
	}

	// the model's authored (attach-time) uniform scale, cached the first time we see
	// it so CHARGING scale-in can lerp from it without re-measuring the bbox.
	_megaBaseScale(model) {
		if (this._megaModelScale == null && model && model.scaling) {
			this._megaModelScale = model.scaling.x
		}
		return this._megaModelScale || 1
	}

	// UT-STYLE PICKUP bookkeeping (called from the Pickup factory). We track every live
	// pickup so _updatePickups can drive its bob/spin/visibility off the networked state
	// and mirror our OWN ammo/weapon refill when we grab one — all off server-authored
	// state; the client never asserts a pickup.
	registerPickup(entity) { if (entity) { entity._lastState = -1; this._pickups.set(entity.nid, entity) } }
	unregisterPickup(nid) { this._pickups.delete(nid) }

	// CTF / DOM objective bookkeeping (called from the Flag / ControlPoint factories).
	// The entity's tinted box IS the marker; _updateObjectives recolors it off the
	// networked state/owner and drives the HUD chips. Server-authoritative — read only.
	registerFlag(entity) { if (entity) this._flags.set(entity.nid, entity) }
	unregisterFlag(nid) { this._flags.delete(nid) }
	registerControlPoint(entity) { if (entity) this._controlPoints.set(entity.nid, entity) }
	unregisterControlPoint(nid) { this._controlPoints.delete(nid) }

	// Recolor the objective markers off their networked state/owner and repaint the
	// HUD chips. Fail-soft (try/catch, like the map material hooks) — a cosmetic throw
	// must never break the frame. Cheap: the DOM chips only rebuild on a value change.
	_updateObjectives() {
		if (!this._flags.size && !this._controlPoints.size) return
		try {
			const now = performance.now()
			// CTF flag markers: team-tint pulse; brighter while CARRIED, cool white flash
			// while DROPPED (additive emissive only — no opacity, the corona lesson).
			this._flags.forEach((f) => {
				const mat = f.mat
				if (!mat || !mat.emissiveColor) return
				const red = f.team === 0
				const base = red ? [1.0, 0.15, 0.12] : [0.2, 0.45, 1.0]
				let k = 1
				if (f.state === FLAG_STATE.CARRIED) k = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.012))
				else if (f.state === FLAG_STATE.DROPPED) k = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(now * 0.02))
				mat.emissiveColor.set(base[0] * k, base[1] * k, base[2] * k)
			})
			// DOM point markers: owner tint (RED / BLUE / neutral grey).
			this._controlPoints.forEach((cp) => {
				const mat = cp.mat
				if (!mat || !mat.emissiveColor) return
				if (cp.owner === CP_OWNER.RED) mat.emissiveColor.set(1.0, 0.15, 0.12)
				else if (cp.owner === CP_OWNER.BLUE) mat.emissiveColor.set(0.2, 0.45, 1.0)
				else mat.emissiveColor.set(0.6, 0.6, 0.6)
			})
			this._paintObjectiveHud()
		} catch (e) { /* cosmetic-only: never break the frame */ }
	}

	// Paint the flag / point HUD chips near the scoreboard off the live objective
	// entities + the networked MatchState mode. Rebuilds the chip row only when a
	// value changes (signature compare) so it's near-free per frame.
	_paintObjectiveHud() {
		const host = document.getElementById('objective-hud')
		if (!host) return
		const ms = this._matchState
		const mode = ms ? (ms.mode | 0) : -1
		let sig = mode + '|'
		if (mode === MATCH_MODE.CTF) {
			const flags = [...this._flags.values()].sort((a, b) => a.team - b.team)
			sig += flags.map((f) => f.team + ':' + f.state).join(',')
		} else if (mode === MATCH_MODE.DOM) {
			const cps = [...this._controlPoints.values()].sort((a, b) => a.index - b.index)
			sig += cps.map((c) => c.index + ':' + c.owner).join(',')
		}
		if (sig === this._objHudSig) return
		this._objHudSig = sig

		if (mode === MATCH_MODE.CTF && this._flags.size) {
			const flags = [...this._flags.values()].sort((a, b) => a.team - b.team)
			const stName = ['HOME', 'HELD', 'DROP']
			host.innerHTML = flags.map((f) => {
				const team = f.team === 0 ? 'red' : 'blue'
				const label = f.team === 0 ? 'RED' : 'BLU'
				const st = stName[f.state] || 'HOME'
				return `<span class="obj-chip obj-${team} obj-${st.toLowerCase()}"><b>${label}</b><i>${st}</i></span>`
			}).join('')
			host.dataset.mode = 'ctf'
			host.setAttribute('aria-hidden', 'false')
		} else if (mode === MATCH_MODE.DOM && this._controlPoints.size) {
			const cps = [...this._controlPoints.values()].sort((a, b) => a.index - b.index)
			const letter = ['A', 'B', 'C', 'D', 'E']
			host.innerHTML = cps.map((c) => {
				const own = c.owner === CP_OWNER.RED ? 'red' : c.owner === CP_OWNER.BLUE ? 'blue' : 'neutral'
				return `<span class="obj-chip obj-${own}"><b>${letter[c.index] || (c.index + 1)}</b></span>`
			}).join('')
			host.dataset.mode = 'dom'
			host.setAttribute('aria-hidden', 'false')
		} else {
			host.dataset.mode = 'none'
			host.setAttribute('aria-hidden', 'true')
			host.innerHTML = ''
		}
	}

	// A server ObjectiveEvent (CTF/DOM): a killfeed line + an existing announcer clip
	// (no new SFX in v1). team/kind are server enums — the text is built client-side
	// (never from untrusted input). Presentation only; scores flow through MatchState.
	_onObjectiveEvent(m) {
		const teamName = (m.team | 0) === 0 ? 'RED' : 'BLUE'
		let text = null, clip = null
		switch (m.kind | 0) {
			case OBJECTIVE_EVENT.FLAG_TAKEN: text = `${teamName} FLAG TAKEN`; clip = 'flag_taken'; break
			case OBJECTIVE_EVENT.FLAG_DROPPED: text = `${teamName} FLAG DROPPED`; break
			case OBJECTIVE_EVENT.FLAG_RETURNED: text = `${teamName} FLAG RETURNED`; clip = 'flag_returned'; break
			case OBJECTIVE_EVENT.FLAG_CAPTURED: text = `${teamName} SCORES`; clip = 'flag_captured'; break
			case OBJECTIVE_EVENT.DOM_CAPTURED: text = `${teamName} TAKES A POINT`; clip = 'point_captured'; break
		}
		if (text && this.fragLayer && this.fragLayer.pushObjectiveFeed) this.fragLayer.pushObjectiveFeed(text)
		if (clip && this.audio) this.audio.announce(clip, { gain: 0.9, minGap: 0.2 })
	}

	// Presentation + local-refill mirror for every live pickup. Reacts to the networked
	// `state` (AVAILABLE→visible+bob+spin, HIDDEN→off). On the AVAILABLE→HIDDEN grab
	// transition, if WE were the one in range, mirror the server's grant into our
	// predicted inventory so client prediction (HUD + weapon.fire gating) stays aligned:
	//   • WEAPON grabs are handled by _syncOwnershipRefill (ownedWeapons is networked).
	//   • AMMO grabs top up the mapped weapon's reserve here (ammo is NOT networked, so
	//     the pickup's own state transition + our proximity is the signal).
	// Health needs nothing (hitpoints is networked). Server-authoritative throughout.
	_updatePickups() {
		if (!this._pickups.size) return
		const now = performance.now()
		const me = this.myRawEntity
		const R2 = PICKUP_RADIUS * PICKUP_RADIUS
		this._pickups.forEach((e) => {
			const mesh = e.mesh
			if (!mesh || (mesh.isDisposed && mesh.isDisposed())) return
			const state = e.state
			if (state !== e._lastState) {
				const prev = e._lastState
				e._lastState = state
				// grab: AVAILABLE → HIDDEN. Mirror an AMMO top-up if we were in range.
				if (prev === MEGA_STATE.AVAILABLE && state === MEGA_STATE.HIDDEN &&
					e.type === PICKUP_TYPE.AMMO && me) {
					const dx = me.x - e.x, dy = me.y - e.y, dz = me.z - e.z
					if (dx * dx + dy * dy + dz * dz <= R2) {
						const wi = e.weaponIndex
						const owns = me.ownedWeapons === undefined || (me.ownedWeapons & (1 << wi))
						if (owns && me.weaponsState && me.weaponsState[wi]) {
							me.weaponsState[wi].reserveAmmo = weapons[wi].maxReserveAmmo
							// ammo grab: SOFT cue only — no toast, no auto-switch (those are for NEW
							// weapons, handled by _syncOwnershipRefill off the ownedWeapons diff).
							this.audio.ammoPickup()
						}
					}
				}
			}
			const shown = state !== MEGA_STATE.HIDDEN
			mesh.setEnabled(shown)
			const model = e._pickupModel
			if (model && model.setEnabled) model.setEnabled(shown)
			if (e._pedestal && e._pedestal.setEnabled) e._pedestal.setEnabled(shown)
			if (!shown) return
			// PICKUP MOTION (#38): ONLY health floats. Health bobs + slow-spins as its
			// grab-me tell; weapons, ammo, armor and powerups rest FLAT on the floor with
			// NO spin and NO bob (walks back the old weapon spin + consumable bob).
			if (e.type === PICKUP_TYPE.HEALTH) {
				if (model) model.rotation.y = (now * 0.0011) % (Math.PI * 2)
				const bob = Math.sin(now * 0.0025 + (e.nid || 0)) * 0.1
				mesh.position.y = e.y + bob
			} else {
				if (model) model.rotation.y = 0
				mesh.position.y = e.y
			}
		})
	}

	// Mirror a WEAPON grant into our predicted inventory: ownedWeapons is networked, so
	// when the server sets a new bit we see it here and refill THAT weapon locally (mag +
	// reserve) — matching what the server did on grant — so client fire()/switch gating
	// and the HUD immediately treat the new weapon as usable. Idempotent; the diff fires
	// only on the tick a bit newly appears.
	_syncOwnershipRefill() {
		const e = this.myRawEntity
		if (!e || e.ownedWeapons === undefined) return
		if (this._lastOwned === undefined) { this._lastOwned = e.ownedWeapons; return }
		const gained = e.ownedWeapons & ~this._lastOwned
		if (gained && e.weaponsState) {
			// Feedback for EVERY newly-gained weapon (map pickups AND drop-on-death grabs —
			// both arrive as the same ownedWeapons diff, so both are covered here). Track the
			// highest-priority new weapon for the UT-style auto-switch below. Ammo-only grabs
			// never flip a bit, so they get NEITHER the toast nor the auto-switch (their soft
			// cue lives in _updatePickups' AMMO branch).
			let bestGained = -1
			for (let i = 0; i < weapons.length; i++) {
				if ((gained & (1 << i)) && e.weaponsState[i]) {
					e.weaponsState[i].magazineAmmo = weapons[i].magazineCapacity
					e.weaponsState[i].reserveAmmo = weapons[i].maxReserveAmmo
					this.audio.weaponPickup()                       // soft procedural acquire blip
					if (this.fragLayer) this.fragLayer.showPickupToast(weapons[i].name) // "+ RIFLE" toast
					if (bestGained < 0 || this._weaponPriority(i) > this._weaponPriority(bestGained)) bestGained = i
				}
			}
			// UT-STYLE AUTO-SWITCH: hop to the newly-gained weapon iff it OUT-RANKS what we
			// currently hold AND the fire trigger is NOT held (never yank the gun mid-burst).
			// Routes through switchWeapon() — the SAME prediction + SwitchWeaponCommand path a
			// manual 1-5 / wheel switch uses (no local-only hack). switchWeapon() itself no-ops
			// if we somehow don't own it, so this can never equip a greyed slot.
			if (bestGained >= 0 && !this._fireHeld() &&
				this._weaponPriority(bestGained) > this._weaponPriority(this.weaponIndex)) {
				this.switchWeapon(bestGained)
			}
		}
		this._lastOwned = e.ownedWeapons
	}

	// Roster priority for the pickup auto-switch. weaponsConfig carries no explicit
	// priority field, so INDEX ORDER is the ranking (bigger index = bigger gun) — EXCEPT
	// the spawn pistol, which is always LOWEST so you upgrade off it onto anything. Disabled
	// slots never get granted, so they never reach this.
	_weaponPriority(i) {
		return i === SPAWN_WEAPON_INDEX ? -1 : i
	}

	// Is the local fire trigger held THIS frame? Reads the same flag the per-frame
	// MoveCommand reads (frameState.mouseDown — mirrored from the held pointer state by
	// InputSystem.releaseKeys each frame; TouchControls sets it too), so auto-switch and
	// the fire command always agree on "trigger down".
	_fireHeld() {
		return !!(this.input && this.input.frameState && this.input.frameState.mouseDown)
	}

	// Does the local player own weapon `i`? Undefined mask (pre-Identity) = own all, so
	// nothing is falsely locked before the first snapshot arrives.
	_ownsWeapon(i) {
		const ow = this.myRawEntity ? this.myRawEntity.ownedWeapons : undefined
		return ow === undefined || (ow & (1 << i)) !== 0
	}

	// Can the local player cycle-select weapon `i`? It must be OWNED and NOT `disabled`
	// (a disabled roster entry — Plasma/Flak — keeps its slot for protocol stability but
	// is never a valid swap target). Single source of truth for every cycle path (Q,
	// mouse-wheel, mobile swap button) so they all skip the same slots.
	_selectableWeapon(i) {
		return this._ownsWeapon(i) && !(weapons[i] && weapons[i].disabled)
	}

	// Cycle to the next SELECTABLE weapon in `dir` (+1 / -1), skipping BOTH unowned and
	// disabled slots. Used by Q / mouse-wheel / the mobile swap button so a greyed or
	// disabled weapon is simply passed over instead of stalling the cycle on it.
	_cycleWeapon(dir) {
		const n = weapons.length
		for (let step = 1; step <= n; step++) {
			const idx = (((this.weaponIndex + dir * step) % n) + n) % n
			if (this._selectableWeapon(idx)) { this.switchWeapon(idx); return }
		}
	}

	// equip weapon by index (wraps around); updates the on-screen weapon name
	switchWeapon(index) {
		const n = weapons.length
		index = ((index % n) + n) % n
		if (index === this.weaponIndex) return
		// UT-STYLE OWNERSHIP: refuse selecting a weapon we don't own (the server's switch
		// gate rejects it anyway; refusing locally keeps the HUD/viewmodel honest). Unowned
		// weapons thus read as "greyed" — unselectable until picked up.
		if (!this._ownsWeapon(index)) return
		// swap accepted (past the same-weapon / normalized-index guards): play the
		// swap clack. weaponSwap() self-throttles so scroll-cycling can't spam it.
		this.audio.weaponSwap()
		this.weaponIndex = index
		// force a fresh aim press on the new weapon (don't inherit held ADS) AND snap
		// the camera to hip INSTANTLY — never show a half-zoomed newly-equipped gun
		// (the swap "sleeper" bug from the id review). _adsT is a global player state,
		// not per-weapon, so this is a clean hard reset.
		this._adsSuppressUntilRelease = true
		this._adsT = 0
		this._queueViewmodelSwap(index)
		this._pumpDip = null // drop any pending pump-dip so it can't fire on the new gun

		if (this.myRawEntity) {
			this.myRawEntity.currentWeaponIndex = index
			// swap commitment: lock firing for this weapon's drawTime so the local
			// predicted view stops firing immediately on keypress (weapon.fire() gates
			// on equipTimer). The server sets the same lock via SwitchWeaponCommand.
			this.myRawEntity.equipTimer = (weapons[index] && weapons[index].drawTime) || 0
			this.client.addCommand(new SwitchWeaponCommand(index))
		}

		this._updateDevInspectorInputs()

		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[index].name.toUpperCase()

		// swap the crosshair reticle to this weapon + resize its static parts
		// (shotgun ring radius). data-weapon drives per-weapon CSS group visibility.
		this._applyCrosshairWeapon(index)
		// swap the Halo ammo-HUD weapon silhouette to match (presentation only)
		this._applyWeaponIcon(index)
	}

	// set the Halo ammo-HUD weapon silhouette for `index`. Mirrors how the
	// crosshair sets data-weapon: #weapon-panel[data-weapon] drives a CSS mask
	// swap (public/assets/hud/weap-*.svg). Client-only presentation — does NOT
	// touch ammo logic; Simulator._updateHud still owns the counts.
	_applyWeaponIcon(index) {
		const el = this._weaponPanelEl ||
			(this._weaponPanelEl = document.getElementById('weapon-panel'))
		if (!el) return
		el.setAttribute('data-weapon', String(index))
	}

	// ---- Per-weapon, spread-reactive crosshair (client-only presentation). ----
	// The reticle is the inline #crosshair SVG. data-weapon picks the shape; the
	// dynamic tick gap (rifle/smg) and the shotgun ring radius are driven from the
	// SAME spread math the fire ray uses (common/firePattern.js), converted to pixels
	// with the LIVE render FOV so the reticle is honest at any FOV/resolution.

	// px-per-radian at the current viewport + camera FOV. Vertical-FOV mapping:
	// a spread angle θ maps to (viewportH/2) * θ / tan(fov/2) px on screen. Read
	// live so FOV-slider changes and window resizes stay honest.
	_crosshairPxPerRad() {
		const h = (this.renderer.engine && this.renderer.engine.getRenderHeight)
			? this.renderer.engine.getRenderHeight()
			: window.innerHeight
		const fov = this.renderer.camera.fov || 1.0
		return (h / 2) / Math.tan(fov / 2)
	}

	// set the reticle shape for `index` and size its static parts (shotgun ring).
	_applyCrosshairWeapon(index) {
		const el = this._crosshairEl || (this._crosshairEl = document.getElementById('crosshair'))
		if (!el) return
		el.setAttribute('data-weapon', String(index))
		const w = weapons[index]
		if (w && w.pellets && w.pellets > 1) {
			// shotgun: draw the ring at the true pellet-cone angle (ringRadius rad)
			const ringPx = (w.ringRadius || 0.05) * this._crosshairPxPerRad()
			el.style.setProperty('--xhair-ring', ringPx.toFixed(1) + 'px')
		}
		// reset the dynamic gap so a switch away from a hot weapon doesn't leave a
		// stale wide gap for a frame (the per-frame update overwrites it live anyway)
		el.style.setProperty('--xhair-spread', '4px')
		this._lastXhairGap = null
	}

	// per-frame: push the client-predicted spread (gap px) into the reticle. Uses
	// firePattern's exact spread formula (spreadBase + spreadHeat*clamp(heat)); only
	// writes when the value actually changes (pistol/shotgun with heat 0 pay nothing).
	_updateCrosshairSpread() {
		const el = this._crosshairEl
		if (!el || !this.myRawEntity) return
		const w = weapons[this.weaponIndex]
		if (!w || (w.pellets && w.pellets > 1)) return // shotgun ring is static
		const state = this.myRawEntity.weaponsState && this.myRawEntity.weaponsState[this.weaponIndex]
		const heat = state ? (state.heat || 0) : 0
		// identical to common/firePattern.js:55 (single-pellet spread)
		const spreadNow = (w.spreadBase || 0) + (w.spreadHeat || 0) * Math.min(1, Math.max(0, heat))
		// per-weapon readability floor for the gap (proposal §2): pistol/rifle 4px, smg 6px
		const minGap = w.name === 'SMG' ? 6 : 4
		const gap = Math.max(minGap, spreadNow * this._crosshairPxPerRad())
		const rounded = Math.round(gap * 10) / 10
		if (rounded === this._lastXhairGap) return
		this._lastXhairGap = rounded
		el.style.setProperty('--xhair-spread', rounded + 'px')
	}

	_queueViewmodelSwap(index) {
		const requestId = ++this._viewmodelSwapId

		// GLB imports cannot be cancelled. Serialize swaps so an old rig finishes
		// disposing before the newest one starts, and skip requests superseded by
		// another wheel notch while cleanup was in flight.
		this._viewmodelSwapQueue = this._viewmodelSwapQueue
			.then(async () => {
				if (requestId !== this._viewmodelSwapId) return

				const previous = this.viewmodel
				this.viewmodel = null
				if (previous) await previous.dispose()

				if (requestId !== this._viewmodelSwapId) return

				const next = new Viewmodel(this.renderer.scene, this.renderer.camera, weapons[index])
				this.viewmodel = next
				next.setActive(!this.myRawEntity || this.myRawEntity.isAlive !== false)
			})
			.catch((error) => {
				console.error('Unable to switch viewmodel:', error)
			})
	}

	_setupWeaponSwitching() {
		document.addEventListener('keydown', (e) => {
			if (!this.input.pointerLocked) return
			if (e.code >= 'Digit1' && e.code <= 'Digit9') {
				const slot = parseInt(e.code.slice(5), 10) - 1
				if (slot < weapons.length) this.switchWeapon(slot) // direct-select: refused if unowned
			} else if (e.key === 'q' || e.key === 'Q') {
				this._cycleWeapon(1) // cycle to the next OWNED weapon (skips unowned)
			}
		})
		document.addEventListener('wheel', (e) => {
			if (!this.input.pointerLocked) return
			this._cycleWeapon(e.deltaY > 0 ? 1 : -1) // cycle over OWNED weapons only
		})
		const el = document.getElementById('weapon-name')
		if (el) el.textContent = weapons[this.weaponIndex].name.toUpperCase()

		// initial spawn: set the crosshair to the starting weapon so the first
		// reticle is correct before any switch (matches the initial this.weaponIndex)
		this._applyCrosshairWeapon(this.weaponIndex)
		// same for the Halo ammo-HUD weapon icon (presentation only)
		this._applyWeaponIcon(this.weaponIndex)

		// keep the shotgun ring honest across window resize / FOV changes
		window.addEventListener('resize', () => this._applyCrosshairWeapon(this.weaponIndex))
	}

	update(delta) {
		const input = this.input.frameState
		// one-shot flags must be read BEFORE releaseKeys — `input` is a live
		// reference to frameState and releaseKeys clears them in place
		const dodge = input.dodge
		this.input.releaseKeys()

		// MENU SAFETY deploy retry: a pending deploy intent with no entity yet is
		// re-sent every 3.5s (just past the server's 3s rate limit) — covers a
		// request that raced a map-rotation restart or got dropped by the limiter.
		if (this._deployRequestedAt && !this.myRawEntity
			&& this._connectionState === 'connected'
			&& Date.now() - this._deployRequestedAt > 3500) {
			this._deployRequestedAt = 0
			this.requestDeploy()
		}

		/* all of this is just for our own entity */
		if (this.myRawEntity) {
			if (!this._initialServerSyncDone) {
				this._initialServerSyncDone = true
				if (this.devToolsEnabled) this._syncWeaponsConfigToServer()
			}

			// AIM-SAFETY (mirror of FragLayer.applyDeathCamera): remove last frame's
			// VISUAL recoil rotation offset from the camera BEFORE reading the aim ray,
			// so getForwardRay() (used for BOTH the MoveCommand aim and the fire ray)
			// sees the player's TRUE orientation. The offset is re-applied further down,
			// AFTER the command + fire prediction are built. Tracked (not a bare +=) so
			// it never compounds into aim. Death-cam runs LAST, unchanged.
			const cam = this.renderer.camera
			cam.rotation.x -= this._recoilApplied.x
			cam.rotation.y -= this._recoilApplied.y
			cam.rotation.z -= this._recoilApplied.z
			this._recoilApplied.set(0, 0, 0)

			// which way are we pointing?
			const camRay = this.renderer.camera.getForwardRay().direction

			/* begin movement */
			const { forwards, left, backwards, right, jump } = input

			// ADS held-aim intent for BOTH the networked command (gameplay accuracy) and
			// the local presentation below — computed ONCE so they never disagree. Clear
			// the post-swap suppression once aim is released; a dodge descopes instantly
			// and re-suppresses (Hale: dodge-descope, no move-speed penalty).
			if (this._adsSuppressUntilRelease && !input.aimDown) this._adsSuppressUntilRelease = false
			if (dodge) this._adsSuppressUntilRelease = true
			const _wcfg = weapons[this.weaponIndex]
			const aimHeld = !!(_wcfg && _wcfg.ads) && input.aimDown && !this._adsSuppressUntilRelease &&
				!this.myRawEntity.weaponsState[this.weaponIndex].reloading && !this._wasDead

			const command = new MoveCommand({
				camRayX: camRay.x,
				camRayY: camRay.y,
				camRayZ: camRay.z,
				forwards, backwards, left, right, jump,
				dodge: dodge ? DODGE_DIRS[dodge] : 0,
				weaponIndex: this.weaponIndex,
				reload: input.reload && !this._reloadHeld,
				fireInput: input.mouseDown,
				aimInput: aimHeld,
				// Phase 3: edge-triggered frag-grenade throw (only the rising edge — so
				// holding G doesn't dump both charges). Same pattern as reload above.
				throwInput: input.throwInput && !this._throwHeld,
				delta
			})
			// send command to the server
			this.client.addCommand(command)

			const wasReloading = this.myRawEntity.weaponsState[this.weaponIndex].reloading
			// captured BEFORE applyCommand: the interrupt path (applyCommand.js:153-156)
			// fires only when the player shoots mid-reload with ammo already chambered.
			const magBeforeApply = this.myRawEntity.weaponsState[this.weaponIndex].magazineAmmo

			// predict our own movement locally (runs the exact same logic as the server)
			applyCommand(this.myRawEntity, command, this.obstacles)

			// Reload ended this tick. Distinguish a GENUINE INTERRUPTION (fire-while-
			// reloading with ammo — applyCommand.js:153-156) from a NATURAL COMPLETION
			// (timer expiry). Only the interrupt takes the cancel/snap path (which hard-
			// snaps the rig to the reload clip's first frame, detaching the hands). On a
			// natural completion we do NOTHING: the stretched visual clip plays out and
			// self-hands-off to idle via its own end callback (Viewmodel.js:335-338),
			// blending invisibly from the clip's final (~base) pose.
			if (wasReloading && !this.myRawEntity.weaponsState[this.weaponIndex].reloading) {
				const wasInterrupted = command.fireInput && magBeforeApply > 0
				if (wasInterrupted && this.viewmodel) this.viewmodel.cancelReload()
			}

			// Handle visual reload start if state.reloading became true (covers manual and auto-reload)
			if (!wasReloading && this.myRawEntity.weaponsState[this.weaponIndex].reloading) {
				if (this.viewmodel) this.viewmodel.reload()
				// layered reload SFX sequenced to this weapon's reloadTime
				this.audio.reload(this.weaponIndex, weapons[this.weaponIndex].reloadTime)
			}

			// UT LIFT CARRY: post-sim platform clamp on our OWN predicted entity, against
			// the INTERPOLATED mover position (server runs the identical idempotent clamp
			// in GameInstance). Runs BEFORE the prediction snapshot so a rest-state ride
			// predicts byte-for-byte with the server (no spurious reconcile); during the
			// ~1.75 s ride the interp platform lags the server ~one window, so the ride
			// reconciles — the documented, accepted desync tradeoff. Fail-soft.
			this._carryClampSelf()

			// store state for reconciliation (in case the server disagrees later)
			const prediction = {
				x: this.myRawEntity.x,
				y: this.myRawEntity.y,
				z: this.myRawEntity.z,
				velX: this.myRawEntity.velX,
				velY: this.myRawEntity.velY,
				velZ: this.myRawEntity.velZ
			}
			this.client.addCustomPrediction(this.client.tick, prediction, ['x', 'y', 'z', 'velX', 'velY', 'velZ'])

			// move the camera to our entity, then add the AIM-SAFE recoil kick as a
			// position-only offset. Because camera.position is re-based from the entity
			// every frame, the kick self-clears and never accumulates into the aim.
			Object.assign(this.renderer.camera.position, this.myRawEntity.mesh.position)
			this._springCameraRecoil(delta)
			this.renderer.camera.position.addInPlace(this._camKick)

			const state = this.myRawEntity.weaponsState[this.weaponIndex]
			this._reloadHeld = input.reload
			// grenade-throw whoosh on the rising edge, only when a charge is available
			if (input.throwInput && !this._throwHeld && (this.myRawEntity.grenadeCharges || 0) > 0) this.audio.grenadeThrow()
			this._throwHeld = input.throwInput

			/* shooting (blocked while the reload animation runs) */
			if (input.mouseDown && !state.reloading) {
				const ray = fire(this.myRawEntity)
				// empty-mag dry-fire click (self-throttled). fire() returns null both on
				// an empty magazine and on fire-rate cooldown, so gate on ammo to avoid
				// clicking between live shots while the trigger is held.
				if (!ray && state.magazineAmmo <= 0) this.audio.dryFire()
				if (ray) {
					// send shot to the server
					this.client.addCommand(new FireCommand())

					// our own tracer + flash originate at the BARREL TIP so the shot
					// visibly leaves the gun (the ray itself — and the server's hit
					// check — still starts at the entity; this is presentation only)
					const muzzle = this.viewmodel ? this.viewmodel.muzzleWorldPos() : null
					const ox = muzzle ? muzzle.x : this.myRawEntity.x
					const oy = muzzle ? muzzle.y : this.myRawEntity.y
					const oz = muzzle ? muzzle.z : this.myRawEntity.z
					const fx = resolveWeaponFx(weapons[this.weaponIndex])

					// Predicted shot: fire() attached the same seed/heat the server will
					// derive for this shot, so the pattern we paint (every pellet's
					// tracer + wall mark) IS the server's damage pattern — instant
					// feedback, no round trip. Flesh hits flash the predicted marker.
					if (ray.config.type === 'hitscan') {
						const offsets = shotPattern(ray.config, ray.seed, ray.heat, ray.aimFactor)
						const maxTracers = (fx.tracer && fx.tracer.pelletTracers) || offsets.length
						// Match the server's hitscan cutoff EXACTLY so a predicted wall mark only
						// appears where the server would score a hit: server/GameInstance.js performShot
						// uses reach = max(range, ADS-extended falloffEnd) via the SAME
						// common/damageFalloff.js falloffRange helper imported here (no duplicated math,
						// so client and server cannot drift). ray.aimFactor is the live ADS ramp this
						// shot fired with (extends the Pistol's reach past its range) — the same value
						// the server derives.
						const reach = Math.max(ray.config.range || 0,
							falloffRange(ray.config, ray.aimFactor).end) || Number.MAX_VALUE
						let hitFlesh = false
						offsets.forEach((off, i) => {
							const d = applyPattern(
								{ x: ray.direction.x, y: ray.direction.y, z: ray.direction.z }, off)
							const info = this.renderer.drawHitscan(
								{ x: ox, y: oy, z: oz, tx: d.x, ty: d.y, tz: d.z },
								{ fx, muzzle: false, tracer: i < maxTracers, reach }
							)
							if (info && info.hit && info.surface === 'flesh') hitFlesh = true
						})
						if (hitFlesh) {
							// heavy-tier marker for high per-shot damage (pistol single crack /
							// shotgun rosette). READ-ONLY use of the balance value for a visual
							// tier — never fed back into the ray. Shotgun (pellets>1) always heavy.
							const w = weapons[this.weaponIndex]
							const heavy = !!(w && ((w.pellets && w.pellets > 1) || (w.damage || 0) >= 20))
							this._showHitMarker(false, heavy)
							this.audio.hitMarker(false)
							// layer a meaty flesh thud under the crisp UI marker (sound
							// coherence is a top "did it land?" cue) + a tiny aim-safe punch.
							// Once per shot (hitFlesh collapses all pellets), so no double-fire.
							this.audio.impact('flesh', { distance: 0 })
							this._applyConfirmKick()
						}
					}
					// flash on the VIEWMODEL layer so the gun can't paint over it
					this.renderer.flashMuzzle(muzzle, fx, { vmLayer: true })
					this._spawnCasing(fx.eject)

					// one synchronized shot event: layered weapon audio + aim-safe camera
					// kick + procedural weapon recoil animation, all on this frame.
					this.audio.fire(this.weaponIndex, fx.report, { distance: 0 })
					if (fx.vmKick && fx.vmKick.pump) this.audio.pump(fx.vmKick.pump.delay / 1000)
					this._applyCameraRecoil(fx.recoil)
					// VISUAL camera recoil impulse (Layer B). ray.heat is this shot's
					// pre-bump heat (the same value the server charges spread with — see
					// weapon.js fire()), so the felt climb mirrors the accuracy penalty.
					// The offset is only APPLIED to the camera after this whole block, and
					// is removed before next frame's getForwardRay() — so aim is untouched.
					this._applyCamRecoil(fx.camKick, ray.heat)
					if (this.viewmodel) this.viewmodel.kick(fx.vmKick)
				}
			}

			// bob the equipped weapon each frame (based on movement)
			// ADS presentation: reuse the SAME held-aim intent that went into the command
			// (aimHeld) so gameplay accuracy and the visuals never disagree; the viewmodel
			// additionally needs its baked ADS clips (hasAds). Eases _adsT, which the
			// composed FOV + sensitivity + holder mount read. Pure presentation — the aim
			// ray + MoveCommand were already committed above from the recoil-free camera.
			const wcfg = _wcfg
			const adsWant = aimHeld && !!(this.viewmodel && this.viewmodel.hasAds)
			if (this.viewmodel) this.viewmodel.setAim(adsWant)
			const adsTime = (wcfg.ads ? (adsWant ? wcfg.ads.inTime : wcfg.ads.outTime) : 0.18) || 0.0001
			this._adsT = adsWant
				? Math.min(1, this._adsT + delta / adsTime)
				: Math.max(0, this._adsT - delta / adsTime)

			if (this.viewmodel) this.viewmodel.update(delta, forwards || backwards || left || right, this._adsEase(this._adsT || 0))

			// VISUAL camera recoil, applied AFTER the fire ray + MoveCommand aim were
			// read (above) and after prediction — so the render picture shows the kick
			// while the shot bytes stayed byte-identical. Integrate the spring now; the
			// PITCH(x)/YAW(y) offsets (the two that affect getForwardRay) are added here
			// and remembered in _recoilApplied so next frame removes exactly this much
			// before reading the aim (never compounds). The pitch offset is the spring
			// KICK displacement PLUS the sustained-fire CLIMB lean (_visClimb, degrees →
			// radians): climb is an UPWARD lean, and pitch-up is NEGATIVE rotation.x, so
			// climb SUBTRACTS from x. Because it's baked into appliedX (and recorded in
			// _recoilApplied.x), the top-of-frame remove strips it too → aim stays true.
			// The ROLL(z) is applied AFTER the death-cam below (which assigns rotation.z
			// each frame and would clobber it) and records its OWN _recoilApplied.z there.
			// shotgun/flak pump-dip frame-clock timer (replaces a wall-clock setTimeout):
			// count down in real frame time, then inject a small downward nod into the
			// spring. Cleared on weapon swap so it can't fire on the wrong gun.
			if (this._pumpDip) {
				this._pumpDip.t -= delta
				if (this._pumpDip.t <= 0) {
					this._recoilVel.x += this._pumpDip.vel // pitch DOWN = +x
					this._pumpDip = null
				}
			}
			this._springCamRecoil(delta)
			const DEG = Math.PI / 180
			const appliedX = this._recoil.x - this._visClimb * DEG
			const appliedY = this._recoil.y
			cam.rotation.x += appliedX
			cam.rotation.y += appliedY
			this._recoilApplied.x = appliedX
			this._recoilApplied.y = appliedY
			// _recoilApplied.z is set in the roll block below (post-death-cam), matching
			// exactly what was applied (0 when the death-cam owns the roll) — see FIX 4.
			// transient shotgun FOV concussion punch (world camera only; aim-safe).
			this._applyRecoilFov()
		}

		// spatial-audio listener sync: place the WebAudio listener at the camera and
		// orient it down the view forward/up so panned (remote) voices resolve to the
		// right side/direction. Cheap; no-ops before the audio ctx is live (guarded in
		// updateListener). Basis is read from the camera matrix exactly like _spawnCasing.
		if (this.audio && this.audio.ready) {
			const cm = this.renderer.camera.getWorldMatrix()
			const lpos = this.renderer.camera.position
			// TransformNormalToRef into pooled scratch (no per-frame Vector3 alloc).
			BABYLON.Vector3.TransformNormalToRef(this._FWD, cm, this._lfwdScratch)
			BABYLON.Vector3.TransformNormalToRef(this._UP, cm, this._lupScratch)
			this.audio.updateListener(lpos, this._lfwdScratch, this._lupScratch)
		}

		// drive other players' character visuals (position/yaw follow + idle/run anim)
		// + teleport tell: a per-frame position discontinuity > 8m on a remote body
		// can only be a portal or a respawn (max legit speed is ~11 m/s), so pop a
		// cheap additive burst at BOTH ends of the jump. Tracked here (not in
		// CharacterModel) because the burst needs the renderer's pooled FX.
		this.characterModels.forEach(model => {
			const host = model.host
			if (host && model.ready) {
				const p = host.position
				const prev = model._telePrev
				if (prev && host.isAlive !== false) {
					const jump = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)
					if (jump > 8) {
						this.renderer.teleportBurst(new BABYLON.Vector3(prev.x, prev.y + 0.9, prev.z))
						this.renderer.teleportBurst(new BABYLON.Vector3(p.x, p.y + 0.9, p.z))
					}
				}
				model._telePrev = { x: p.x, y: p.y, z: p.z }
			}
			model.update(delta)
		})

		// orient + stretch live plasma bolts into hot travel streaks
		this._updateProjectiles(delta)

		// blink live frag grenades' arming light (accelerating toward the fuse)
		this._updateGrenades()

		// Phase 4: mega-health pickup bob/spin/glow + hum tell (off networked state)
		this._updateMegaHealth()

		// Pickup FF: outline OTHER players who hold the UDamage buff (off their networked
		// udamageTimer). Cheap — a lazily-created HighlightLayer whose membership only
		// changes on a buff start/stop (tracked in _udGlowNids), not per frame.
		this._updateBuffGlow()

		// UT-STYLE PICKUPS: mirror our own weapon/ammo refill off networked state
		// (ownedWeapons + pickup transitions), then bob/spin the visible items.
		this._syncOwnershipRefill()
		this._updatePickups()
		this._updateObjectives()

		// advance kill-feedback FX (corpses, gibs, damage arc). Runs after the
		// character models are driven so a corpse's frozen pose isn't re-overridden.
		this.fragLayer.update(delta)

		// apply the own-death camera drop/roll LAST — after all aim + fire logic has
		// read the camera this frame — so the cosmetic roll never rotates the shot
		// ray or the MoveCommand aim the server judges shots with.
		this.fragLayer.applyDeathCamera()

		// recoil ROLL, applied after the death-cam has set rotation.z for this frame.
		// Record _recoilApplied.z to EXACTLY what we add here so the top-of-frame remove
		// subtracts precisely what was applied. When the death-cam owns the roll we skip
		// the add AND set applied.z = 0 — otherwise removing a z that was never added
		// leaked a persistent roll on death-cam frames (Bug D).
		if (this.myRawEntity && !(this.fragLayer._deathCam && this.fragLayer._deathCam.active)) {
			this.renderer.camera.rotation.z += this._recoil.z
			this._recoilApplied.z = this._recoil.z
		} else {
			this._recoilApplied.z = 0
		}

		this._updateCrosshairSpread()
		this._updateHud()
		this._updateSpawnShield()
		// nerdy LED loading readout: ease the shown value toward the blended gate
		// target and paint the menu header + splash echo (runs every frame regardless
		// of whether we've entered the arena; no-ops cheaply once READY).
		if (this._progress) this._progress.update(delta)
		this.renderer.update()
	}

	setConnectionState(state) {
		this._connectionState = state
		// MENU SAFETY: the server no longer creates our entity on connect, so the
		// old "arena ready" signal (own raw entity created — createPlayerFactory)
		// can't fire before PLAY anymore. An ACCEPTED SOCKET is the new server-side
		// gate: the world/assets halves keep their own flags (_assetsReady).
		if (state === 'connected') this.setArenaReady()
		const body = document.body
		body.classList.remove('connection-connecting', 'connection-connected', 'connection-disconnected')
		body.classList.add(`connection-${state}`)

		const label = document.getElementById('connection-label')
		if (label) {
			label.textContent = state === 'connected'
				? 'ONLINE'
				: state === 'disconnected' ? 'OFFLINE' : 'CONNECTING'
		}

		// bit 8: status-color law — drive .match-strip[data-state] so the strip color
		// (green=online / amber-pulse=connecting / red-pulse=offline) reads at a glance,
		// no text parse needed. Map our internal states to the contract vocabulary.
		// Element owned by the HTML agent — guard for null.
		const matchStrip = document.querySelector('.match-strip')
		if (matchStrip) {
			matchStrip.dataset.state = state === 'connected'
				? 'online'
				: state === 'disconnected' ? 'offline' : 'connecting'
		}
		// #ping-ms is driven per-frame in _updateHud from nengi's client.averagePing
		// (RTT via the framework's Ping/Pong timesync) — not here, since latency updates
		// continuously rather than only on connection-state changes.

		if (state === 'disconnected') {
			this._deployRequestedAt = 0 // stale deploy intent dies with the socket
			const wasInArena = this._arenaEntered
			this._arenaEntered = false
			body.classList.remove('arena-entered')
			const overlay = document.getElementById('entry-overlay')
			if (overlay) overlay.classList.add('is-visible')
			this._closeSettings()
			if (document.pointerLockElement) document.exitPointerLock()
			this.music.play('menu') // back on the entry screen -> menu theme
			if (wasInArena) {
				// MAP ROTATION (Overwatch-style): the server rotates maps by closing the
				// socket + restarting. A drop AFTER entry = a rotation, not a failure —
				// show the CHANGING MAP interstitial and reload with the rejoin flag.
				this._beginMapChangeRejoin()
			} else if (this._rejoin) {
				// rejoin boot whose connection died BEFORE entry: give up on the auto
				// path and fall back to the menu (entry readout shows UPLINK LOST).
				this._cancelRejoin()
			}
		}

		this._syncEntryState()
	}

	setArenaReady() {
		if (this._arenaReady) return
		this._arenaReady = true
		document.body.classList.add('arena-ready')
		this._syncEntryState()
	}

	// MENU SAFETY (v1): ask the server to spawn us (SPECTATOR -> DEPLOYED). The
	// PLAY click calls this in the same gesture that requests pointer lock, so the
	// player experience stays ONE click — the server round-trip races the lock
	// animation and the entity is usually in before the overlay finishes fading.
	// Idempotent: no-ops once our entity exists (the server also hard-ignores
	// repeats). The ack is the existing Identity message + entity create.
	requestDeploy() {
		if (this.myRawEntity) return                       // already deployed
		if (this._connectionState !== 'connected') return  // socket not up yet
		this.client.addCommand(new DeployCommand())
		this._deployRequestedAt = Date.now()
	}

	// MENU SAFETY: spectator activity heartbeat. Real menu gestures (pointer/key,
	// wired in _setupGameUI) call this; it tells the server "this menu session is
	// alive" so the spectator INACTIVITY timeout doesn't reap someone reading the
	// whitepaper. Throttled client-side (the server rate-limits again — spoofing
	// buys nothing); no-ops entirely once deployed. `force` skips the throttle
	// (used by probes to exercise the server contract on short test timeouts).
	_spectatorActivity(force) {
		if (this.myRawEntity) return                       // deployed — combat state owns the socket
		if (this._connectionState !== 'connected') return
		const now = Date.now()
		if (!force && now - (this._lastHeartbeatAt || 0) < 30 * 1000) return
		this._lastHeartbeatAt = now
		this.client.addCommand(new SpectatorHeartbeatCommand())
	}

	// Audio-unlock plumbing for the inline splash (Part A). The Solana GATE card
	// holds until a user gesture; THAT gesture must resume WebAudio + unlock the music
	// so ARENA SIGNAL (already play()-queued as 'menu') audibly starts AT THE TAP.
	//   - window.__onSplashGesture: the inline handler calls this on the Solana tap. If
	//     the bundle is already booted, the tap itself does the unlock (WebAudio needs a
	//     LIVE gesture; a stale flag can't unlock it).
	//   - one-shot document listener: covers the race where the tap lands before the
	//     bundle boots (hook absent → the visual still advances, but no unlock yet). The
	//     NEXT gesture anywhere performs the unlock. Removes itself after firing once.
	_installSplashAudioUnlock() {
		const doUnlock = () => { this.audio.resume(); this.music.unlock() }
		// hook the inline splash calls on the gate tap (idempotent)
		window.__onSplashGesture = doUnlock
		// one-shot fallback for a tap that beat the bundle
		const once = () => {
			doUnlock()
			document.removeEventListener('pointerdown', once, true)
			document.removeEventListener('keydown', once, true)
		}
		document.addEventListener('pointerdown', once, true)
		document.addEventListener('keydown', once, true)
	}

	_setupGameUI() {
		this._arenaEntered = false
		this._arenaReady = false
		this._assetsReady = false
		this._assetProgress = 0 // 0..1, preload fraction (no longer drives a bar)
		this._pendingPlay = false // player clicked PLAY before the gate opened
		this._connectionState = 'connecting'
		this._lastHealth = null
		this._wasDead = false

		// MAP-ROTATION REJOIN (Overwatch-style instant play): a reload flagged
		// 'fa-rejoin' (set when the socket dropped mid-match — see
		// _beginMapChangeRejoin) skips splash+menu (inline splash controller) and
		// auto-enters the arena the moment the triple gate opens (_syncEntryState).
		// 'fa-rejoin-tries' caps the loop at 3 reloads without a successful entry.
		this._rejoin = false
		this._rejoinPending = false
		try { this._rejoin = sessionStorage.getItem('fa-rejoin') === '1' } catch (e) {}

		const enterButton = document.getElementById('enter-arena')
		const resumeButton = document.getElementById('resume-game')
		const closeButton = document.getElementById('settings-close')
		if (enterButton) enterButton.addEventListener('click', () => this._enterArena())
		// Shared dismiss for RESUME/BACK, the ✕, and Escape. From the MAIN MENU the
		// bottom button reads "BACK" — just close, never grab pointer lock (that would
		// fall through to the arena). Mid-match (touch) also just closes; mid-match
		// desktop re-locks the pointer to resume play.
		const dismissSettings = () => {
			if (!this._arenaEntered || this.isTouch) {
				this._closeSettings()
			} else {
				this.input.requestPointerLock()
			}
		}
		if (resumeButton) resumeButton.addEventListener('click', dismissSettings)
		// The ✕ is the always-reachable close (the RESUME button can scroll off-screen
		// on phones). It ALWAYS just closes — even mid-match desktop, where re-locking
		// the pointer would be a surprising outcome for an explicit "close" affordance.
		if (closeButton) closeButton.addEventListener('click', () => this._closeSettings())
		// Escape closes an open settings panel (MenuControls' Escape only covers the
		// info modals). Guarded on the panel being open, so the SAME Escape that
		// releases pointer lock to OPEN the pause menu (panel still closed at keydown
		// time) doesn't instantly close it again.
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape') return
			const m = document.getElementById('settings-menu')
			if (m && !m.classList.contains('settings-closed')) this._closeSettings()
		})

		document.addEventListener('pointerlockchange', () => {
			const locked = document.pointerLockElement === this.input.canvasEle
			if (locked) {
				this.audio.resume() // ensure audio is live once we're in the arena
				this.music.play('match') // crossfade menu theme -> in-match track
				this._arenaEntered = true
				document.body.classList.add('arena-entered')
				const overlay = document.getElementById('entry-overlay')
				if (overlay) overlay.classList.remove('is-visible')
				this._closeSettings()
			} else if (this._arenaEntered && !this.isTouch &&
				!this.devInspectorOpen && this._connectionState === 'connected') {
				this._openSettings()
			}
		})

		// MENU SAFETY: real menu gestures keep the spectator session alive (the
		// server's AFK timeout is inactivity-based). Capture phase so a handler's
		// stopPropagation can't hide activity; _spectatorActivity self-throttles
		// and no-ops once deployed, so this costs nothing in-match.
		document.addEventListener('pointerdown', () => this._spectatorActivity(), true)
		document.addEventListener('keydown', () => this._spectatorActivity(), true)

		// Procedural UI SFX (Kimi bit 2): ONE delegated pair covers every menu button
		// (PLAY / HOW TO / RESUME / settings / sliders) — no per-handler wiring. Uses
		// pointerdown (not click) for ~40ms faster feedback, capture phase so a handler's
		// stopPropagation can't swallow it. The audio methods self-throttle and no-op
		// before the AudioContext exists, so the very first PLAY press is silently safe.
		document.addEventListener('pointerdown', (e) => {
			const t = e.target
			if (t && t.closest && t.closest('button, [data-sfx]')) this.audio.uiClick()
		}, true)
		const canHover = typeof window.matchMedia !== 'function' || window.matchMedia('(hover:hover)').matches
		document.addEventListener('pointerover', (e) => {
			if (!canHover) return // no hover cue on touch/coarse pointers
			const t = e.target
			const btn = t && t.closest && t.closest('button, [data-sfx]')
			if (btn && btn !== this._lastHoverEl) { this._lastHoverEl = btn; this.audio.uiHover() }
		}, true)

		// Mobile has no pointer lock, so the desktop resume path above never runs
		// there. After any OS audio interruption (screen dim, notification, app
		// switch, iOS call/Siri) the AudioContext suspends and nothing recovers it —
		// audio goes permanently silent. Resume on touch-reachable events. resume()
		// already guards on state, so these are cheap + idempotent.
		//
		// IMPORTANT: include click + touchend, not just pointerdown/touchstart.
		// Android Chrome (confirmed via on-device logging) REJECTS an HTMLAudio
		// play() started from pointerdown/touchstart with NotAllowedError but ALLOWS
		// it from click/touchend on the same tap — which is why the menu music (all
		// pointerdown/touchstart-driven) stayed silent while match music (kicked from
		// the PLAY button's click) played. music.unlock() now retries on every gesture.
		const kickAudio = () => { this.audio.resume(); this.music.unlock() }
		document.addEventListener('touchstart', kickAudio, { passive: true })
		document.addEventListener('touchend', kickAudio, { passive: true })
		document.addEventListener('pointerdown', kickAudio)
		document.addEventListener('pointerup', kickAudio)
		document.addEventListener('click', kickAudio)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') this.audio.resume()
		})

		// start on the menu theme: play() only records the desired track, so it's
		// silent until the first gesture unlock() above — then Arena Signal loops
		// under the entry screen until the player enters the arena.
		this.music.play('menu')

		this._syncEntryState()
	}

	// Track heavy-asset preload progress. The loading bar was REMOVED (the menu is a
	// place, not a progress dialog) — this now only records fraction/stage state and
	// re-runs the entry gate; the sole visible surface is the uplink LED in
	// _syncEntryState. `stage` is a human label (MAP / CHARACTERS / … / FINALIZING).
	_setAssetProgress(frac, stage) {
		this._assetProgress = Math.max(0, Math.min(1, frac || 0))
		if (stage) this._assetStage = stage
		this._syncEntryState()
	}

	// Present the triple gate (connected && _arenaReady && _assetsReady) with NO
	// progress bar: the PLAY plate always reads PLAY; the only load surface is the
	// header uplink LED (#entry-status + .entry-uplink[data-ready]). If the player
	// clicks PLAY before the gate opens (_pendingPlay), the plate shows a brief
	// "DEPLOYING…" micro-state, then — since a stale pointer-lock gesture can be
	// rejected by Chrome — flips to a pulsing "READY — CLICK TO DEPLOY" so the next
	// click enters immediately (see _enterArena's pending path).
	_syncEntryState() {
		const connected = this._connectionState === 'connected'
		const ready = connected && this._arenaReady && this._assetsReady
		const button = document.getElementById('enter-arena')
		const status = document.getElementById('entry-status')
		const uplink = document.querySelector('.entry-uplink')

		if (button) {
			const labelEl = button.querySelector('.enter-label') || button
			let label = 'PLAY'
			if (!ready) {
				// gate still closed — no % on the plate. If a play intent is pending,
				// show the arming micro-state instead of the neutral label.
				button.disabled = true
				button.setAttribute('data-loading', 'true')
				button.setAttribute('aria-disabled', 'true')
				button.classList.toggle('is-arming', !!this._pendingPlay)
				label = this._pendingPlay ? 'DEPLOYING…' : 'PLAY'
			} else {
				// gate open.
				button.disabled = false
				button.setAttribute('data-loading', 'false')
				button.setAttribute('aria-disabled', 'false')
				button.classList.remove('is-arming')
				if (this._pendingPlay) {
					// a click landed while locked — DON'T auto-enter (stale user gesture
					// can be rejected by pointer lock). Prompt a fresh click.
					button.classList.add('is-ready-cta')
					label = 'READY — CLICK TO DEPLOY'
				} else {
					label = 'PLAY'
				}
				if (!this._enterUnlocked) {
					this._enterUnlocked = true
					button.classList.add('enter-unlock')
				}
			}
			if (labelEl.textContent !== label) labelEl.textContent = label
		}

		// uplink LED: the sole load surface. data-ready flips the LED green + label.
		if (uplink) uplink.setAttribute('data-ready', ready ? 'true' : 'false')
		if (status) {
			let text
			if (this._connectionState === 'disconnected') text = 'UPLINK LOST'
			else if (ready) text = 'READY'
			else text = 'ESTABLISHING UPLINK…'
			if (status.textContent !== text) status.textContent = text
		}

		// REJOIN AUTO-ENTER: gates just opened on a map-rotation reload — go straight
		// in (the CHANGING MAP interstitial has covered the whole boot). Deferred a
		// tick so entry state changes never re-enter this method mid-run.
		if (ready && this._rejoin && !this._arenaEntered) {
			this._rejoin = false
			setTimeout(() => this._autoEnterArena(), 0)
		}
	}

	// Programmatic arena entry for the map-rotation rejoin path. No user gesture is
	// available here, so desktop CANNOT requestPointerLock — instead we flip the
	// arena state directly (the touch branch of _enterArena already works this way)
	// and InputSystem's document pointerdown auto-locks on the first click, because
	// body.arena-entered is set. Clears the rejoin flag + retry counter (a success).
	_autoEnterArena() {
		try {
			sessionStorage.removeItem('fa-rejoin')
			sessionStorage.removeItem('fa-rejoin-tries')
		} catch (e) {}
		document.body.classList.remove('fa-rejoin')
		this._pendingPlay = false
		// MENU SAFETY: the rotation auto-rejoin must auto-REDEPLOY too — same
		// server handshake as the PLAY click, no gesture needed for a command.
		this.requestDeploy()
		this._arenaEntered = true
		document.body.classList.add('arena-entered')
		if (this._intrusionFeed) this._intrusionFeed.stop()
		this._closeSettings()
		const overlay = document.getElementById('entry-overlay')
		if (overlay) overlay.classList.remove('is-visible')
		const mc = document.getElementById('map-change')
		if (mc) mc.classList.remove('mc-visible')
		// silent until the next gesture unlocks audio (standard autoplay rules)
		this.music.play('match')
	}

	// Socket dropped AFTER the player entered the arena: treat it as a map rotation.
	// Show the fullscreen CHANGING MAP interstitial, flag the reload for rejoin, and
	// reload once the server has had ~2.5s to come back. Capped at 3 consecutive
	// reloads without a successful entry — after that, fall back to the menu (the
	// entry readout's UPLINK LOST state already covers it).
	_beginMapChangeRejoin() {
		if (this._rejoinPending) return
		let tries = 0
		try { tries = parseInt(sessionStorage.getItem('fa-rejoin-tries') || '0', 10) || 0 } catch (e) {}
		if (tries >= 3) { this._cancelRejoin(); return }
		try {
			sessionStorage.setItem('fa-rejoin', '1')
			sessionStorage.setItem('fa-rejoin-tries', String(tries + 1))
		} catch (e) { return } // no sessionStorage → plain menu fallback
		this._rejoinPending = true
		const mc = document.getElementById('map-change')
		if (mc) mc.classList.add('mc-visible')
		setTimeout(() => location.reload(), 2500)
	}

	// Abandon the rejoin auto-path: clear the flag/counter and let the normal menu
	// (with its UPLINK LOST / READY states) take over.
	_cancelRejoin() {
		this._rejoin = false
		try {
			sessionStorage.removeItem('fa-rejoin')
			sessionStorage.removeItem('fa-rejoin-tries')
		} catch (e) {}
		document.body.classList.remove('fa-rejoin')
		const mc = document.getElementById('map-change')
		if (mc) mc.classList.remove('mc-visible')
	}

	_enterArena() {
		// Resume audio on ANY PLAY click — this click is a valid user gesture even if
		// the gate is still closed, so the menu theme can start browsing music.
		this.audio.resume()
		this.music.unlock()

		const ready = this._connectionState === 'connected' && this._arenaReady && this._assetsReady
		if (!ready) {
			// Gate not open yet: record a pending intent so the plate shows the arming
			// micro-state, then (on gate-open) the "READY — CLICK TO DEPLOY" prompt.
			this._pendingPlay = true
			this._syncEntryState()
			return
		}
		// Gate open. Clear any pending/ready-cta state and enter for real. A manual
		// entry also resets the map-rotation rejoin retry counter (see _autoEnterArena).
		try { sessionStorage.removeItem('fa-rejoin-tries') } catch (e) {}
		this._pendingPlay = false
		const btn = document.getElementById('enter-arena')
		if (btn) btn.classList.remove('is-arming', 'is-ready-cta')

		this.audio.resume() // WebAudio needs a user gesture — this click is one
		this.music.unlock() // same gesture unlocks the music player

		// MENU SAFETY: send the deploy request NOW, in the same click — instant
		// play preserved (server spawn races the overlay fade / pointer lock; the
		// update() retry covers a dropped request). Until the entity arrives the
		// sim sends no commands (update() is gated on myRawEntity), so there is no
		// window where a menu body stands in the arena.
		this.requestDeploy()

		this._arenaEntered = true
		document.body.classList.add('arena-entered')
		// kill the intrusion-feed timers — the overlay is going away, no perpetual work.
		if (this._intrusionFeed) this._intrusionFeed.stop()
		this._closeSettings()

		const overlay = document.getElementById('entry-overlay')
		if (this.isTouch) {
			if (overlay) overlay.classList.remove('is-visible')
			this.music.play('match') // touch has no pointer-lock event — switch here
			if (this.touchControls) this.touchControls.enterFullscreen()
		} else {
			this.input.requestPointerLock()
		}
	}

	_openSettings() {
		const menu = document.getElementById('settings-menu')
		// menu-open cue only on a genuine closed->open transition (these methods are
		// called idempotently from several paths — don't double-tone).
		if (menu) {
			const wasClosed = menu.classList.contains('settings-closed')
			menu.classList.remove('settings-closed')
			// open at the top so the sticky ✕ (and title) are in view — a persisted
			// scroll position could otherwise start the panel mid-content on reopen.
			menu.scrollTop = 0
			if (wasClosed && this.audio) this.audio.menuOpen()
		}
		// Context-sensitive chrome: from the MAIN MENU (not yet in a match) the panel
		// reads "MAIN MENU" / "BACK". MENU SAFETY: mid-match it now reads "MATCH
		// LIVE" (never "PAUSED" — the world does not pause and calling it paused is
		// the lie that gets players killed), backed by the vulnerability banner
		// below. The RESUME button's click handler already branches on
		// isTouch/pointer-lock, which no-ops correctly on the menu.
		const inMatch = this._arenaEntered
		const kicker = document.getElementById('settings-kicker')
		if (kicker) kicker.textContent = inMatch ? 'MATCH LIVE' : 'MAIN MENU'
		const resumeLabel = document.querySelector('#resume-game .resume-label')
		if (resumeLabel) resumeLabel.textContent = inMatch ? 'RESUME' : 'BACK'

		// MENU SAFETY truth banner: kept fresh by _updateCombatBanner (also called
		// on the live<->dead transition, so dying with the panel open updates it).
		this._updateCombatBanner()
		document.body.classList.add('menu-open')
	}

	// MENU SAFETY truth banner (single source of truth): opening Settings/Escape
	// mid-match leaves the body live and fully damageable on the server (there is
	// no menu state on the wire at all) — say so, plainly, at the top of the
	// panel, and keep it TRUE as state changes while the panel stays open:
	//   deployed + alive  -> "COMBAT ACTIVE — CHARACTER VULNERABLE"
	//   deployed + dead   -> "YOU DIED — RESPAWNING"
	//   pre-deploy menu   -> no combat warning at all
	// Called from _openSettings() AND from the alive/dead transition in
	// _updateHud, so death/respawn with Settings open refreshes immediately.
	// Created lazily + styled inline (the panel markup is hand-authored elsewhere).
	_updateCombatBanner() {
		const menu = document.getElementById('settings-menu')
		if (!menu) return
		let banner = document.getElementById('combat-live-banner')
		if (!banner) {
			banner = document.createElement('div')
			banner.id = 'combat-live-banner'
			banner.setAttribute('role', 'alert')
			banner.style.cssText = 'display:none;margin:0 0 10px;padding:7px 12px;'
				+ 'font:700 13px/1.4 "Barlow Condensed",system-ui,sans-serif;'
				+ 'letter-spacing:.14em;text-align:center;border-radius:3px;'
			menu.insertBefore(banner, menu.firstChild)
		}
		// SERVER truth, not UI state: deployed = our entity exists (the UI-only
		// _arenaEntered flag can lag or be bypassed — probes deploy without the
		// overlay flow, and the banner must never contradict the actual body).
		const deployed = !!this.myRawEntity
		if (!deployed) { banner.style.display = 'none'; return }
		const dead = this.myRawEntity.isAlive === false
		if (dead) {
			banner.textContent = 'YOU DIED — RESPAWNING'
			banner.style.color = '#9fb4c8'
			banner.style.border = '1px solid rgba(159,180,200,.45)'
			banner.style.background = 'rgba(20,30,44,.4)'
			banner.style.textShadow = '0 0 6px rgba(159,180,200,.5)'
		} else {
			banner.textContent = '⚠ COMBAT ACTIVE — CHARACTER VULNERABLE'
			banner.style.color = '#ffb84d'
			banner.style.border = '1px solid rgba(255,184,77,.55)'
			banner.style.background = 'rgba(80,40,0,.35)'
			banner.style.textShadow = '0 0 6px rgba(255,184,77,.6)'
		}
		banner.style.display = 'block'
	}

	_closeSettings() {
		const menu = document.getElementById('settings-menu')
		if (menu) {
			const wasOpen = !menu.classList.contains('settings-closed')
			menu.classList.add('settings-closed')
			if (wasOpen && this.audio) this.audio.menuClose()
		}
		document.body.classList.remove('menu-open')
	}

	toggleSettings() {
		const menu = document.getElementById('settings-menu')
		if (!menu || menu.classList.contains('settings-closed')) {
			this._openSettings()
		} else if (this.isTouch) {
			this._closeSettings()
		} else {
			this.input.requestPointerLock()
		}
	}

	_updateHud() {
		let playerCount = 0
		for (const entity of this.client.entities.values()) {
			if (entity.protocol && entity.protocol.name === 'PlayerCharacter' &&
				entity.nid !== this.myRawId) {
				playerCount++
			}
		}
		if (playerCount !== this._lastPlayerCount) {
			this._lastPlayerCount = playerCount
			const count = document.getElementById('player-count')
			if (count) count.textContent = `${playerCount} ${playerCount === 1 ? 'PLAYER' : 'PLAYERS'}`
		}

		// bit 8: live latency readout. nengi measures RTT via its server timesync
		// (Ping/Pong chunks) and exposes the smoothed value as client.averagePing (ms).
		// Write the top-strip #ping-ms, flag >120ms as bad. Update only on change so we
		// don't touch the DOM every frame. The markup is "<text>--</text><small>MS</small>",
		// so patch the leading text node to keep the MS unit. Element owned by the HTML agent.
		const ping = Math.round(this.client.averagePing || 0)
		if (ping !== this._lastPing) {
			this._lastPing = ping
			const pingEl = document.getElementById('ping-ms')
			if (pingEl) {
				const node = pingEl.firstChild
				if (node && node.nodeType === 3) node.nodeValue = String(ping)
				else pingEl.textContent = String(ping)
				pingEl.classList.toggle('is-bad', ping > 120)
			}
		}

		// TDM team scoreboard + timer + phase banner (runs even before we've spawned).
		this._updateMatchHud()

		if (!this.myRawEntity) return
		if (!this._arenaReady) this.setArenaReady()

		// Phase 4: display cap raised to 150 (mega-health overheal). The bar fill scales
		// 0..1 for 0..100 base HP (the track clips overflow), and the OVERHEAL band
		// (100..150) reads distinctly via body.overheal — an amber fill + glow — while
		// the number shows the real value up to 150.
		const health = Math.max(0, Math.min(150, this.myRawEntity.hitpoints))
		const overheal = health > 100
		const healthValue = document.getElementById('health-value')
		const healthFill = document.getElementById('health-fill')
		if (healthValue) healthValue.textContent = Math.round(health)
		// fill is full at >=100 (base bar maxed); the overheal color/glow signals the extra
		const healthScale = Math.min(1, health / 100)
		if (healthFill) healthFill.style.transform = `scaleX(${healthScale})`
		document.body.classList.toggle('overheal', overheal)
		// damage-ghost trail (bit 3): a lagging white bar behind the fill makes burst
		// damage readable (Apex/Valorant-style). Drive it with the SAME scaleX as the
		// fill; the CSS transition delay makes it drain behind. On a HEAL (scale rising
		// vs last frame) suppress the lag so the ghost snaps up instead of leaving a
		// stale trail below the new fill. Element owned by the HTML agent — guard for null.
		const healthGhost = document.getElementById('health-ghost')
		if (healthGhost) {
			const healing = this._lastHealth !== null && health > this._lastHealth
			healthGhost.style.transition = healing ? 'none' : ''
			healthGhost.style.transform = `scaleX(${healthScale})`
		}
		// three-band health color law (RETRO phosphor bands): >=70 green, 30<hp<70
		// amber, <=30 crit red. crit (low-health) is toggled below and must win.
		document.body.classList.toggle('mid-health', health < 70 && health > 30)
		// third critical-state channel (spec AGENT C): pulsing red full-screen vignette,
		// fired by the SAME threshold as the health-panel red so both channels read
		// together. health is clamped 0..150, so a dead player (health===0) fails the
		// `> 0` guard and the vignette clears on death; it clears on respawn too once HP
		// climbs back above 30. Element + its CSS are owned by Agent A (guard for null).
		const lowHealth = health > 0 && health <= 30
		document.body.classList.toggle('low-health', lowHealth)
		const vignette = document.getElementById('low-hp-vignette')
		if (vignette) vignette.classList.toggle('active', lowHealth)

		// hit flash on a health drop — but NOT when the drop is just the overheal band
		// decaying (prev >100 shrinking while still >=100 is the 2/s overheal decay, not
		// an incoming hit), which would otherwise strobe the damage flash every step.
		const overhealDecayTick = this._lastHealth > 100 && health >= 100
		if (this._lastHealth !== null && health < this._lastHealth && !overhealDecayTick) {
			// local-hurt audio: low muffled body thump, louder as HP drops (Kimi SFX bit 1,
			// spectrally opposite the bright hitMarker). Self-throttled for SMG streams.
			this.audio.localHurt(Math.max(0, Math.min(1, health / 100)))
			clearTimeout(this._hitFlashTimer)
			document.body.classList.add('player-hit')
			this._hitFlashTimer = setTimeout(() => {
				document.body.classList.remove('player-hit')
			}, 90)
			// bit 7: full-screen damage flash. Non-directional here — the DIRECTIONAL
			// arc + --dmg-angle live in FragLayer.onDamageTaken (which has the attacker
			// yaw); this is the always-fires fallback pop keyed off any HP drop, with a
			// reflow restart so rapid consecutive hits each re-trigger. Element owned by
			// the HTML agent — guard for null.
			const dmgFlash = document.getElementById('damage-flash')
			if (dmgFlash) {
				dmgFlash.classList.remove('hit')
				void dmgFlash.offsetWidth // restart the CSS animation
				dmgFlash.classList.add('hit')
			}
		}
		this._lastHealth = health

		// Pickup FF: ARMOR bar (green-armor, 0..150). Networked UInt8 on the local raw
		// entity; the bar fills 0..1 over 0..ARMOR_CAP and body.has-armor reveals the row.
		const armor = Math.max(0, Math.min(150, this.myRawEntity.armor || 0))
		if (armor !== this._lastArmor) {
			this._lastArmor = armor
			const armorValue = document.getElementById('armor-value')
			if (armorValue) armorValue.textContent = Math.round(armor)
			const armorFill = document.getElementById('armor-fill')
			if (armorFill) armorFill.style.transform = `scaleX(${Math.min(1, armor / 150)})`
			document.body.classList.toggle('has-armor', armor > 0)
		}

		// Pickup FF: UDAMAGE buff (2x outgoing damage). udamageTimer is networked seconds
		// on the local raw entity; show a countdown badge + screen tint while it's live.
		const ud = this.myRawEntity.udamageTimer || 0
		const udActive = ud > 0
		if (udActive !== this._lastUdActive) {
			this._lastUdActive = udActive
			document.body.classList.toggle('udamage-active', udActive)
		}
		if (udActive) {
			const udSecs = Math.ceil(ud)
			if (udSecs !== this._lastUdSecs) {
				this._lastUdSecs = udSecs
				const udEl = document.getElementById('udamage-timer')
				if (udEl) udEl.textContent = udSecs + 's'
			}
		}

		const dead = this.myRawEntity.isAlive === false
		document.body.classList.toggle('player-dead', dead)
		const combatState = document.getElementById('combat-state')
		if (combatState) combatState.classList.toggle('combat-state-hidden', !dead)
		if (dead !== this._wasDead) {
			this._wasDead = dead
			if (this.viewmodel) this.viewmodel.setActive(!dead)
			// MENU SAFETY (P3): if Settings is open across a death/respawn, the
			// truth banner must flip immediately (COMBAT ACTIVE <-> YOU DIED).
			this._updateCombatBanner()
			if (!dead) {
				// AUTHORITATIVE death-cam reset: clear the death-cam drop/roll off the
				// replicated isAlive false->true edge, NOT only off the Respawned message.
				// The message-driven onRespawned (see the Respawned handler) is the normal
				// path, but if that message is lost/raced (packet loss, or the documented
				// map-rotation/auto-rejoin reconnect that skips it) while the isAlive FIELD
				// still flips true, _deathCam.active stays set and applyDeathCamera keeps
				// writing the ~23deg roll into the new life — and mouse-look only writes
				// rotation.x/y, so the leaked z persists until the next death ("respawned
				// with a skewed/CCW-tilted horizon"). onRespawned is idempotent, so calling
				// it here too makes the reset final regardless of message delivery.
				this.fragLayer.onRespawned()
				// we just respawned: mirror the server's respawn ammo reset
				// (GameInstance.respawnPlayer) so predicted fire/reload state stays
				// in lockstep — ammo isn't networked, it's predicted deterministically
				this.myRawEntity.weaponsState.forEach((state, i) => {
					state.magazineAmmo = weapons[i].magazineCapacity
					state.reserveAmmo = weapons[i].maxReserveAmmo
					state.cooldownTimer = 0
					state.onCooldown = false
					state.reloading = false
					state.reloadTimer = 0
					state.heat = 0
				})
				if (this.viewmodel) this.viewmodel.cancelReload()
			}
		}

		const frags = document.getElementById('frag-count')
		if (frags) {
			const k = this.myRawEntity.kills || 0
			const d = this.myRawEntity.deaths || 0
			const text = `${k} FRAG${k === 1 ? '' : 'S'} · ${d} DEATH${d === 1 ? '' : 'S'}`
			if (frags.textContent !== text) frags.textContent = text
		}

		// Phase 3: frag-grenade charge count (networked UInt8 on the player entity)
		const grenadeCount = document.getElementById('grenade-count')
		if (grenadeCount) {
			// RETRO: bare digit — the count renders in DSEG7, which has no "x" glyph
			// (the ghost "8" + pips carry the capacity read).
			const n = this.myRawEntity.grenadeCharges == null ? 0 : this.myRawEntity.grenadeCharges
			const text = String(n)
			if (grenadeCount.textContent !== text) grenadeCount.textContent = text
			const panel = document.getElementById('grenade-panel')
			if (panel) {
				panel.classList.toggle('is-empty', n <= 0)
				// bit 5: pip strip mirrors the live charge count. data-charges lets CSS
				// react to the count; each .pip lights .is-full while its index < n.
				// Pips owned by the HTML agent — guard (querySelectorAll is [] if absent).
				panel.dataset.charges = n
				const pips = panel.querySelectorAll('.grenade-pips .pip')
				for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('is-full', i < n)
			}
		}

		const weapon = weapons[this.weaponIndex]
		const state = this.myRawEntity.weaponsState && this.myRawEntity.weaponsState[this.weaponIndex]
		const weaponName = document.getElementById('weapon-name')
		if (weaponName && weapon) weaponName.textContent = weapon.name.toUpperCase()
		if (!state) return

		const magazine = document.getElementById('magazine-ammo')
		const reserve = document.getElementById('reserve-ammo')
		const weaponPanel = document.getElementById('weapon-panel')
		if (magazine) magazine.textContent = state.magazineAmmo
		if (reserve) reserve.textContent = state.reserveAmmo
		if (weaponPanel) {
			weaponPanel.classList.toggle('is-reloading', !!state.reloading)
			// UT-STYLE OWNERSHIP: publish the owned-weapons bitmask + current-weapon
			// ownership so the HUD/CSS can grey unowned slots (a weapon wheel reads this).
			// The current weapon is always owned (the switch gate guarantees it), so
			// is-unowned is a belt-and-braces cue rather than an expected state.
			const owned = this.myRawEntity.ownedWeapons
			if (owned !== undefined) {
				weaponPanel.dataset.owned = owned
				weaponPanel.classList.toggle('is-unowned', !(owned & (1 << this.weaponIndex)))
			}
			// bit 4: 3-tier ammo state (contract names is-low-ammo / is-empty).
			// LOW MAG (<=25%, still loaded): steady amber warning so the player can
			// top off before running dry. EMPTY (0, not reloading): red panic owns it.
			// Both suppress while reloading (that channel = is-reloading).
			const magazineCapacity = weapon ? weapon.magazineCapacity : 1
			const lowAmmoThreshold = Math.ceil(magazineCapacity * 0.25)
			const isLowAmmo = !state.reloading && state.magazineAmmo > 0 && state.magazineAmmo <= lowAmmoThreshold
			const isEmpty = !state.reloading && state.magazineAmmo === 0
			weaponPanel.classList.toggle('is-low-ammo', isLowAmmo)
			weaponPanel.classList.toggle('is-empty', isEmpty)
		}
	}

	// MENU SAFETY: SPAWN SHIELD tell — a small cyan chip under the crosshair while
	// the networked spawnImmunity (server-authoritative, on our own raw entity) is
	// live. It vanishes the frame the server revokes/expires it, so the UI never
	// claims protection the server isn't granting. Element is created lazily and
	// styled inline (index.html/css are hand-authored — not touched from here).
	_updateSpawnShield() {
		const e = this.myRawEntity
		const active = !!(e && e.isAlive !== false && (e.spawnImmunity || 0) > 0 && this._arenaEntered)
		if (active === this._spawnShieldShown) return
		this._spawnShieldShown = active
		let el = document.getElementById('spawn-shield')
		if (!el) {
			if (!active) return
			el = document.createElement('div')
			el.id = 'spawn-shield'
			el.textContent = 'SPAWN SHIELD'
			el.setAttribute('aria-hidden', 'true')
			el.style.cssText = 'position:fixed;left:50%;top:60%;transform:translateX(-50%);'
				+ 'padding:3px 12px;font:600 12px/1.5 "Barlow Condensed",system-ui,sans-serif;'
				+ 'letter-spacing:.22em;color:#8fdcff;border:1px solid rgba(143,220,255,.5);'
				+ 'border-radius:3px;background:rgba(8,36,54,.38);'
				+ 'text-shadow:0 0 8px rgba(143,220,255,.7);pointer-events:none;z-index:40;'
			document.body.appendChild(el)
		}
		el.style.display = active ? 'block' : 'none'
	}

	_setupSettingsUI() {
		const menu = document.getElementById('settings-menu')
		const fovSlider = document.getElementById('fov-slider')
		const fovVal = document.getElementById('fov-val')
		const sensSlider = document.getElementById('sens-slider')
		const sensVal = document.getElementById('sens-val')

		if (fovSlider && fovVal) {
			fovSlider.value = this.fov
			fovVal.textContent = this.fov
			fovSlider.addEventListener('input', (e) => {
				const val = parseInt(e.target.value, 10)
				this.fov = val
				fovVal.textContent = val
				this.renderer.camera.fov = (val * Math.PI) / 180
				localStorage.setItem('fov', val)
				// FOV changes the rad→px mapping; re-size the shotgun ring (dynamic
				// cross gap re-derives per-frame from the live FOV anyway)
				this._applyCrosshairWeapon(this.weaponIndex)
			})
		}

		if (sensSlider && sensVal) {
			sensSlider.value = this.sensitivity.toFixed(2)
			sensVal.textContent = this.sensitivity.toFixed(2)
			sensSlider.addEventListener('input', (e) => {
				const val = parseFloat(e.target.value)
				this.sensitivity = val
				sensVal.textContent = val.toFixed(2)
				localStorage.setItem('sens', val)
			})
		}

		// AUDIO: music volume (0..100 in the UI, 0..1 in the manager) + mute. Reads
		// the live values from MusicManager (already loaded from localStorage) so the
		// controls reflect the persisted state each time the menu opens.
		const musicSlider = document.getElementById('music-vol-slider')
		const musicVal = document.getElementById('music-vol-val')
		if (musicSlider && musicVal) {
			const pct = Math.round(this.music.baseVolume * 100)
			musicSlider.value = pct
			musicVal.textContent = pct
			musicSlider.addEventListener('input', (e) => {
				const p = parseInt(e.target.value, 10)
				musicVal.textContent = p
				this.music.setVolume(p / 100)
			})
		}
		const musicMute = document.getElementById('music-mute')
		if (musicMute) {
			musicMute.checked = this.music.muted
			musicMute.addEventListener('change', (e) => this.music.setMuted(e.target.checked))
		}

		// touch-only look settings: independent sensitivity + invert-Y. These rows
		// are meaningless with a mouse, so hide them unless this is a touch device.
		const touchSensRow = document.getElementById('touch-sens-row')
		const touchSensSlider = document.getElementById('touch-sens-slider')
		const touchSensVal = document.getElementById('touch-sens-val')
		const touchInvertRow = document.getElementById('touch-invert-row')
		const touchInvert = document.getElementById('touch-invert-y')

		if (touchSensRow) touchSensRow.style.display = this.isTouch ? '' : 'none'
		if (touchInvertRow) touchInvertRow.style.display = this.isTouch ? '' : 'none'

		if (touchSensSlider && touchSensVal) {
			touchSensSlider.value = this.touchSensitivity.toFixed(2)
			touchSensVal.textContent = this.touchSensitivity.toFixed(2)
			touchSensSlider.addEventListener('input', (e) => {
				const val = parseFloat(e.target.value)
				this.touchSensitivity = val
				touchSensVal.textContent = val.toFixed(2)
				localStorage.setItem('touchSens', val)
			})
		}

		if (touchInvert) {
			touchInvert.checked = this.touchInvertY
			touchInvert.addEventListener('change', (e) => {
				this.touchInvertY = e.target.checked
				localStorage.setItem('touchInvertY', e.target.checked ? 'true' : 'false')
			})
		}
	}

	_syncWeaponsConfigToServer() {
		weapons.forEach((w, index) => {
			this.client.addCommand(new DevUpdateWeaponConfigCommand({
				index: index,
				type: w.type === 'hitscan' ? 0 : 1,
				fireCooldown: w.fireCooldown,
				reloadTime: w.reloadTime,
				magazineCapacity: w.magazineCapacity,
				maxReserveAmmo: w.maxReserveAmmo,
				damage: w.damage,
				range: w.range,
				projectileSpeed: w.projectileSpeed
			}))

			// Make sure the raw entity weaponsState matches the capacities from localStorage
			if (this.myRawEntity && this.myRawEntity.weaponsState && this.myRawEntity.weaponsState[index]) {
				const state = this.myRawEntity.weaponsState[index]
				state.magazineAmmo = w.magazineCapacity
				state.reserveAmmo = w.maxReserveAmmo
			}
		})
		console.log("[DEV] Persistent weapons config synchronized to server successfully.")
	}

	_updateDevInspectorInputs() {
		const w = weapons[this.weaponIndex]
		if (!w) return

		const typeEl = document.getElementById('dev-weapon-type')
		const fireEl = document.getElementById('dev-fire-cooldown')
		const reloadEl = document.getElementById('dev-reload-time')
		const magEl = document.getElementById('dev-mag-capacity')
		const resEl = document.getElementById('dev-max-reserve')
		const dmgEl = document.getElementById('dev-damage')
		const rngEl = document.getElementById('dev-range')
		const speedEl = document.getElementById('dev-proj-speed')

		if (typeEl) typeEl.value = w.type === 'hitscan' ? '0' : '1'
		if (fireEl) fireEl.value = w.fireCooldown
		if (reloadEl) reloadEl.value = w.reloadTime
		if (magEl) magEl.value = w.magazineCapacity
		if (resEl) resEl.value = w.maxReserveAmmo
		if (dmgEl) dmgEl.value = w.damage
		if (rngEl) rngEl.value = w.range || 0
		if (speedEl) speedEl.value = w.projectileSpeed || 0
	}

	_setupDevInspector() {
		// Load custom configurations from localStorage if they exist
		const savedConfigs = localStorage.getItem('dev_weapons_config')
		if (savedConfigs) {
			try {
				const parsed = JSON.parse(savedConfigs)
				parsed.forEach(saved => {
					const w = weapons[saved.index]
					if (w) {
						w.type = saved.type === 0 || saved.type === 'hitscan' ? 'hitscan' : 'projectile'
						w.fireCooldown = saved.fireCooldown
						w.reloadTime = saved.reloadTime
						w.magazineCapacity = saved.magazineCapacity
						w.maxReserveAmmo = saved.maxReserveAmmo
						w.damage = saved.damage
						w.range = saved.range
						w.projectileSpeed = saved.projectileSpeed
					}
				})
			} catch (e) {
				console.error("Failed to parse saved weapons config", e)
			}
		}

		// F2 toggle key
		document.addEventListener('keydown', (e) => {
			if (e.key === 'F2') {
				this.devInspectorOpen = !this.devInspectorOpen
				const el = document.getElementById('dev-inspector')
				if (el) {
					if (this.devInspectorOpen) {
						el.classList.remove('dev-closed')
						document.exitPointerLock()
					} else {
						el.classList.add('dev-closed')
						// Request pointer lock again when closing the inspector
						const mainCanvas = document.getElementById('main-canvas')
						if (mainCanvas) {
							mainCanvas.requestPointerLock()
						}
					}
				}
			}
		})

		// Inputs event listeners
		const typeEl = document.getElementById('dev-weapon-type')
		const fireEl = document.getElementById('dev-fire-cooldown')
		const reloadEl = document.getElementById('dev-reload-time')
		const magEl = document.getElementById('dev-mag-capacity')
		const resEl = document.getElementById('dev-max-reserve')
		const dmgEl = document.getElementById('dev-damage')
		const rngEl = document.getElementById('dev-range')
		const speedEl = document.getElementById('dev-proj-speed')

		const onInputChange = () => {
			const w = weapons[this.weaponIndex]
			if (!w) return

			w.type = typeEl.value === '0' ? 'hitscan' : 'projectile'
			w.fireCooldown = parseFloat(fireEl.value) || 0.1
			w.reloadTime = parseFloat(reloadEl.value) || 1.0
			w.magazineCapacity = parseInt(magEl.value, 10) || 10
			w.maxReserveAmmo = parseInt(resEl.value, 10) || 50
			w.damage = parseFloat(dmgEl.value) || 10
			w.range = parseFloat(rngEl.value) || 50
			w.projectileSpeed = parseFloat(speedEl.value) || 30

			// Save to localStorage
			const configsToSave = weapons.map(weapon => ({
				index: weapon.index,
				type: weapon.type,
				fireCooldown: weapon.fireCooldown,
				reloadTime: weapon.reloadTime,
				magazineCapacity: weapon.magazineCapacity,
				maxReserveAmmo: weapon.maxReserveAmmo,
				damage: weapon.damage,
				range: weapon.range,
				projectileSpeed: weapon.projectileSpeed
			}))
			localStorage.setItem('dev_weapons_config', JSON.stringify(configsToSave))

			// Sync command to server
			this.client.addCommand(new DevUpdateWeaponConfigCommand({
				index: this.weaponIndex,
				type: typeEl.value === '0' ? 0 : 1,
				fireCooldown: w.fireCooldown,
				reloadTime: w.reloadTime,
				magazineCapacity: w.magazineCapacity,
				maxReserveAmmo: w.maxReserveAmmo,
				damage: w.damage,
				range: w.range,
				projectileSpeed: w.projectileSpeed
			}))

			// Adjust active ammunition state boundaries if needed
			if (this.myRawEntity && this.myRawEntity.weaponsState) {
				const state = this.myRawEntity.weaponsState[this.weaponIndex]
				if (state.magazineAmmo > w.magazineCapacity) {
					state.magazineAmmo = w.magazineCapacity
				}
				if (state.reserveAmmo > w.maxReserveAmmo) {
					state.reserveAmmo = w.maxReserveAmmo
				}
			}
		}

		if (typeEl) typeEl.addEventListener('change', onInputChange)
		if (fireEl) fireEl.addEventListener('input', onInputChange)
		if (reloadEl) reloadEl.addEventListener('input', onInputChange)
		if (magEl) magEl.addEventListener('input', onInputChange)
		if (resEl) resEl.addEventListener('input', onInputChange)
		if (dmgEl) dmgEl.addEventListener('input', onInputChange)
		if (rngEl) rngEl.addEventListener('input', onInputChange)
		if (speedEl) speedEl.addEventListener('input', onInputChange)

		this._updateDevInspectorInputs()
	}
}

export default Simulator
