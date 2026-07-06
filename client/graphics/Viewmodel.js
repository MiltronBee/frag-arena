import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader

// First-person weapon locked to the camera. Parented to the camera node so it
// renders in view space; adds a subtle idle/walk bob and a recoil kick on fire.
// All placement comes from the manifest so a real animated arms+gun swaps in here.
export default class Viewmodel {
  constructor(scene, camera, spec) {
    this.scene = scene
    this.camera = camera
    this.spec = spec
    this.ready = false
    this.holder = null
    this._t = 0
    this._recoil = 0 // 0..1, decays each frame
    this._basePos = new BABYLON.Vector3(spec.position.x, spec.position.y, spec.position.z)
    this._baseRotX = (spec.rotation && spec.rotation.x) || 0
    this._load()
  }

  async _load() {
    const url = this.spec.url
    const slash = url.lastIndexOf('/') + 1
    const result = await BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), this.scene)

    this.holder = new BABYLON.TransformNode('viewmodel', this.scene)
    this.holder.parent = this.camera
    result.meshes[0].parent = this.holder
    this.meshes = result.meshes

    this.holder.position.copyFrom(this._basePos)
    const r = this.spec.rotation || {}
    this.holder.rotation = new BABYLON.Vector3(r.x || 0, r.y || 0, r.z || 0)
    this.holder.scaling.setAll(this.spec.scale)

    // it sits right on the camera; never cull it and keep it out of the near clip
    result.meshes.forEach((m) => { m.alwaysSelectAsActiveMesh = true })
    this.ready = true
  }

  // called when the local player fires
  kick() { this._recoil = 1 }

  update(delta, moving) {
    if (!this.ready || !this.holder) return
    this._t += delta

    // idle/walk bob
    const amp = moving ? 0.02 : 0.006
    const freq = moving ? 9 : 2.5
    const bobY = Math.sin(this._t * freq) * amp
    const bobX = Math.cos(this._t * freq * 0.5) * amp * 0.6

    // recoil decays quickly; pushes the gun back (toward camera) and tilts it up
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
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
