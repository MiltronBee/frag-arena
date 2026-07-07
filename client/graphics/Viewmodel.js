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
    const result = await BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), this.scene)

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
      if (this.idleAnim && !this.idleAnim.isPlaying) this.idleAnim.start(true, 1.0)
    } else {
      Object.values(this.groups).forEach((g) => g.stop())
    }
  }

  // called when the local player fires
  kick() {
    if (!this._wantActive) return
    if (this.fireAnim) {
      // play the fire clip once, then hand back to idle
      this.fireAnim.stop()
      this.fireAnim.start(false, 1.0)
      if (this.idleAnim) {
        this.fireAnim.onAnimationGroupEndObservable.clear()
        this.fireAnim.onAnimationGroupEndObservable.addOnce(() => this.idleAnim.start(true, 1.0))
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
    Object.values(this.groups).forEach((g) => g.dispose())
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
