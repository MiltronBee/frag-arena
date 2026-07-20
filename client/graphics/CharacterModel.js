import * as BABYLON from '../babylon.js'
import { tpWeapons } from '../assets/assetManifest'

// A visual character bound to (but not parented to) a host transform — typically
// another player's replicated collision box. Each frame it copies the host's
// position + yaw and picks idle/run from how fast the host is moving. Pitch is
// intentionally ignored so bodies don't tilt when a player looks up/down.
//
// NB: Babylon 4.0.3 has no AssetContainer.instantiateModelsToScene, so we import
// a fresh copy per entity via ImportMeshAsync (the HTTP fetch is browser-cached).
// Fine for a handful of players; revisit with true GPU instancing if it scales.
//
// CLIP PRIORITY (highest wins): death > shoot > hit > run/idle. `current` is the
// looping locomotion clip; one-shots (shoot/hit/death) play as overlays on top.
// CRITICAL repo constraint: Babylon's AnimationGroup.stop() FIRES the group's end
// observable — so every one-shot registers its end-handler through _onEndOnce(),
// which is token-guarded so a stale/late/recursive end callback is a no-op.

// ---------------------------------------------------------------------------
// Shared third-person weapon prop cache. Loaded ONCE per url; each CharacterModel
// clones the cached meshes into its own hierarchy (so we never re-fetch per
// player). Cloned props carry no skeleton/anims — they're static geometry.
// ---------------------------------------------------------------------------
const _propCache = new Map() // url -> Promise<{ meshes: AbstractMesh[] }>

// ---------------------------------------------------------------------------
// SINGLE-FLIGHT body import. The preload warm (warmBody) and the first real
// player's _load both want the same ~20MB hero_male.glb, and they fire close
// enough together to race — the browser CANNOT dedupe two identical in-flight
// requests, so the network waterfall showed the GLB fetched TWICE in parallel.
//
// We coalesce the FIRST import per url into one in-flight promise. A live
// CharacterModel needs its OWN skeleton + animationGroups (Babylon 4.0.3 has no
// instantiateModelsToScene, so copies can't be shared), so exactly one consumer
// may "claim" the imported result and own its meshes; everyone else must import
// their own copy — but by then the bytes are in the HTTP cache, so no second
// network download happens. warmBody is a THROWAWAY consumer: it claims the
// shared import only if no live model beat it to it, otherwise it piggybacks on
// the live import (and disposes nothing — the live model owns it).
// ---------------------------------------------------------------------------
const _bodyFlight = new Map() // url -> { promise: Promise<result>, claimed: bool }

function _importBodyRaw(scene, url) {
  const slash = url.lastIndexOf('/') + 1
  return BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), scene)
}

// Return the single-flight import, starting it if none is running. Does NOT
// claim ownership — caller decides whether to claim (own the meshes) or just
// piggyback (warm path with nothing to dispose if a live model already claimed).
function _bodyFlightPromise(scene, url) {
  let flight = _bodyFlight.get(url)
  if (!flight) {
    flight = { promise: _importBodyRaw(scene, url), claimed: false }
    _bodyFlight.set(url, flight)
  }
  return flight
}

// A live CharacterModel calls this for its own instance. If the shared in-flight
// import is still unclaimed, take ownership of that result (no second fetch, no
// second parse). If none exists yet (this live load beat the preload warm), START
// the single-flight and immediately claim it, so a later warmBody piggybacks on
// THIS import rather than firing its own duplicate 20MB fetch. Only when the flight
// is already claimed by someone else do we import a fresh copy — which now hits the
// browser cache the first import primed, so it's parse-only, no network download.
async function _claimBodyImport(scene, url) {
  let flight = _bodyFlight.get(url)
  if (!flight) flight = _bodyFlightPromise(scene, url)
  if (!flight.claimed) {
    flight.claimed = true
    return flight.promise
  }
  return _importBodyRaw(scene, url)
}

// The death clip (UAL1 Death01) is ~2.375s — nearly the full RESPAWN_DELAY_MS
// (2.5s), so at 1x speed the fall barely fits before the respawn cancels the
// corpse, and any network jitter on the Killed packet truncates it (the body
// pops upright mid-fall). Play it faster so it completes in ~1.3s, leaving >1s
// of dead-hold slack against the respawn. See _applyDeathClip.
const DEATH_CLIP_SPEED = 1.8

// HIT-STOP (client-cosmetic "impact freeze"): on taking damage a body's animation
// near-freezes for a few dozen ms, the empirically top-leverage cue that a hit
// landed. Purely visual — driven off the replicated hitpoints watch, never on the
// input/prediction path, and always skipped while a corpse (death owns the rig).
const HIT_STOP_SPEED = 0.08 // speedRatio during the freeze (0.08 = near-frozen)
const HIT_STOP_MAX_MS = 120 // cap so a burst of hits can't stack into a long freeze
const KILL_STOP_MAX_MS = 140 // Doom kill-emphasis freeze on the victim body (NOT global slow-mo)

function _loadProp(scene, url) {
  if (_propCache.has(url)) return _propCache.get(url)
  const slash = url.lastIndexOf('/') + 1
  const rootUrl = url.slice(0, slash)
  const fileName = url.slice(slash)
  const p = BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene).then((result) => {
    // keep a hidden template root; instances clone from it and get enabled.
    const root = result.meshes[0]
    root.setEnabled(false)
    result.meshes.forEach((m) => { m.isPickable = false })
    return { root }
  })
  _propCache.set(url, p)
  return p
}

// Public re-export of the shared prop loader so non-character visuals (e.g. the
// thrown grenade) can mount the SAME cached template the preloader warms —
// without duplicating the ImportMesh+cache logic. Returns the cached
// { root } template (a hidden, disabled node); callers clone from it.
export function loadPropTemplate(scene, url) {
  return _loadProp(scene, url)
}

// ---------------------------------------------------------------------------
// PRELOAD / GPU-WARM helpers (called by the boot preloader, NOT in-match).
//
// The goal: by the time the arena is enterable, every third-person prop the
// game will ever mount already lives in `_propCache`, and every GLB the game
// imports has been parsed + had its materials shader-compiled once. After this,
// `setWeapon`/`_mountHelmet` hit the cache with zero ImportMesh, and the first
// in-match frame binds no unready effect (the mid-match weapon-swap hitch and
// import races the RECON doc flags are removed by construction).
// ---------------------------------------------------------------------------

// Force the GL shaders for every material on a set of meshes to compile now, so
// the first frame they render never triggers a mid-frame compile/VAO bind.
function _warmMaterials(meshes) {
  const seen = new Set()
  meshes.forEach((mesh) => {
    const mat = mesh.material
    if (!mat || seen.has(mat) || !mat.forceCompilation) return
    seen.add(mat)
    try { mat.forceCompilation(mesh) } catch (e) { /* non-fatal */ }
  })
}

// Import a third-person prop (weapon/helmet) into the shared cache and warm its
// shaders. Idempotent per url. The template root stays disabled in the scene so
// in-match clones are pure CPU clones (no fetch, no decode).
export async function warmProp(scene, url) {
  if (!url) return
  // THROWAWAY warm: import to compile shaders + prime the browser cache, then fully
  // dispose. We deliberately do NOT populate _propCache here — pre-caching every tp
  // weapon + helmet would keep hidden template meshes/materials in the scene for the
  // whole session (props that may never be used this match). In-match, _loadProp still
  // lazily caches the template on first real mount, now hitting the warmed browser
  // cache + compiled shader so it lands without a hitch.
  const slash = url.lastIndexOf('/') + 1
  const result = await BABYLON.SceneLoader.ImportMeshAsync(
    '', url.slice(0, slash), url.slice(slash), scene)
  result.meshes.forEach((m) => { m.setEnabled(false); m.isPickable = false })
  _warmMaterials(result.meshes)
  result.animationGroups.forEach((g) => g.stop())
  result.meshes.forEach((m) => m.dispose(false, true))
  result.animationGroups.forEach((g) => g.dispose())
  ;(result.skeletons || []).forEach((s) => s.dispose())
}

// Import the heavy character body ONCE, compile its skinned-mesh shaders, then
// dispose the throwaway copy. Each real player still imports its own instance
// (Babylon 4.0.3 lacks instantiateModelsToScene), but that import now hits the
// browser cache AND a warmed shader program, so it lands without a hitch.
export async function warmBody(scene, url) {
  if (!url) return
  // Warm via the SINGLE-FLIGHT import so we don't race a real player's _load into
  // a duplicate 20MB download. We claim the shared import only if no live model
  // grabbed it first; if a live model already claimed it, we piggyback on the same
  // in-flight promise (its shaders warm as it renders) and own nothing to dispose.
  const flight = _bodyFlightPromise(scene, url)
  const iOwnIt = !flight.claimed && (flight.claimed = true)
  const result = await flight.promise
  if (!iOwnIt) return // a live CharacterModel claimed this import — it owns the copy
  // never let the throwaway copy render even a single frame behind the load
  // overlay (it imports at origin, enabled by default).
  result.meshes.forEach((m) => { m.setEnabled(false); m.isPickable = false })
  _warmMaterials(result.meshes)
  // let the skinned pipeline compile against a real bone texture upload
  if (result.skeletons && result.skeletons[0]) {
    try { result.skeletons[0].prepare() } catch (e) { /* non-fatal */ }
  }
  result.animationGroups.forEach((g) => g.stop())
  // dispose(false, true): the throwaway copy must free its materials + textures too,
  // else every warmed body/rig leaks them (mesh.dispose() alone keeps them alive).
  // The compiled shader program stays in the engine's effect cache, so the warm holds.
  result.meshes.forEach((m) => m.dispose(false, true))
  result.animationGroups.forEach((g) => g.dispose())
  ;(result.skeletons || []).forEach((s) => s.dispose())
}

// Bones owned by the locomotion clip. A momentary overlay (shoot/hit) is masked
// to EXCLUDE these, so it never freezes the legs — the stride keeps playing under
// it and the body no longer slides while shooting on the move. (Babylon 4.0.3 has
// no additive-animation API, so we mask by bone instead.)
const LOWER_BODY_BONES = new Set([
  'root', 'pelvis',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'ball_leaf_l',
  'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'ball_leaf_r',
])

export default class CharacterModel {
  constructor(scene, host, spec) {
    this.scene = scene
    this.host = host
    this.spec = spec
    this.ready = false
    this.disposed = false
    this.holder = null
    this.groups = {}
    this.current = null
    this._oneShot = null      // active overlay group (shoot/hit)
    this._oneShotToken = 0    // guards stale end-observable callbacks (stop() fires them)
    this._weaponIndex = null  // currently mounted tp weapon
    this._weaponRoot = null   // cloned prop root parented to the hand bone
    this._helmetRoot = null   // cloned helmet prop parented to the head bone
    // floating overhead nametag: a plain DOM div in #nametags, positioned each
    // frame by projecting the body's head-level world point to screen space.
    this._nameTag = null
    const container = document.getElementById('nametags')
    if (container) {
      this._nameTag = document.createElement('div')
      this._nameTag.className = 'nametag'
      container.appendChild(this._nameTag)
    }
    this._weaponReqId = 0     // serialize async weapon swaps
    this._lastX = host.position.x
    this._lastZ = host.position.z
    this._load()
  }

  // set (or update) the overhead nametag text. Called from the player factory on
  // create + on the replicated nameIndex watch.
  setName(name) {
    this._playerName = name
    if (this._nameTag) this._nameTag.textContent = name
  }

  async _load() {
    // Single-flight claim: if the preload warm's import for this url is still
    // in-flight and unclaimed, we take ownership of that copy (no second 20MB
    // fetch). Otherwise we import our own — hitting the browser cache the first
    // import primed, so it's parse-only, never a duplicate network download.
    const result = await _claimBodyImport(this.scene, this.spec.url)
    if (this.disposed) {
      result.meshes.forEach((m) => m.dispose())
      result.animationGroups.forEach((g) => g.dispose())
      return
    }

    // parent the imported model under our own node so the glTF loader's __root__
    // handedness fix doesn't interfere with the yaw/position we set each frame.
    this.holder = new BABYLON.TransformNode('charHolder', this.scene)
    this.holder.scaling.setAll(this.spec.scale)
    result.meshes[0].parent = this.holder
    this.meshes = result.meshes
    this.skeleton = result.skeletons && result.skeletons[0]

    // tag body meshes so a shot that lands on a player reads as a flesh/blood impact
    // (and drives the local player's predicted hit marker). See firingFx.classifySurface.
    result.meshes.forEach((m) => {
      m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
    })

    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    this.idle = this.groups[this.spec.anims.idle]
    this.run = this.groups[this.spec.anims.run]
    // directional locomotion (UAL1 has fwd/bwd/left/right jogs) so a strafing body
    // steps sideways instead of moon-walking a forward jog. All optional -> fall
    // back to `run` then `idle`.
    this.runBack = this.groups[this.spec.anims.runBack]
    this.runLeft = this.groups[this.spec.anims.runLeft]
    this.runRight = this.groups[this.spec.anims.runRight]
    this.shootClip = this.groups[this.spec.anims.shoot]
    this.hitClip = this.groups[this.spec.anims.hit]
    this.deathClip = this.groups[this.spec.anims.death]
    // upper-body-only overlays: the full shoot/hit clips animate the legs too, so
    // playing them over locomotion freezes the stride and the body slides. Mask to
    // spine-and-up so the locomotion clip keeps owning the legs.
    this.shootUpper = this._maskUpperBody(this.shootClip, 'shootUpper')
    this.hitUpper = this._maskUpperBody(this.hitClip, 'hitUpper')
    if (this.idle) { this.idle.start(true, 1.0); this.current = this.idle }
    this.ready = true

    // if a corpse/weapon was requested before we finished loading, apply now
    if (this._pendingWeaponIndex != null) {
      const idx = this._pendingWeaponIndex
      this._pendingWeaponIndex = null
      this.setWeapon(idx)
    } else {
      // no watch fired before load finished -> default weapon (index 0)
      this.setWeapon(0)
    }
    this._mountHelmet()
    if (this._corpse) this._applyDeathClip()
  }

  // find the Babylon TransformNode linked to a glTF joint by name. Babylon's glTF
  // loader creates a TransformNode per bone (bone.getTransformNode()); we attach
  // the weapon prop to that node so it rides the animated hand.
  _handNode() {
    if (this._cachedHandNode) return this._cachedHandNode
    const name = this.spec.handBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    // Babylon 4.0.3 has no public getTransformNode(); the glTF loader links each
    // bone to a scene TransformNode via _linkedTransformNode. Prefer the public
    // accessor when it exists (future upgrades), fall back to the private field.
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHandNode = node
    return node
  }

  // find the TransformNode linked to the head glTF joint (mirrors _handNode) so
  // the helmet prop can parent to it and ride the head animation.
  _headNode() {
    if (this._cachedHeadNode) return this._cachedHeadNode
    const name = this.spec.headBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHeadNode = node
    return node
  }

  // ---- HELMET -------------------------------------------------------------
  // Mount the rigid helmet prop on the head bone. Parented (not per-frame), so it
  // rides head animation and persists through corpse/death mode untouched.
  async _mountHelmet() {
    if (!this.spec.helmet) return
    const head = this._headNode()
    if (!head) return // no bone -> no helmet (skeleton missing)

    const { root } = await _loadProp(this.scene, this.spec.helmet.url)
    if (this.disposed) return

    // drop any previous helmet
    if (this._helmetRoot) { this._helmetRoot.dispose(); this._helmetRoot = null }

    // clone the template (deep, with descendants) and mount under the head node
    const clone = root.clone('helmet', head)
    clone.setEnabled(true)
    clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
    const spec = this.spec.helmet
    clone.scaling.setAll(spec.scale)
    clone.position.set(spec.position.x, spec.position.y, spec.position.z)
    clone.rotationQuaternion = null
    clone.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    // tag as flesh so a headshot on the helmet reads like a body hit (matches _load)
    ;[clone, ...clone.getChildMeshes()].forEach((m) => {
      m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
    })
    this._helmetRoot = clone
  }

  // ---- HELD WEAPON --------------------------------------------------------
  // Mount the tp weapon prop for `index` on the hand bone, swapping any current
  // one. Async (props load once, then clone) but serialized so rapid swaps settle
  // on the latest. Idempotent when index is unchanged.
  async setWeapon(index) {
    if (index == null || index < 0) return
    if (!this.ready) { this._pendingWeaponIndex = index; return }
    if (index === this._weaponIndex) return
    const spec = tpWeapons[index]
    if (!spec) return
    this._weaponIndex = index

    const reqId = ++this._weaponReqId
    const hand = this._handNode()
    if (!hand) return // no bone -> no held weapon (skeleton missing)

    const { root } = await _loadProp(this.scene, spec.url)
    if (this.disposed || reqId !== this._weaponReqId) return

    // drop the previous prop
    if (this._weaponRoot) { this._weaponRoot.dispose(); this._weaponRoot = null }

    // clone the template (deep, with descendants) and mount under the hand node
    const clone = root.clone('tpWeapon_' + index, hand)
    clone.setEnabled(true)
    clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
    clone.scaling.setAll(spec.scale)
    clone.position.set(spec.position.x, spec.position.y, spec.position.z)
    clone.rotationQuaternion = null
    clone.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    this._weaponRoot = clone
  }

  update(delta) {
    if (!this.ready || !this.holder || this.disposed) return
    const p = this.host.position

    // Babylon 4.0.3 stops re-syncing bones from their linked glTF transform nodes
    // once a skeleton is large enough to store its matrices in a texture (~>30
    // bones, as the 65-bone UBC rig does). The AnimationGroups animate the nodes,
    // but the skinned mesh stays frozen at bind pose unless we re-prepare the
    // skeleton each frame. (The 23-bone soldier rig used the uniform path and
    // never needed this.) Cheap for a handful of players.
    if (this.skeleton) this.skeleton.prepare()

    // (held-weapon sync happens via the currentWeaponIndex factory watch —
    // this.host is the entity MESH and carries no replicated fields)

    // CORPSE MODE (driven by FragLayer off the Killed message, NOT the replicated
    // isAlive flag): while a death animation is playing the FragLayer owns this
    // model's enabled state, so we stop driving pose here. The death CLIP itself
    // (played in setCorpse) drives the fall; position still follows the host.
    if (this._corpse) {
      this.holder.setEnabled(!this._hidden)
      this.holder.position.set(p.x, p.y + this.spec.yOffset, p.z)
      if (this._nameTag) this._nameTag.style.display = 'none'
      return
    }

    // Normal death: hide instantly when isAlive is false AND no corpse animation
    // is running (e.g. a death we never saw a Killed message for). A live corpse
    // animation takes priority via the early return above.
    this.holder.setEnabled(this.host.isAlive !== false)
    this.holder.position.set(p.x, p.y + this.spec.yOffset, p.z)
    this.holder.rotation.y = this.host.rotation.y + (this.spec.yawOffset || 0)

    // HIT-STOP: while active, near-freeze the animation to sell the impact. The body
    // still tracks host position/yaw (set above); we only stall clip playback and
    // skip locomotion re-selection so clips don't restart mid-freeze. On expiry we
    // restore normal speed and fall through. Overlays (shoot/hit) are frozen too but
    // their end-observable token guards are untouched.
    if (this._hitStopUntil) {
      const now = performance.now()
      if (now < this._hitStopUntil) {
        if (this.current) this.current.speedRatio = HIT_STOP_SPEED
        if (this._oneShot) this._oneShot.speedRatio = HIT_STOP_SPEED
        return
      }
      if (this.current) this.current.speedRatio = 1.0
      if (this._oneShot) this._oneShot.speedRatio = 1.0
      this._hitStopUntil = 0
    }

    const dx = p.x - this._lastX
    const dz = p.z - this._lastZ
    this._lastX = p.x
    this._lastZ = p.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(delta, 1 / 240)

    // A shoot/hit one-shot is playing on top of locomotion. We keep the base
    // locomotion clip running underneath (so the legs still stride); the overlay
    // group blends on the shared skeleton. Locomotion selection continues below
    // so that when the one-shot ends we're already on the right base clip.
    //
    // DIRECTIONAL LOCOMOTION: bots (and strafing players) face one way while
    // moving another, so pick fwd/back/left/right jog from the movement vector
    // resolved into the body's local frame (matches applyCommand: forward=+Z,
    // right=+X, rotated by rotation.y). EMA-smooth the delta so near-diagonal
    // motion doesn't flicker between clips frame to frame.
    this._smDx = (this._smDx || 0) * 0.7 + dx * 0.3
    this._smDz = (this._smDz || 0) * 0.7 + dz * 0.3
    let target = this.idle
    if (speed > 0.4) {
      const yaw = this.host.rotation.y
      const s = Math.sin(yaw)
      const c = Math.cos(yaw)
      const fwd = this._smDx * s + this._smDz * c   // + = forward
      const rgt = this._smDx * c - this._smDz * s   // + = right
      if (Math.abs(fwd) >= Math.abs(rgt)) {
        target = (fwd >= 0 ? this.run : this.runBack) || this.run
      } else {
        target = (rgt >= 0 ? this.runRight : this.runLeft) || this.run
      }
      target = target || this.idle
    }
    if (target && target !== this.current) {
      if (this.current) this.current.stop()
      target.start(true, 1.0)
      this.current = target
    }

    // floating nametag: project head-level world position to screen
    if (this._nameTag) {
      const show = !this._corpse && this.host.isAlive !== false && this.holder
      if (show) {
        const engine = this.scene.getEngine()
        const camera = this.scene.getCameraByName('camera')
        if (camera) {
          const headY = this.holder.position.y + 1.4
          const wp = new BABYLON.Vector3(this.holder.position.x, headY, this.holder.position.z)
          const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
          const sp = BABYLON.Vector3.Project(wp, BABYLON.Matrix.Identity(), this.scene.getTransformMatrix(), vp)
          if (sp.z > 0 && sp.z < 1) {
            this._nameTag.style.display = 'block'
            this._nameTag.style.left = sp.x + 'px'
            this._nameTag.style.top = sp.y + 'px'
          } else {
            this._nameTag.style.display = 'none'
          }
        }
      } else {
        this._nameTag.style.display = 'none'
      }
    }
  }

  // Build a copy of `src` that drives only upper-body bones (spine-and-up + arms),
  // so it overlays locomotion without touching the legs. Shares the source's
  // Animation objects (src stays stopped). Returns null if src is missing/empty.
  _maskUpperBody(src, name) {
    if (!src) return null
    const g = new BABYLON.AnimationGroup(name, this.scene)
    src.targetedAnimations.forEach((ta) => {
      const tn = ta.target && ta.target.name
      if (tn && !LOWER_BODY_BONES.has(tn)) g.addTargetedAnimation(ta.animation, ta.target)
    })
    if (g.targetedAnimations.length === 0) { g.dispose(); return null }
    g.normalize(src.from, src.to)
    return g
  }

  // ---- ONE-SHOT OVERLAYS (shoot / hit) ------------------------------------
  // Play a non-looping clip once, then return to locomotion. Guarded so stop()'s
  // end observable (fired synchronously by Babylon) can't recurse or fire stale.
  _playOneShot(group, weight) {
    if (!group || this.disposed || this._corpse) return
    // bump token so any pending end-handler from a prior one-shot is neutralized
    const token = ++this._oneShotToken
    if (this._oneShot && this._oneShot !== group) {
      // stop the previous overlay WITHOUT letting its (now-stale) end handler run
      this._oneShot.onAnimationGroupEndObservable.clear()
      this._oneShot.stop()
    }
    this._oneShot = group
    group.onAnimationGroupEndObservable.clear()
    group.onAnimationGroupEndObservable.addOnce(() => {
      // ignore if superseded (a newer one-shot started) or we've been disposed
      if (token !== this._oneShotToken || this.disposed) return
      this._oneShot = null
    })
    group.stop()          // reset to frame 0 (fires end obs, but we just cleared it)
    group.start(false, 1.0) // one-shot, non-looping
  }

  // Remote-player shoot feedback (called from Simulator's WeaponFired handler).
  // Rapid fire (SMG) retriggers cleanly by restarting from frame 0.
  playShoot() {
    if (!this.ready || this._corpse) return
    this._playOneShot(this.shootUpper || this.shootClip)
  }

  // Begin (or extend) a hit-stop freeze of `ms`, applied in update(). Clamped so a
  // stream of hits reads as one brief freeze, not a long stall. `kill` raises the cap
  // to KILL_STOP_MAX_MS for a Doom-style kill emphasis on THIS victim's body only —
  // never a global timescale change (this is a live multiplayer client). No-op while a
  // corpse — the death clip owns the rig (kills call this just BEFORE _dropCorpse).
  hitStop(ms, kill) {
    if (this._corpse || this.disposed) return
    const now = performance.now()
    const cap = kill ? KILL_STOP_MAX_MS : HIT_STOP_MAX_MS
    this._hitStopUntil = Math.min(Math.max(this._hitStopUntil || 0, now + ms), now + cap)
  }

  // Brief hit react. Lowest one-shot priority — never override an active shoot.
  playHit() {
    if (!this.ready || this._corpse) return
    if (this._oneShot === (this.shootUpper || this.shootClip)) return // don't stomp a shoot
    this._playOneShot(this.hitUpper || this.hitClip)
  }

  // ---- CORPSE MODE (owned by FragLayer) -----------------------------------
  // Enter/leave corpse mode. On enter we play the DEATH CLIP once and freeze on
  // its last frame (falling back to a procedural tip only if the clip is missing),
  // remembering each material's base tint so darken + restore is exact. On leave
  // we restore pose, tint, opacity + resume idle — the model is reused by the SAME
  // player when they respawn, so leaving MUST be a clean reset.
  setCorpse(on) {
    if (!this.ready || !this.holder) { this._corpse = on; return }
    if (on) {
      if (this._corpse) return // already a corpse; don't re-snapshot
      this._corpse = true
      this._hidden = false
      // stop locomotion + any one-shot so the death clip owns the skeleton
      this._oneShotToken++
      if (this._oneShot) { this._oneShot.onAnimationGroupEndObservable.clear(); this._oneShot.stop(); this._oneShot = null }
      if (this.current) { this.current.stop(); this.current = null }
      // snapshot base tints so we can darken then restore precisely
      if (!this._baseTints) {
        this._baseTints = []
        this.meshes.forEach((m) => {
          const mat = m.material
          if (mat && mat.diffuseColor) {
            this._baseTints.push({
              mat,
              diff: mat.diffuseColor.clone(),
              emis: mat.emissiveColor ? mat.emissiveColor.clone() : null,
            })
          }
        })
      }
      // darken the corpse
      this._baseTints.forEach((t) => {
        t.mat.diffuseColor.copyFrom(t.diff).scaleInPlace(0.4)
        if (t.emis && t.mat.emissiveColor) t.mat.emissiveColor.copyFrom(t.emis).scaleInPlace(0.4)
      })
      this._applyDeathClip()
    } else {
      this._corpse = false
      this._hidden = false
      this._usingDeathClip = false
      // stop the death clip if it was playing
      if (this.deathClip) { this.deathClip.onAnimationGroupEndObservable.clear(); this.deathClip.stop() }
      // restore tint
      if (this._baseTints) {
        this._baseTints.forEach((t) => {
          t.mat.diffuseColor.copyFrom(t.diff)
          if (t.emis && t.mat.emissiveColor) t.mat.emissiveColor.copyFrom(t.emis)
        })
      }
      // restore pose/opacity + resume idle so the reused model is pristine
      this.holder.rotationQuaternion = null
      this.holder.rotation.set(0, 0, 0)
      this.meshes.forEach((m) => { m.visibility = 1 })
      this.holder.setEnabled(this.host.isAlive !== false)
      if (this.idle) { this.idle.start(true, 1.0); this.current = this.idle }
    }
  }

  // Play the death clip once and freeze on the last frame. FragLayer still owns
  // the corpse lifecycle (tint/persist/fade/reset); this just supplies the pose.
  // If the clip is missing we fall back to FragLayer's procedural tip (applyCorpsePose).
  _applyDeathClip() {
    if (!this.deathClip) { this._usingDeathClip = false; return }
    this._usingDeathClip = true
    const clip = this.deathClip
    clip.onAnimationGroupEndObservable.clear()
    clip.onAnimationGroupEndObservable.addOnce(() => {
      // freeze on the last frame (goToFrame the end) — only if still a corpse
      if (!this._corpse || this.disposed) return
      clip.pause()
      clip.goToFrame(clip.to)
    })
    clip.stop()
    // played faster than 1x so the ~2.375s fall completes well inside the 2.5s
    // respawn window (see DEATH_CLIP_SPEED) instead of getting truncated by jitter.
    clip.start(false, DEATH_CLIP_SPEED)
  }

  // hide the visible body outright (gib case: chunks replace the body)
  setHidden(on) {
    this._hidden = !!on
    if (this.holder) this.holder.setEnabled(!this._hidden)
  }

  // tip the body over up to 90deg around a horizontal axis, falling AWAY from the
  // killer (killerYaw = world yaw from victim toward killer). tip is 0..1.
  // FALLBACK ONLY: skipped when the death clip is driving the pose.
  applyCorpsePose(killerYaw, tip) {
    if (!this.holder || this._usingDeathClip) return
    const angle = tip * (Math.PI / 2) // up to 90deg
    // tip axis is horizontal, perpendicular to the killer direction, so the body
    // rotates to fall directly away from the shooter.
    const axis = new BABYLON.Vector3(Math.cos(killerYaw), 0, -Math.sin(killerYaw))
    this.holder.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis, angle)
  }

  // final corpse life: sink into the floor + fade the meshes. k is 0..1.
  setCorpseFade(k) {
    if (!this.holder) return
    this.holder.position.y -= k * 0.02 // gentle sink each frame while k ramps
    const vis = Math.max(0, 1 - k)
    this.meshes.forEach((m) => { m.visibility = vis })
  }

  dispose() {
    this.disposed = true
    if (this._nameTag) { this._nameTag.remove(); this._nameTag = null }
    this._oneShotToken++
    // masked overlays share Animation objects with the source groups; dispose the
    // wrappers first (just releases their animatables), then the source groups.
    if (this.shootUpper) { this.shootUpper.onAnimationGroupEndObservable.clear(); this.shootUpper.dispose() }
    if (this.hitUpper) { this.hitUpper.onAnimationGroupEndObservable.clear(); this.hitUpper.dispose() }
    Object.values(this.groups).forEach((g) => {
      g.onAnimationGroupEndObservable.clear()
      g.dispose()
    })
    if (this._weaponRoot) this._weaponRoot.dispose()
    if (this._helmetRoot) this._helmetRoot.dispose()
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
