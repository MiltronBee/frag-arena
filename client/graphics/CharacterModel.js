import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader
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
    this._weaponReqId = 0     // serialize async weapon swaps
    this._lastX = host.position.x
    this._lastZ = host.position.z
    this._load()
  }

  async _load() {
    const slash = this.spec.url.lastIndexOf('/') + 1
    const rootUrl = this.spec.url.slice(0, slash)
    const fileName = this.spec.url.slice(slash)

    const result = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene)
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
    this.shootClip = this.groups[this.spec.anims.shoot]
    this.hitClip = this.groups[this.spec.anims.hit]
    this.deathClip = this.groups[this.spec.anims.death]
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
      return
    }

    // Normal death: hide instantly when isAlive is false AND no corpse animation
    // is running (e.g. a death we never saw a Killed message for). A live corpse
    // animation takes priority via the early return above.
    this.holder.setEnabled(this.host.isAlive !== false)
    this.holder.position.set(p.x, p.y + this.spec.yOffset, p.z)
    this.holder.rotation.y = this.host.rotation.y + (this.spec.yawOffset || 0)

    const dx = p.x - this._lastX
    const dz = p.z - this._lastZ
    this._lastX = p.x
    this._lastZ = p.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(delta, 1 / 240)

    // A shoot/hit one-shot is playing on top of locomotion. We keep the base
    // locomotion clip running underneath (so the legs still stride); the overlay
    // group blends on the shared skeleton. Locomotion selection continues below
    // so that when the one-shot ends we're already on the right base clip.
    const target = speed > 0.4 ? (this.run || this.idle) : this.idle
    if (target && target !== this.current) {
      if (this.current) this.current.stop()
      target.start(true, 1.0)
      this.current = target
    }
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
    this._playOneShot(this.shootClip)
  }

  // Brief hit react. Lowest one-shot priority — never override an active shoot.
  playHit() {
    if (!this.ready || this._corpse) return
    if (this._oneShot === this.shootClip) return // don't stomp a shoot
    this._playOneShot(this.hitClip)
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
    clip.start(false, 1.0)
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
    this._oneShotToken++
    Object.values(this.groups).forEach((g) => {
      g.onAnimationGroupEndObservable.clear()
      g.dispose()
    })
    if (this._weaponRoot) this._weaponRoot.dispose()
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
