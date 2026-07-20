import * as BABYLON from '../babylon.js'

// First-person viewmodel locked to the camera. Parented to the camera node so it
// renders in view space. If the model ships animation clips (per the manifest
// `anims`), it plays an idle loop and one-shot fire/reload/draw clips; otherwise it
// falls back to a code-driven bob + recoil kick. Subtle positional bob is layered on.
//
// STATE MACHINE
// -------------
// The rig is driven by an explicit finite-state controller instead of loose
// booleans. The states and their legal transitions:
//
//   LOADING  --load ok, want active-->  DRAWING (has draw clip) | IDLE
//   LOADING  --load ok, want hidden-->  HIDDEN
//   LOADING  --disposed mid-import-->   DISPOSED (resources cleaned on settle)
//   HIDDEN   --setActive(true)------->  DRAWING | IDLE
//   DRAWING  --draw clip ends--------->  IDLE
//   IDLE     --kick()---------------->   FIRING
//   FIRING   --kick() (auto/semi)---->   FIRING   (restart the fire clip)
//   FIRING   --fire clip ends-------->   IDLE
//   IDLE/FIRING --reload()----------->   RELOADING
//   RELOADING --reload clip ends----->   IDLE
//   RELOADING --cancelReload()------->   IDLE     (base pose restored first)
//   any live --setActive(false)/death-> HIDDEN   (mid clips rewound to base)
//   any --dispose()------------------>  DISPOSED
//
// Every state-changing call bumps a generation token (`_gen`). Animation
// end-callbacks capture the token at scheduling time and no-op if a newer
// transition has superseded them — this is what prevents a stale "fire ended,
// restart idle" callback from firing idle underneath a fresh reload/fire clip.
// Babylon 4.0.3's AnimationGroup.stop() synchronously fires the end observable,
// so superseded one-shot (addOnce) callbacks self-remove the moment we stop a
// clip to start the next one; no clear() of the whole observable is needed
// (clear() would also drop observers owned by other code).
const S = {
  LOADING: 'loading',
  HIDDEN: 'hidden',
  DRAWING: 'drawing',
  IDLE: 'idle',
  FIRING: 'firing',
  RELOADING: 'reloading',
  DISPOSED: 'disposed',
  // ADS (aim-down-sights) sub-states. AIMING_IN/OUT are the one-shot transitions,
  // AIMED is the settled sight-picture (looping breathing/walk aiming), ADS_FIRING
  // is a one-shot fire_aiming that returns to AIMED (if still held) or exits. They
  // are gen-guarded exactly like the hip states, so a stale aim-clip end callback
  // can never drive the rig after a reload/swap/death supersedes it.
  AIMING_IN: 'aiming_in',
  AIMED: 'aimed',
  AIMING_OUT: 'aiming_out',
  ADS_FIRING: 'ads_firing',
}

// ---------------------------------------------------------------------------
// PRELOAD / GPU-WARM (boot preloader, NOT in-match). Parse each weapon GLB so it
// lands in the browser cache and its materials' shaders compile once, then
// dispose the throwaway copy. After this, the first real equip/switch imports
// from a warm browser cache against a warm shader program — no mid-match parse,
// no swap hitch (the RECON anti-pattern is gone).
//
// A RAW import (not a full Viewmodel) is used deliberately: the arms rigs carry
// skeletons, and Babylon 4.0.3 cross-wires two live copies of the same skeleton.
// The live equipped rig (weapon 0) already exists when the preloader runs, so we
// must NOT stand up a second animated/parented copy — parse, compile, dispose.
// The URL is versioned exactly as Viewmodel._load versions it, so the warm fetch
// and the in-match fetch share one cache entry.
export async function warmViewmodel(scene, spec) {
  if (!spec || !spec.url) return
  const url = spec.url
  const slash = url.lastIndexOf('/') + 1
  const version = (typeof window !== 'undefined' && window.__BUILD_ID__)
    ? '?v=' + window.__BUILD_ID__ : ''
  const result = await BABYLON.SceneLoader.ImportMeshAsync(
    '', url.slice(0, slash), url.slice(slash) + version, scene)
  // never render the throwaway copy behind the load overlay (imports at origin,
  // enabled by default).
  result.meshes.forEach((m) => { m.setEnabled(false); m.isPickable = false })
  const seen = new Set()
  result.meshes.forEach((mesh) => {
    const mat = mesh.material
    if (mat && !seen.has(mat) && mat.forceCompilation) {
      seen.add(mat)
      try { mat.forceCompilation(mesh) } catch (e) { /* non-fatal */ }
    }
  })
  result.animationGroups.forEach((g) => g.stop())
  // dispose(false, true): the throwaway warm copy must free its materials + textures
  // too, else every warmed viewmodel rig leaks them. The compiled shader program stays
  // cached at the engine level, so the warm still benefits the real in-match import.
  result.meshes.forEach((m) => m.dispose(false, true))
  result.animationGroups.forEach((g) => g.dispose())
  ;(result.skeletons || []).forEach((s) => s.dispose())
}

export default class Viewmodel {
  constructor(scene, camera, spec) {
    this.scene = scene
    this.camera = camera
    this.spec = spec
    this.ready = false
    this.holder = null
    this.groups = {}
    this.idleAnim = null
    this.fireAnim = null
    this._t = 0

    // explicit FSM state + generation token (see class header)
    this._state = S.LOADING
    this._gen = 0
    this._reloading = false // kept in sync with _state === RELOADING (read by tests/HUD)
    this._drawn = false     // draw clip plays once per equipped instance

    // ADS state. hasAds is resolved in _load() (weapon opted in AND its GLB carries
    // all six baked aim clips). _aimWanted mirrors the held aim input; _aimLoop is
    // which aimed locomotion loop ('breathe'|'walk') is currently running; _lastMoving
    // is the last movement flag seen in update() (used when settling into AIMED).
    this.hasAds = false
    this._aimWanted = false
    this._aimLoop = null
    this._lastMoving = false

    // Spring-based procedural recoil state
    this.recoilPos = new BABYLON.Vector3(0, 0, 0)
    this.recoilPosVel = new BABYLON.Vector3(0, 0, 0)
    this.recoilRot = new BABYLON.Vector3(0, 0, 0)
    this.recoilRotVel = new BABYLON.Vector3(0, 0, 0)

    this.recoilTension = 140   // stiffness of the snap-back spring
    this.recoilDamping = 18    // damping friction

    this._basePos = new BABYLON.Vector3(spec.position.x, spec.position.y, spec.position.z)
    this._baseRotX = (spec.rotation && spec.rotation.x) || 0
    // optional ADS holder framing (centered sight alignment). Falls back to the hip
    // mount, so weapons with a neutral mount / no adsMount are unchanged. The holder
    // blends base -> ads by the aim amount passed into update() (presentation only).
    const _am = spec.adsMount || {}
    const _ap = _am.position || spec.position
    const _ar = _am.rotation || spec.rotation || {}
    this._adsPos = new BABYLON.Vector3(_ap.x || 0, _ap.y || 0, _ap.z || 0)
    this._adsRot = { x: _ar.x || 0, y: _ar.y || 0, z: _ar.z || 0 }
    this._hasAimMount = !!spec.adsMount
    this._wantActive = false // shown only when this is the equipped weapon
    this._disposed = false
    this._cleanupDone = false
    this._disposePromise = null
    this._loadPromise = this._load().catch((error) => {
      this.ready = false
      if (!this._disposed) {
        console.error('Failed to load viewmodel ' + this.spec.name + ':', error)
      }
    })
  }

  async _load() {
    const url = this.spec.url
    const slash = url.lastIndexOf('/') + 1
    // Cache-bust the GLB with the build id so a phone that cached an older weapon
    // (e.g. the pre-fix shotgun) can never keep serving it against fresh JS. The
    // id is shared with the JS bundle + CSS (see scripts/stamp-build.mjs), so a
    // deploy's code and its assets are always fetched as one matched set.
    const version = (typeof window !== 'undefined' && window.__BUILD_ID__)
      ? '?v=' + window.__BUILD_ID__ : ''
    // Babylon 4.0.3's loader result has no transformNodes list, so snapshot the
    // scene around the load to know which joint nodes are ours (dispose() needs
    // them — leaking them piles up dead nodes on every weapon switch).
    const beforeTN = new Set(this.scene.transformNodes)
    const result = await BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash) + version, this.scene)
    this._result = result // kept so dispose() can drop EVERYTHING the load created
    this.meshes = result.meshes

    // Babylon does not dispose imported materials/textures when a mesh is
    // disposed with the default options. Track exactly what this GLB owns so
    // repeated weapon swaps do not grow GPU memory forever.
    const ownedMaterials = new Set()
    result.meshes.forEach((mesh) => {
      if (!mesh.material) return
      ownedMaterials.add(mesh.material)
      ;(mesh.material.subMaterials || []).forEach((material) => {
        if (material) ownedMaterials.add(material)
      })
    })
    this._ownedMaterials = Array.from(ownedMaterials)
    const ownedTextures = new Set()
    this._ownedMaterials.forEach((material) => {
      if (material.getActiveTextures) {
        material.getActiveTextures().forEach((texture) => ownedTextures.add(texture))
      }
    })
    this._ownedTextures = Array.from(ownedTextures)

    // Prefer nodes below the imported root. Unlike a scene-wide before/after
    // snapshot, this remains correct if another importer is active concurrently.
    const importedDescendants = new Set()
    result.meshes.forEach((mesh) => {
      if (mesh.getDescendants) {
        mesh.getDescendants(false).forEach((node) => importedDescendants.add(node))
      }
    })
    const ownedTransformNodes = this.scene.transformNodes.filter((node) => importedDescendants.has(node))
    this._myTransformNodes = ownedTransformNodes.length > 0
      ? ownedTransformNodes
      : this.scene.transformNodes.filter((node) => !beforeTN.has(node))

    // ImportMeshAsync cannot be cancelled. A swap may dispose us while the GLB
    // is still loading, so clean up the completed import before it ever becomes
    // visible or starts an animation.
    if (this._disposed) {
      this._disposeLoadedResources()
      return
    }

    const root = result.meshes[0]

    // fine-tune offset holder, parented to the camera (bob is applied here too)
    this.holder = new BABYLON.TransformNode('viewmodel', this.scene)
    this.holder.parent = this.camera
    this.holder.position.copyFrom(this._basePos)
    const r = this.spec.rotation || {}
    this.holder.rotation = new BABYLON.Vector3(r.x || 0, r.y || 0, r.z || 0)
    this.holder.scaling.setAll(this.spec.scale)

    root.parent = this.holder

    // barrel-tip socket. The manifest authors it CAMERA-local, but it must be
    // parented to the HOLDER so the flash/tracer origin rides the gun through
    // bob + procedural recoil (camera-parented, it hung fixed in view while the
    // gun moved under it — the flash visibly detached from the barrel). Convert
    // the camera-local offset into holder space via the holder's base transform.
    this.muzzle = new BABYLON.TransformNode('muzzle', this.scene)
    this.muzzle.parent = this.holder
    const mz = this.spec.muzzle || { x: 0.08, y: -0.14, z: 0.9 }
    this.muzzle.position.copyFrom(this._cameraLocalToHolder(new BABYLON.Vector3(mz.x, mz.y, mz.z)))

    // it sits right on the camera; never cull it, and light it with the dedicated
    // viewmodel light so arms/gun stay legible regardless of where the player looks.
    const vmLight = this.scene.metadata && this.scene.metadata.viewmodelLight
    result.meshes.forEach((m) => {
      m.alwaysSelectAsActiveMesh = true
      m.layerMask = 0x10000000
      if (vmLight && m.getTotalVertices && m.getTotalVertices() > 0) vmLight.includedOnlyMeshes.push(m)
      const mat = m.material
      if (mat) {
        // a touch of self-illumination on top so it never goes fully black
        const tex = mat.albedoTexture || mat.diffuseTexture
        if (tex) { mat.emissiveTexture = tex; mat.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.25) }
      }
    })

    // wire up animation clips if this model has them
    const anims = this.spec.anims || {}
    // per-weapon playback speed multiplier for one-shot clips (fire/draw/aim/fire_aiming);
    // 1.0 = authored speed. The Shotgun bumps this so its pump/aim read snappier.
    this._animSpeed = this.spec.animSpeed || 1.0
    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    this.idleAnim = this.groups[anims.idle]
    // The fire clip must play UNFILTERED: the pack bakes the arms' IK at export,
    // so only the full clip keeps both hands riding the gun through the recoil.
    // (Runtime "IK" via ctrl_HandIK_* is impossible here — those control bones
    // carry zero skin weights in the exported GLBs.)
    this.fireAnim = this.groups[anims.fire]
    if (this.idleAnim) {
      // fire/reload clips end away from the base pose; blend idle in from the
      // clip's final pose instead of snapping the arms back in a single frame
      this.idleAnim.targetedAnimations.forEach((ta) => {
        ta.animation.enableBlending = true
        ta.animation.blendingSpeed = 0.08
      })
    }
    this.reloadAnim = this.groups[anims.reload]
    this.drawAnim = this.groups[anims.draw]

    // ADS clips (optional). Present only on ads-enabled weapons whose GLB carries the
    // full baked aim group. If the animations are missing, we still support aiming
    // by falling back to a procedural holder-mount alignment.
    this.aimStartAnim = this.groups[anims.aimStart]
    this.aimPoseAnim = this.groups[anims.aimPose]
    this.aimEndAnim = this.groups[anims.aimEnd]
    this.fireAimingAnim = this.groups[anims.fireAiming]
    this.breathingAimingAnim = this.groups[anims.breathingAiming]
    this.walkAimingAnim = this.groups[anims.walkAiming]
    this.hasAds = !!this.spec.ads
    // blend the aimed loops in from the transition's end pose so the handoff
    // aim_start -> breathing/walk_aiming doesn't snap the arms.
    ;[this.breathingAimingAnim, this.walkAimingAnim].forEach((g) => {
      if (g) g.targetedAnimations.forEach((ta) => {
        ta.animation.enableBlending = true
        ta.animation.blendingSpeed = 0.1
      })
    })

    this.ready = true
    this._applyActive() // enter DRAWING/IDLE or HIDDEN depending on equip state
  }

  // ---- FSM core -------------------------------------------------------------

  _setState(state) {
    this._state = state
    this._reloading = state === S.RELOADING
  }

  // Schedule a generation-guarded one-shot end callback. Superseded callbacks
  // (an older token) simply no-op, so a stale clip end can never drive the rig.
  _onEndOnce(group, gen, fn) {
    group.onAnimationGroupEndObservable.addOnce(() => {
      if (this._disposed || gen !== this._gen) return
      fn()
    })
  }

  // Stop a clip, first snapping it to its rest (from) frame so gun-only bones it
  // solely drives (slide/magazine/weapon root) do not freeze mid-swing. In
  // Babylon 4.0.3 goToFrame() applies the sampled value to the target
  // immediately (RuntimeAnimation.setValue), so this deterministically restores
  // the base pose without waiting for another animation pass.
  _rewindStop(group) {
    if (!group) return
    if (group.isPlaying) group.goToFrame(group.from)
    group.stop()
  }

  _startIdleLoop() {
    if (!this.idleAnim) return
    this.idleAnim.stop()
    this.idleAnim.start(true, 1.0)
  }

  // Where a one-shot clip (fire/draw/reload) hands back to a steady state. If aim is
  // being held (the camera is already zooming in the Simulator off the same intent),
  // enter ADS instead of hip idle — otherwise the FOV zooms while the arms stay in
  // hip idle (the "ADS zoomed but no aim animation" bug when RMB is pressed during a
  // shot or a draw). Non-ADS / not-held falls through to the normal idle loop.
  _settleAfterClip() {
    if (!this._wantActive) return
    if (this._aimWanted && this.hasAds) { this._enterAimIn(); return }
    this._setState(S.IDLE)
    this._startIdleLoop()
  }

  // equip/unequip this weapon: toggle visibility and idle animation
  setActive(active) {
    if (this._disposed) return
    this._wantActive = active
    if (this.ready) this._applyActive()
  }

  _applyActive() {
    if (this._disposed || !this.holder) return
    this.holder.setEnabled(this._wantActive)
    if (this._wantActive) {
      this._enterActive()
    } else {
      this._enterHidden()
    }
  }

  // becoming the equipped weapon: play draw once (if any) then settle into idle
  _enterActive() {
    // already the live rig? don't interrupt an in-flight draw/idle/fire/reload
    if (this._state === S.DRAWING || this._state === S.IDLE ||
        this._state === S.FIRING || this._state === S.RELOADING) return

    const gen = ++this._gen
    if (this.drawAnim && !this._drawn) {
      this._drawn = true
      this._setState(S.DRAWING)
      if (this.idleAnim) this.idleAnim.stop()
      this.drawAnim.stop()
      this._onEndOnce(this.drawAnim, gen, () => {
        this._settleAfterClip() // enter ADS if aim is held, else hip idle
      })
      this.drawAnim.start(false, this._animSpeed)
    } else {
      this._setState(S.IDLE)
      this._startIdleLoop()
    }
  }

  // being unequipped (weapon swap, death): rewind any mid-play clip to its base
  // pose and stop everything so the rig re-equips clean, not frozen mid-clip.
  _enterHidden() {
    ++this._gen // invalidate any pending end callbacks
    this._setState(S.HIDDEN)
    // Drop aim on unequip/death: a freshly equipped weapon must NOT auto-remain
    // aimed (brief), so we clear the held-aim intent — the player re-presses to aim
    // the new gun. The Simulator likewise releases its aim on weapon switch.
    this._aimWanted = false
    this._aimLoop = null
    Object.values(this.groups).forEach((g) => this._rewindStop(g))
  }

  // ---- ADS sub-FSM ----------------------------------------------------------
  // True while the rig is in any aimed state (transition or settled). Read by the
  // Simulator/HUD/tests; the camera zoom + sensitivity are driven separately in the
  // Simulator off the raw input, so aim ray safety never depends on this.
  get isAiming() {
    return this._state === S.AIMING_IN || this._state === S.AIMED ||
           this._state === S.ADS_FIRING
  }
  get aimState() { return this._state }

  setAim(down) {
    if (this._disposed || !this.ready || !this._wantActive || !this.hasAds) return
    down = !!down
    if (down === this._aimWanted) return
    this._aimWanted = down
    if (down) {
      // engage from settled hip idle, exit reversal, or interrupt active hip fire or draw
      if (this._state === S.IDLE || this._state === S.AIMING_OUT || this._state === S.FIRING || this._state === S.DRAWING) {
        if (this._state === S.FIRING) {
          this._rewindStop(this.fireAnim)
        } else if (this._state === S.DRAWING) {
          this._rewindStop(this.drawAnim)
        }
        this._enterAimIn()
      }
    } else {
      // exit from transition, settled ADS, or interrupt active ADS fire
      if (this._state === S.AIMING_IN || this._state === S.AIMED || this._state === S.ADS_FIRING) {
        if (this._state === S.ADS_FIRING) {
          this._rewindStop(this.fireAimingAnim)
        }
        this._enterAimOut()
      }
    }
  }

  _stopAimLoops() {
    if (this.breathingAimingAnim) this.breathingAimingAnim.stop()
    if (this.walkAimingAnim) this.walkAimingAnim.stop()
    this._aimLoop = null
  }

  _enterAimIn() {
    const gen = ++this._gen
    this._setState(S.AIMING_IN)
    if (this.aimStartAnim) {
      if (this.idleAnim) this.idleAnim.stop()
      this._stopAimLoops()
      if (this.aimEndAnim) this.aimEndAnim.stop()
      this.aimStartAnim.stop()
      this._onEndOnce(this.aimStartAnim, gen, () => {
        if (!this._wantActive) return
        if (this._aimWanted) this._enterAimed()
        else this._enterAimOut() // released mid-transition -> clean reversible exit
      })
      const inTime = (this.spec.ads && this.spec.ads.inTime) || 0.18
      const fps = (this.aimStartAnim.targetedAnimations[0] &&
        this.aimStartAnim.targetedAnimations[0].animation.framePerSecond) || 60
      const normalDuration = (this.aimStartAnim.to - this.aimStartAnim.from) / fps
      const speedRatio = normalDuration / inTime
      this.aimStartAnim.start(false, speedRatio * this._animSpeed)
    } else {
      this._enterAimed()
    }
  }

  _enterAimed() {
    this._setState(S.AIMED)
    if (this.aimStartAnim) this.aimStartAnim.stop()
    this._aimLoop = null
    this._updateAimedLocomotion(this._lastMoving) // start the correct aimed loop now
  }

  _enterAimOut() {
    const gen = ++this._gen
    this._setState(S.AIMING_OUT)
    if (this.aimEndAnim) {
      this._stopAimLoops()
      if (this.aimStartAnim) this.aimStartAnim.stop()
      this.aimEndAnim.stop()
      this._onEndOnce(this.aimEndAnim, gen, () => {
        if (!this._wantActive) return
        if (this._aimWanted) this._enterAimIn() // re-pressed during exit
        else { this._setState(S.IDLE); this._startIdleLoop() }
      })
      const outTime = (this.spec.ads && this.spec.ads.outTime) || 0.15
      const fps = (this.aimEndAnim.targetedAnimations[0] &&
        this.aimEndAnim.targetedAnimations[0].animation.framePerSecond) || 60
      const normalDuration = (this.aimEndAnim.to - this.aimEndAnim.from) / fps
      const speedRatio = normalDuration / outTime
      this.aimEndAnim.start(false, speedRatio * this._animSpeed)
    } else {
      this._setState(S.IDLE)
      this._startIdleLoop()
    }
  }

  // pick breathing (stationary) vs walk (moving) aimed loop; only swaps on change.
  _updateAimedLocomotion(moving) {
    if (this._state !== S.AIMED) return
    const want = moving ? 'walk' : 'breathe'
    if (this._aimLoop === want) return
    this._aimLoop = want
    const on = moving ? this.walkAimingAnim : this.breathingAimingAnim
    const off = moving ? this.breathingAimingAnim : this.walkAimingAnim
    if (off) off.stop()
    if (on) { on.stop(); on.start(true, this._animSpeed) }
  }

  get isReloading() { return this._state === S.RELOADING }

  _cameraLocalToHolder(camLocal) {
    const r = this.spec.rotation || {}
    const q = BABYLON.Quaternion.FromEulerAngles(r.x || 0, r.y || 0, r.z || 0)
    const s = this.spec.scale || 1
    const base = BABYLON.Matrix.Compose(
      new BABYLON.Vector3(s, s, s), q, this._basePos)
    return BABYLON.Vector3.TransformCoordinates(camLocal, base.invert())
  }

  _cameraMuzzlePos(adsT) {
    const mz = this.spec.muzzle || { x: 0.08, y: -0.14, z: 0.9 }
    const a = this._hasAimMount ? Math.max(0, Math.min(1, adsT)) : 0

    // Aimed muzzle Y estimate: sights are aligned at Y=0, barrel is slightly below
    // (typically around -0.05 to -0.08 depending on weapon receiver height).
    let aimedY = mz.y
    if (this.spec.name === 'Rifle' || this.spec.name === 'Plasma' || this.spec.name === 'SMG') {
      aimedY = -0.06
    } else if (this.spec.name === 'Shotgun') {
      aimedY = -0.07
    } else if (this.spec.name === 'Pistol') {
      aimedY = -0.03
    }

    const mx = mz.x * (1 - a)
    const my = mz.y + (aimedY - mz.y) * a
    const mz_val = mz.z

    return new BABYLON.Vector3(mx, my, mz_val)
  }

  _cameraLocalToHolderClean(camLocal, adsT) {
    const a = this._hasAimMount ? Math.max(0, Math.min(1, adsT)) : 0
    const baseRotY = (this.spec.rotation && this.spec.rotation.y) || 0
    const baseRotZ = (this.spec.rotation && this.spec.rotation.z) || 0
    const rX = this._baseRotX + (this._adsRot.x - this._baseRotX) * a
    const rY = baseRotY + (this._adsRot.y - baseRotY) * a
    const rZ = baseRotZ + (this._adsRot.z - baseRotZ) * a
    const q = BABYLON.Quaternion.FromEulerAngles(rX, rY, rZ)

    const s = this.spec.scale || 1
    const mx = this._basePos.x + (this._adsPos.x - this._basePos.x) * a
    const my = this._basePos.y + (this._adsPos.y - this._basePos.y) * a
    const mz = this._basePos.z + (this._adsPos.z - this._basePos.z) * a
    const cleanPos = new BABYLON.Vector3(mx, my, mz)

    const cleanMatrix = BABYLON.Matrix.Compose(
      new BABYLON.Vector3(s, s, s), q, cleanPos)

    return BABYLON.Vector3.TransformCoordinates(camLocal, cleanMatrix.invert())
  }

  // world-space barrel tip (for muzzle flash / tracer origin)
  muzzleWorldPos() {
    if (this._disposed || !this.muzzle) return null
    this.muzzle.computeWorldMatrix(true)
    return this.muzzle.getAbsolutePosition()
  }

  cancelReload() {
    if (this._disposed || this._state !== S.RELOADING) return
    ++this._gen // invalidate the pending reload-end callback
    // Rewind the reload clip to its rest frame BEFORE stopping: it is the only
    // clip driving some gun bones (slide/magazine/weapon root), so a bare
    // mid-clip stop would freeze the gun away from the hands.
    this._rewindStop(this.reloadAnim)
    if (this.idleAnim) {
      // snap arm bones out of the reload pose before idle blends back in
      this._rewindStop(this.idleAnim)
    }
    this._setState(S.IDLE)
    if (this._wantActive) {
      if (this._aimWanted && this.hasAds) this._enterAimIn()
      else this._startIdleLoop()
    }
  }

  // play the reload clip once (arms + gun bones together: mag out, charge, etc.),
  // then hand back to idle. Firing is blocked while it runs (gated by Simulator).
  reload() {
    if (this._disposed || !this._wantActive || !this.ready) return false
    if (this._state === S.RELOADING || this._state === S.DRAWING || !this.reloadAnim) return false

    const gen = ++this._gen
    this._setState(S.RELOADING)
    if (this.idleAnim) this.idleAnim.stop()
    if (this.fireAnim) this.fireAnim.stop() // fires the stale fire-end cb (gen-guarded no-op)
    // reload immediately exits ADS (brief): stop the aim transitions + loops so the
    // hip reload plays clean. The Simulator suppresses the zoom while reloading, so
    // the camera and the arms agree.
    if (this.hasAds) {
      if (this.aimStartAnim) this.aimStartAnim.stop()
      if (this.aimEndAnim) this.aimEndAnim.stop()
      if (this.fireAimingAnim) this.fireAimingAnim.stop()
      this._stopAimLoops()
    }
    this.reloadAnim.stop()
    this._onEndOnce(this.reloadAnim, gen, () => {
      // re-aim after reload only if the trigger for aim is still held
      if (this._aimWanted && this.hasAds && this._wantActive) { this._enterAimIn(); return }
      this._setState(S.IDLE)
      if (this._wantActive) this._startIdleLoop()
    })

    // stretch/squash the clip so its wall-clock matches the gameplay reloadTime.
    // Babylon 9's glTF loader tags imported animations with framePerSecond=60
    // (4.0.3 effectively authored them at 1), so the clip's native length is
    // (to-from)/fps SECONDS, not (to-from) seconds. Dividing by fps keeps the
    // speedRatio a true seconds/seconds ratio; omitting it played the reload ~60x
    // too fast (the whole clip in a single frame) under 9.x.
    const fps = (this.reloadAnim.targetedAnimations[0] &&
      this.reloadAnim.targetedAnimations[0].animation.framePerSecond) || 60
    const normalDuration = (this.reloadAnim.to - this.reloadAnim.from) / fps
    const reloadTime = this.spec.reloadTime || 1.5
    const speedRatio = normalDuration / reloadTime
    this.reloadAnim.start(false, speedRatio * this._animSpeed)
    return true
  }

  // called when the local player fires (once per shot, auto or semi).
  // `profile` is the weapon's vmKick preset (firingFx): absolute impulse values
  // plus spring params, so each gun has its own recoil PERSONALITY — snappy
  // pistol flick, buzzy SMG chatter, heavy slow-recover shotgun shove (with a
  // delayed pump-rack impulse). No profile falls back to the legacy
  // recoilForce-scaled kick.
  kick(profile) {
    if (this._disposed || !this.ready || !this._wantActive) return
    if (this._state === S.RELOADING) return

    if (this._state === S.DRAWING) {
      if (this.drawAnim) this.drawAnim.stop()
    }

    // aimed shots play fire_aiming and hold the sight picture; the recoil is also
    // damped below so it doesn't fight the authored aimed-fire motion.
    const aimed = this.hasAds && (this._state === S.AIMED ||
      this._state === S.ADS_FIRING || this._state === S.AIMING_IN)

    // Inject procedural spring recoil velocities (backward kick in Z, slight
    // pitch up in X, slight horizontal jar)
    if (profile) {
      this.recoilTension = profile.tension || 140
      this.recoilDamping = profile.damping || 18
      // per-shot variance (Vlambeer "vary everything"): scale the deterministic
      // back/up/pitch impulses by (1 ± variance/2) so a burst never reads as a
      // metronome. variance 0 => identical to the old deterministic kick.
      const vAmt = profile.variance || 0
      const vary = 1 - vAmt * 0.5 + Math.random() * vAmt
      this.recoilPosVel.z -= (profile.back || 0.5) * vary
      this.recoilPosVel.y += (profile.up || 0.06) * vary
      this.recoilRotVel.x -= (profile.pitch || 0.35) * vary
      this.recoilRotVel.y += (Math.random() - 0.5) * (profile.yaw || 0.06)
      // roll impulse (random sign): the Z rot spring already exists + integrates
      // every frame but was never excited — cheapest "alive" win. Never touches aim.
      if (profile.roll) this.recoilRotVel.z += (Math.random() - 0.5) * 2 * profile.roll
      if (profile.pump) {
        // second, smaller shove when the action racks (shell out + clack land
        // on the same beat via Simulator's pump audio/casing delay)
        const gen = this._gen
        setTimeout(() => {
          // superseded by a swap/reload/hide (each bumps _gen) or unequipped
          if (this._disposed || gen !== this._gen || !this._wantActive) return
          this.recoilPosVel.z -= profile.pump.back || 0.3
          this.recoilRotVel.x += profile.pump.pitch || 0.2 // muzzle dips as the arm racks
        }, profile.pump.delay || 350)
      }
    } else {
      const kickForce = this.spec.recoilForce || 1.0
      this.recoilPosVel.z -= 0.6 * kickForce
      this.recoilPosVel.y += 0.08 * kickForce
      this.recoilRotVel.x -= 0.4 * kickForce
      this.recoilRotVel.y += (Math.random() - 0.5) * 0.08 * kickForce
    }

    if (aimed) { this.recoilPosVel.scaleInPlace(0.6); this.recoilRotVel.scaleInPlace(0.6) }

    // aimed fire: play fire_aiming once, then return to the sight picture (if still
    // held) or exit ADS. The recoil above already fired, so the shot is never dropped.
    if (aimed && this.fireAimingAnim) {
      const gen = ++this._gen
      this._setState(S.ADS_FIRING)
      this._stopAimLoops()
      if (this.idleAnim) this.idleAnim.stop()
      this.fireAimingAnim.stop()
      this._onEndOnce(this.fireAimingAnim, gen, () => {
        if (!this._wantActive) return
        if (this._aimWanted) this._enterAimed()
        else this._enterAimOut()
      })
      this.fireAimingAnim.start(false, this._animSpeed)
      return
    }

    if (!this.fireAnim) return

    const gen = ++this._gen
    this._setState(S.FIRING)
    if (this.idleAnim) this.idleAnim.stop()
    // stop() fires the previous fire clip's end observable; the older token makes
    // it a no-op, so rapid auto-fire restarts the clip with no idle flicker under
    // it. On the LAST shot the completing clip's callback (current token) settles
    // us back to idle — semi-auto stays edge-correct because each click is one kick.
    this.fireAnim.stop()
    this._onEndOnce(this.fireAnim, gen, () => {
      if (this._state !== S.FIRING || !this._wantActive) return
      this._settleAfterClip() // enter ADS if aim is held (fixes zoom-but-no-aim), else idle
    })
    this.fireAnim.start(false, this._animSpeed)
  }

  update(delta, moving, adsT = 0) {
    if (this._disposed || !this.ready || !this.holder) return

    this._t += delta
    this._lastMoving = moving
    // keep the aimed locomotion loop in sync with movement while settled-aimed
    if (this._state === S.AIMED) this._updateAimedLocomotion(moving)

    // subtle idle/walk bob layered on top of any skeletal animation. While aiming,
    // damp it hard so it doesn't fight the authored breathing_aiming / walk_aiming.
    const aiming = this.hasAds && (this._state === S.AIMING_IN || this._state === S.AIMED ||
      this._state === S.ADS_FIRING || this._state === S.AIMING_OUT)
    const bobScale = aiming ? 0.2 : 1
    const amp = (moving ? 0.02 : 0.006) * bobScale
    const freq = moving ? 9 : 2.5
    const bobY = Math.sin(this._t * freq) * amp
    const bobX = Math.cos(this._t * freq * 0.5) * amp * 0.6

    // Update position and rotation springs for procedural recoil
    const dt = Math.min(delta, 0.05) // Cap dt to avoid spring instability on frame drops

    // Position spring: Accel = -Tension * Pos - Damping * Vel
    const posAcc = this.recoilPos.scale(-this.recoilTension).subtract(this.recoilPosVel.scale(this.recoilDamping))
    this.recoilPosVel.addInPlace(posAcc.scale(dt))
    this.recoilPos.addInPlace(this.recoilPosVel.scale(dt))

    // Rotation spring: Accel = -Tension * Rot - Damping * Vel
    const rotAcc = this.recoilRot.scale(-this.recoilTension).subtract(this.recoilRotVel.scale(this.recoilDamping))
    this.recoilRotVel.addInPlace(rotAcc.scale(dt))
    this.recoilRot.addInPlace(this.recoilRotVel.scale(dt))

    // Blend the holder from the hip mount to the ADS (centered) mount by the aim
    // amount, THEN add bob + spring recoil. For weapons without an adsMount this is a
    // no-op (a=0). This is the presentation-only sight-alignment offset the brief
    // allows — it never touches the camera orientation or the aim ray.
    const a = this._hasAimMount ? Math.max(0, Math.min(1, adsT)) : 0
    const baseRotY = (this.spec.rotation && this.spec.rotation.y) || 0
    const baseRotZ = (this.spec.rotation && this.spec.rotation.z) || 0
    const mx = this._basePos.x + (this._adsPos.x - this._basePos.x) * a
    const my = this._basePos.y + (this._adsPos.y - this._basePos.y) * a
    const mz = this._basePos.z + (this._adsPos.z - this._basePos.z) * a
    const rX = this._baseRotX + (this._adsRot.x - this._baseRotX) * a
    const rY = baseRotY + (this._adsRot.y - baseRotY) * a
    const rZ = baseRotZ + (this._adsRot.z - baseRotZ) * a
    this.holder.position.set(mx + bobX + this.recoilPos.x, my + bobY + this.recoilPos.y, mz + this.recoilPos.z)
    this.holder.rotation.set(rX + this.recoilRot.x, rY + this.recoilRot.y, rZ + this.recoilRot.z)

    if (this.muzzle) {
      const localMuzzle = this._cameraMuzzlePos(adsT)
      this.muzzle.position.copyFrom(this._cameraLocalToHolderClean(localMuzzle, adsT))
    }
  }

  _disposeLoadedResources() {
    if (this._cleanupDone) return
    this._cleanupDone = true

    if (this._afterAnimationsObserver) {
      this.scene.onAfterAnimationsObservable.remove(this._afterAnimationsObserver)
      this._afterAnimationsObserver = null
    }

    // Dispose EVERYTHING the import created. Identically named skeletons can
    // cross-wire each other's linked transform nodes in Babylon 4.0.3.
    if (this._result) {
      this._result.animationGroups.forEach((group) => group.dispose())
      this._result.meshes.forEach((mesh) => mesh.dispose())
      ;(this._myTransformNodes || []).forEach((node) => node.dispose())
      ;(this._result.skeletons || []).forEach((skeleton) => skeleton.dispose())
      ;(this._result.particleSystems || []).forEach((system) => system.dispose())
    }
    ;(this._ownedMaterials || []).forEach((material) => material.dispose(true, true))
    ;(this._ownedTextures || []).forEach((texture) => texture.dispose())
    if (this.muzzle) this.muzzle.dispose()
    if (this.holder) this.holder.dispose()

    this.ready = false
    this.muzzle = null
    this.holder = null
    this.meshes = []
    this.groups = {}
    this._myTransformNodes = []
    this._ownedMaterials = []
    this._ownedTextures = []
    this._result = null
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise

    this._disposed = true
    this._wantActive = false
    this.ready = false
    this._setState(S.DISPOSED)
    if (this.holder) this.holder.setEnabled(false)

    // If the import is still in flight, cleanup runs as soon as it settles.
    // Returning the promise lets the simulator serialize the next GLB import.
    this._disposePromise = Promise.resolve(this._loadPromise)
      .catch(() => undefined)
      .then(() => this._disposeLoadedResources())
    return this._disposePromise
  }
}
