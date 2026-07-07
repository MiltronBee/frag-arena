import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader

// First-person viewmodel locked to the camera. Parented to the camera node so it
// renders in view space. If the model ships animation clips (per the manifest
// `anims`), it plays an idle loop and a one-shot fire clip; otherwise it falls back
// to a code-driven bob + recoil kick. Subtle positional bob is layered on either way.
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
    this._recoil = 0 // 0..1, decays each frame (fallback recoil when un-animated)
    this._basePos = new BABYLON.Vector3(spec.position.x, spec.position.y, spec.position.z)
    this._baseRotX = (spec.rotation && spec.rotation.x) || 0
    this._wantActive = false // shown only when this is the equipped weapon
    this._load()
  }

  async _load() {
    const url = this.spec.url
    const slash = url.lastIndexOf('/') + 1
    // Babylon 4.0.3's loader result has no transformNodes list, so snapshot the
    // scene around the load to know which joint nodes are ours (dispose() needs
    // them — leaking them piles up dead nodes on every weapon switch).
    const beforeTN = new Set(this.scene.transformNodes)
    const result = await BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), this.scene)
    this._myTransformNodes = this.scene.transformNodes.filter((n) => !beforeTN.has(n))

    this._result = result // kept so dispose() can drop EVERYTHING the load created
    this.meshes = result.meshes
    const root = result.meshes[0]

    // fine-tune offset holder, parented to the camera (bob is applied here too)
    this.holder = new BABYLON.TransformNode('viewmodel', this.scene)
    this.holder.parent = this.camera
    this.holder.position.copyFrom(this._basePos)
    const r = this.spec.rotation || {}
    this.holder.rotation = new BABYLON.Vector3(r.x || 0, r.y || 0, r.z || 0)
    this.holder.scaling.setAll(this.spec.scale)

    root.parent = this.holder

    // barrel-tip socket (camera-local, from the manifest): muzzle flash + the local
    // tracer originate here so shots visibly leave the gun
    this.muzzle = new BABYLON.TransformNode('muzzle', this.scene)
    this.muzzle.parent = this.camera
    const mz = this.spec.muzzle || { x: 0.08, y: -0.14, z: 0.9 }
    this.muzzle.position.set(mz.x, mz.y, mz.z)

    // it sits right on the camera; never cull it, and light it with the dedicated
    // viewmodel light so arms/gun stay legible regardless of where the player looks.
    const vmLight = this.scene.metadata && this.scene.metadata.viewmodelLight
    result.meshes.forEach((m) => {
      m.alwaysSelectAsActiveMesh = true
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
    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    this.idleAnim = this.groups[anims.idle]
    this.fireAnim = this.groups[anims.fire]
    this.reloadAnim = this.groups[anims.reload]
    this.drawAnim = this.groups[anims.draw]

    this.ready = true
    this._applyActive() // show/hide + idle depending on whether we're equipped
  }

  // equip/unequip this weapon: toggle visibility and idle animation
  setActive(active) {
    this._wantActive = active
    if (this.ready) this._applyActive()
  }

  _applyActive() {
    if (!this.holder) return
    this.holder.setEnabled(this._wantActive)
    if (this._wantActive) {
      // equip: play the weapon-raise (draw) once, then settle into idle
      if (this.drawAnim && !this._drawn) {
        this._drawn = true
        this._drawing = true
        this.drawAnim.start(false, 1.0)
        this.drawAnim.onAnimationGroupEndObservable.clear()
        this.drawAnim.onAnimationGroupEndObservable.addOnce(() => {
          this._drawing = false
          if (this._wantActive && this.idleAnim) this.idleAnim.start(true, 1.0)
        })
      } else if (this.idleAnim && !this.idleAnim.isPlaying) {
        this.idleAnim.start(true, 1.0)
      }
    } else {
      this._reloading = false
      this._drawing = false
      Object.values(this.groups).forEach((g) => g.stop())
    }
  }

  get isReloading() { return !!this._reloading }

  // world-space barrel tip (for muzzle flash / tracer origin)
  muzzleWorldPos() {
    if (!this.muzzle) return null
    this.muzzle.computeWorldMatrix(true)
    return this.muzzle.getAbsolutePosition()
  }

  // play the reload clip once (arms + gun bones together: mag out, charge, etc.),
  // then hand back to idle. Firing is blocked while it runs.
  reload() {
    if (!this._wantActive || !this.ready || this._reloading || this._drawing || !this.reloadAnim) return false
    this._reloading = true
    if (this.idleAnim) this.idleAnim.stop()
    if (this.fireAnim) this.fireAnim.stop()
    this.reloadAnim.stop()
    this.reloadAnim.start(false, 1.0)
    this.reloadAnim.onAnimationGroupEndObservable.clear()
    this.reloadAnim.onAnimationGroupEndObservable.addOnce(() => {
      this._reloading = false
      if (this._wantActive && this.idleAnim) this.idleAnim.start(true, 1.0)
    })
    return true
  }

  // called when the local player fires
  kick() {
    if (!this._wantActive || this._reloading || this._drawing) return
    if (this.fireAnim) {
      // play the fire clip once, then hand back to idle
      this.fireAnim.stop()
      this.fireAnim.start(false, 1.0)
      if (this.idleAnim) {
        this.fireAnim.onAnimationGroupEndObservable.clear()
        this.fireAnim.onAnimationGroupEndObservable.addOnce(() => {
          // stop() also fires this observable — don't restart idle mid-reload
          if (!this._reloading && this._wantActive) this.idleAnim.start(true, 1.0)
        })
      }
    } else {
      this._recoil = 1 // fallback for un-animated models
    }
  }

  update(delta, moving) {
    if (!this.ready || !this.holder) return
    this._t += delta

    // subtle idle/walk bob layered on top of any skeletal animation
    const amp = moving ? 0.02 : 0.006
    const freq = moving ? 9 : 2.5
    const bobY = Math.sin(this._t * freq) * amp
    const bobX = Math.cos(this._t * freq * 0.5) * amp * 0.6

    // fallback recoil (only used when there's no fire clip)
    this._recoil = Math.max(0, this._recoil - delta * 7)
    const k = this._recoil

    this.holder.position.set(
      this._basePos.x + bobX,
      this._basePos.y + bobY + k * 0.03,
      this._basePos.z - k * 0.1
    )
    this.holder.rotation.x = this._baseRotX - k * 0.2
  }

  dispose() {
    // dispose EVERYTHING the load created — leaked skeletons/transform-nodes with
    // identical bone names cross-wire the next rig's pose in Babylon 4.0.3.
    if (this._result) {
      this._result.animationGroups.forEach((g) => g.dispose())
      this._result.meshes.forEach((m) => m.dispose())
      ;(this._myTransformNodes || []).forEach((n) => n.dispose())
      ;(this._result.skeletons || []).forEach((s) => s.dispose())
      ;(this._result.particleSystems || []).forEach((p) => p.dispose())
    }
    if (this.muzzle) this.muzzle.dispose()
    if (this.holder) this.holder.dispose()
  }
}
