import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader

// A visual character bound to (but not parented to) a host transform — typically
// another player's replicated collision box. Each frame it copies the host's
// position + yaw and picks idle/run from how fast the host is moving. Pitch is
// intentionally ignored so bodies don't tilt when a player looks up/down.
//
// NB: Babylon 4.0.3 has no AssetContainer.instantiateModelsToScene, so we import
// a fresh copy per entity via ImportMeshAsync (the HTTP fetch is browser-cached).
// Fine for a handful of players; revisit with true GPU instancing if it scales.
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

    // tag body meshes so a shot that lands on a player reads as a flesh/blood impact
    // (and drives the local player's predicted hit marker). See firingFx.classifySurface.
    result.meshes.forEach((m) => {
      m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
    })

    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    this.idle = this.groups[this.spec.anims.idle]
    this.run = this.groups[this.spec.anims.run]
    if (this.idle) { this.idle.start(true, 1.0); this.current = this.idle }
    this.ready = true
  }

  update(delta) {
    if (!this.ready || !this.holder || this.disposed) return
    const p = this.host.position

    this.holder.setEnabled(this.host.isAlive !== false)
    this.holder.position.set(p.x, p.y + this.spec.yOffset, p.z)
    this.holder.rotation.y = this.host.rotation.y + (this.spec.yawOffset || 0)

    const dx = p.x - this._lastX
    const dz = p.z - this._lastZ
    this._lastX = p.x
    this._lastZ = p.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(delta, 1 / 240)

    const target = speed > 0.4 ? (this.run || this.idle) : this.idle
    if (target && target !== this.current) {
      if (this.current) this.current.stop()
      target.start(true, 1.0)
      this.current = target
    }
  }

  dispose() {
    this.disposed = true
    Object.values(this.groups).forEach((g) => g.dispose())
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
