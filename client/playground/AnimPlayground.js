import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader
import { assets, tpWeapons } from '../assets/assetManifest'

// ---------------------------------------------------------------------------
// ANIM PLAYGROUND — a client-only clip inspector. No server, no netcode.
// Loads the character rig, enumerates ALL of its animation groups, and lets us
// play/loop/scrub each one to pick correct clips for the gameplay roles
// (idle/run/shoot/hit/death). Boots by default from clientMain.js; the real
// game is reachable at ?game.
//
// Rig recipe mirrors client/graphics/CharacterModel.js:
//  - ImportMeshAsync, parent meshes[0] under a scaled holder (tames the glTF
//    __root__ 180deg handedness flip via yawOffset)
//  - CRITICAL Babylon 4.0.3 quirk: the 65-bone rig stores its matrices in a
//    texture, so the skinned mesh stays frozen at bind pose unless we call
//    skeleton.prepare() EVERY FRAME.
//  - weapon props mount to the hand bone's linked TransformNode.
// ---------------------------------------------------------------------------

const WEAPON_NAMES = ['Rifle', 'SMG', 'Shotgun', 'Pistol']
const ROLES = ['idle', 'run', 'shoot', 'hit', 'death']
const FPS = 30 // UAL clips are authored ~30fps; used only for the duration readout

export default class AnimPlayground {
  constructor() {
    this.canvas = document.getElementById('main-canvas')
    this.engine = new BABYLON.Engine(this.canvas, true, { stencil: true }, true)
    this.scene = new BABYLON.Scene(this.engine)
    this.scene.clearColor = new BABYLON.Color4(0.11, 0.13, 0.16, 1)

    this.gender = 'male'          // 'male' | 'female'
    this.holder = null
    this.meshes = []
    this.skeleton = null
    this.groups = []              // [{ name, group }]
    this.byName = new Map()
    this.current = null           // active AnimationGroup
    this.currentName = null
    this.loop = true
    this.speed = 1.0
    this.weaponIndex = -1         // -1 = none
    this._weaponRoot = null
    this._loadToken = 0
    // role -> clip name, seeded from the manifest so we can diff our picks
    this.mapping = Object.assign(
      { idle: '', run: '', jump: '', shoot: '', hit: '', death: '' },
      assets.playerBody.anims,
    )

    this._hideGameHud()
    this._buildScene()
    this._buildUi()
    this._loadModel()

    this.scene.onBeforeRenderObservable.add(() => {
      // keep the skinned mesh in sync with the animated bone TransformNodes
      if (this.skeleton) this.skeleton.prepare()
      this._updateReadout()
    })
    this.engine.runRenderLoop(() => this.scene.render())
    window.addEventListener('resize', () => this.engine.resize())
    window.addEventListener('keydown', (e) => this._onKey(e))
  }

  // ---- SCENE --------------------------------------------------------------
  _buildScene() {
    const cam = new BABYLON.ArcRotateCamera(
      'pgCam', Math.PI * 1.5, Math.PI / 2.4, 4.2,
      new BABYLON.Vector3(0, 1.0, 0), this.scene,
    )
    cam.attachControl(this.canvas, true)
    cam.wheelDeltaPercentage = 0.02
    cam.lowerRadiusLimit = 1.2
    cam.upperRadiusLimit = 20
    cam.minZ = 0.05
    this.camera = cam

    const hemi = new BABYLON.HemisphericLight('pgHemi', new BABYLON.Vector3(0, 1, 0), this.scene)
    hemi.intensity = 0.85
    const dir = new BABYLON.DirectionalLight('pgDir', new BABYLON.Vector3(-0.5, -1, -0.6), this.scene)
    dir.intensity = 0.9
    dir.position = new BABYLON.Vector3(6, 10, 6)

    // checkerboard ground (no babylonjs-materials dep available -> DynamicTexture)
    const ground = BABYLON.MeshBuilder.CreateGround('pgGround', { width: 20, height: 20 }, this.scene)
    const tex = new BABYLON.DynamicTexture('pgGrid', { width: 512, height: 512 }, this.scene, false)
    const ctx = tex.getContext()
    const cells = 16
    const s = 512 / cells
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#20272e' : '#161b21'
        ctx.fillRect(x * s, y * s, s, s)
      }
    }
    tex.update()
    tex.uScale = 1
    tex.vScale = 1
    const gmat = new BABYLON.StandardMaterial('pgGroundMat', this.scene)
    gmat.diffuseTexture = tex
    gmat.specularColor = new BABYLON.Color3(0, 0, 0)
    ground.material = gmat

    // origin marker so drift / root-motion is obvious
    const axis = BABYLON.MeshBuilder.CreateCylinder('pgAxis', { height: 0.02, diameter: 0.4 }, this.scene)
    const amat = new BABYLON.StandardMaterial('pgAxisMat', this.scene)
    amat.emissiveColor = new BABYLON.Color3(0.9, 0.4, 0.1)
    amat.diffuseColor = new BABYLON.Color3(0, 0, 0)
    axis.material = amat
    axis.position.y = 0.011
  }

  // ---- MODEL --------------------------------------------------------------
  async _loadModel() {
    const token = ++this._loadToken
    this._disposeModel()

    const spec = assets.playerBody
    const url = this.gender === 'female'
      ? spec.url.replace('hero_male', 'hero_female')
      : spec.url
    const slash = url.lastIndexOf('/') + 1
    const rootUrl = url.slice(0, slash)
    const fileName = url.slice(slash)

    let result
    try {
      result = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene)
    } catch (err) {
      console.error('[playground] model load failed', err)
      return
    }
    if (token !== this._loadToken) {
      result.meshes.forEach((m) => m.dispose())
      result.animationGroups.forEach((g) => g.dispose())
      return
    }

    this.holder = new BABYLON.TransformNode('pgHolder', this.scene)
    this.holder.scaling.setAll(spec.scale)
    result.meshes[0].parent = this.holder
    this.holder.position.y = 0 // raw model has feet at y=0; stand it on the grid
    this.holder.rotation.y = spec.yawOffset || 0
    this.meshes = result.meshes
    this.skeleton = result.skeletons && result.skeletons[0]

    // stop everything, index by name, sort alphabetically for the list
    result.animationGroups.forEach((g) => g.stop())
    this.groups = result.animationGroups
      .map((g) => ({ name: g.name, group: g }))
      .sort((a, b) => a.name.localeCompare(b.name))
    this.byName = new Map(this.groups.map((e) => [e.name, e.group]))

    const names = this.groups.map((e) => e.name)
    console.log('[playground] loaded ' + names.length + ' clips:', names)

    this._cachedHandNode = null
    this._weaponRoot = null
    this._weaponIndexApplied = -1
    this._cachedHeadNode = null
    this._helmetRoot = null
    this._rebuildClipList()
    if (this.weaponIndex >= 0) this._mountWeapon(this.weaponIndex)
    this._mountHelmet()

    // auto-play the currently-mapped idle so something moves on load
    const startClip = this.mapping.idle && this.byName.has(this.mapping.idle)
      ? this.mapping.idle
      : names[0]
    if (startClip) this.play(startClip)
  }

  _disposeModel() {
    this.current = null
    this.currentName = null
    if (this.groups) this.groups.forEach((e) => { e.group.onAnimationGroupEndObservable.clear(); e.group.dispose() })
    this.groups = []
    this.byName = new Map()
    if (this._weaponRoot) { this._weaponRoot.dispose(); this._weaponRoot = null }
    if (this._helmetRoot) { this._helmetRoot.dispose(); this._helmetRoot = null }
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    this.meshes = []
    if (this.holder) { this.holder.dispose(); this.holder = null }
    this.skeleton = null
  }

  // ---- PLAYBACK -----------------------------------------------------------
  play(name) {
    const group = this.byName.get(name)
    if (!group) return
    if (this.current && this.current !== group) {
      this.current.onAnimationGroupEndObservable.clear() // stop() fires end obs
      this.current.stop()
    }
    this.current = group
    this.currentName = name
    group.stop()
    group.start(this.loop, this.speed, group.from, group.to)
    this._highlightActive()
  }

  togglePlay() {
    if (!this.current) return
    if (this.current.isPlaying) this.current.pause()
    else this.current.play(this.loop)
  }

  step(dir) {
    if (!this.groups.length) return
    let idx = this.groups.findIndex((e) => e.name === this.currentName)
    idx = (idx + dir + this.groups.length) % this.groups.length
    this.play(this.groups[idx].name)
  }

  setLoop(on) {
    this.loop = on
    if (this.current) {
      // restart to apply loop flag cleanly
      const name = this.currentName
      this.play(name)
    }
  }

  setSpeed(v) {
    this.speed = v
    if (this.current) this.current.speedRatio = v
  }

  // ---- WEAPON MOUNT (mirrors CharacterModel recipe) -----------------------
  _handNode() {
    if (this._cachedHandNode) return this._cachedHandNode
    const name = assets.playerBody.handBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHandNode = node
    return node
  }

  async _mountWeapon(index) {
    if (this._weaponRoot) { this._weaponRoot.dispose(); this._weaponRoot = null }
    this._weaponIndexApplied = index
    if (index < 0) return
    const spec = tpWeapons[index]
    if (!spec) return
    const hand = this._handNode()
    if (!hand) { console.warn('[playground] no hand bone; weapon not mounted'); return }

    const slash = spec.url.lastIndexOf('/') + 1
    const rootUrl = spec.url.slice(0, slash)
    const fileName = spec.url.slice(slash)
    const token = this._loadToken
    const res = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene)
    if (token !== this._loadToken || this._weaponIndexApplied !== index) {
      res.meshes.forEach((m) => m.dispose())
      return
    }
    const root = res.meshes[0]
    root.parent = hand
    root.getChildMeshes().forEach((m) => { m.isPickable = false })
    root.scaling.setAll(spec.scale)
    root.position.set(spec.position.x, spec.position.y, spec.position.z)
    root.rotationQuaternion = null
    root.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    this._weaponRoot = root
  }

  selectWeapon(index) {
    this.weaponIndex = index
    this._mountWeapon(index)
    this._refreshWeaponButtons()
  }

  // ---- HELMET MOUNT (mirrors CharacterModel recipe) -----------------------
  _headNode() {
    if (this._cachedHeadNode) return this._cachedHeadNode
    const name = assets.playerBody.headBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHeadNode = node
    return node
  }

  async _mountHelmet() {
    const spec = assets.playerBody.helmet
    if (!spec) return
    const head = this._headNode()
    if (!head) { console.warn('[playground] no head bone; helmet not mounted'); return }

    const slash = spec.url.lastIndexOf('/') + 1
    const rootUrl = spec.url.slice(0, slash)
    const fileName = spec.url.slice(slash)
    const token = this._loadToken
    const res = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene)
    if (token !== this._loadToken) {
      res.meshes.forEach((m) => m.dispose())
      return
    }
    const root = res.meshes[0]
    root.parent = head
    root.getChildMeshes().forEach((m) => { m.isPickable = false })
    root.scaling.setAll(spec.scale)
    root.position.set(spec.position.x, spec.position.y, spec.position.z)
    root.rotationQuaternion = null
    root.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    this._helmetRoot = root
    // seed last-applied values so setHelmetTransform partial updates work
    this._helmetXform = {
      scale: spec.scale,
      px: spec.position.x, py: spec.position.y, pz: spec.position.z,
      rx: spec.rotation.x, ry: spec.rotation.y, rz: spec.rotation.z,
    }
  }

  // Live helmet fit tuning (for the probe). t = { scale, px, py, pz, rx, ry, rz };
  // any subset — omitted axes keep their last-applied value.
  setHelmetTransform(t) {
    if (!this._helmetRoot || !t) return
    const x = this._helmetXform || (this._helmetXform = {})
    if (t.scale != null) { x.scale = t.scale; this._helmetRoot.scaling.setAll(t.scale) }
    if (t.px != null) x.px = t.px
    if (t.py != null) x.py = t.py
    if (t.pz != null) x.pz = t.pz
    this._helmetRoot.position.set(x.px || 0, x.py || 0, x.pz || 0)
    if (t.rx != null) x.rx = t.rx
    if (t.ry != null) x.ry = t.ry
    if (t.rz != null) x.rz = t.rz
    this._helmetRoot.rotationQuaternion = null
    this._helmetRoot.rotation.set(x.rx || 0, x.ry || 0, x.rz || 0)
  }

  // ---- UI ------------------------------------------------------------------
  _hideGameHud() {
    ;['arena-hud', 'entry-overlay', 'settings-menu', 'dev-inspector', 'damage-flash', 'combat-state']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none' })
    document.body.classList.remove('connection-connecting')
  }

  _buildUi() {
    const style = document.createElement('style')
    style.textContent = `
      #pg-panel { position: fixed; top: 0; left: 0; height: 100vh; width: 260px;
        background: rgba(12,16,20,0.92); color: #d7e0e8; font: 12px/1.4 monospace;
        display: flex; flex-direction: column; z-index: 9999; border-right: 1px solid #2a343d; }
      #pg-panel h3 { margin: 8px 10px 4px; font-size: 11px; letter-spacing: 1px; color: #7fd0ff; }
      #pg-clips { flex: 1; overflow-y: auto; padding: 0 4px; }
      .pg-clip { padding: 4px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .pg-clip:hover { background: #1c2630; }
      .pg-clip.active { background: #17527a; color: #fff; }
      #pg-controls { padding: 8px 10px; border-top: 1px solid #2a343d; }
      #pg-controls .row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
      #pg-controls button, #pg-roles button, #pg-weapons button {
        background: #1c2630; color: #d7e0e8; border: 1px solid #35424e; border-radius: 3px;
        padding: 3px 7px; cursor: pointer; font: 11px monospace; }
      #pg-controls button:hover, #pg-roles button:hover, #pg-weapons button:hover { background: #24313c; }
      #pg-controls button.on { background: #17527a; border-color: #2f7fb0; color: #fff; }
      #pg-readout { padding: 6px 10px; font-size: 11px; color: #9fb0bd; border-top: 1px solid #2a343d;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #pg-roles { padding: 6px 10px; border-top: 1px solid #2a343d; }
      #pg-roles .role { display: flex; align-items: center; justify-content: space-between; margin: 3px 0; gap: 6px; }
      #pg-roles .role span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b7c4cf; }
      #pg-roles .role .rk { color: #7fd0ff; flex: 0 0 42px; }
      #pg-weapons { padding: 6px 10px; border-top: 1px solid #2a343d; display: flex; flex-wrap: wrap; gap: 4px; }
      #pg-weapons button.on { background: #17527a; border-color: #2f7fb0; color: #fff; }
      #pg-copy { margin: 6px 10px; padding: 6px; width: calc(100% - 20px); background: #1f6f3f;
        border: 1px solid #2c9d59; color: #fff; border-radius: 4px; cursor: pointer; font: 11px monospace; }
      #pg-copy:hover { background: #2c9d59; }
      #pg-toast { position: fixed; bottom: 14px; left: 280px; background: #1f6f3f; color: #fff;
        padding: 6px 12px; border-radius: 4px; font: 12px monospace; z-index: 10000; opacity: 0;
        transition: opacity 0.2s; pointer-events: none; }
      #pg-toast.show { opacity: 1; }
      #pg-hint { position: fixed; bottom: 8px; right: 12px; color: #6a7883; font: 11px monospace; z-index: 9999; }
    `
    document.head.appendChild(style)

    const panel = document.createElement('div')
    panel.id = 'pg-panel'
    panel.innerHTML = `
      <h3>MODEL</h3>
      <div id="pg-controls">
        <div class="row">
          <button id="pg-male" class="on">Male</button>
          <button id="pg-female">Female</button>
        </div>
      </div>
      <h3>WEAPON IN HAND</h3>
      <div id="pg-weapons"></div>
      <h3>CLIPS</h3>
      <div id="pg-clips"></div>
      <div id="pg-readout">—</div>
      <div id="pg-controls">
        <div class="row">
          <button id="pg-prev">‹</button>
          <button id="pg-playpause">Pause</button>
          <button id="pg-next">›</button>
          <button id="pg-loop" class="on">Loop</button>
        </div>
        <div class="row">
          <label>Speed <span id="pg-speedval">1.00</span>x</label>
          <input id="pg-speed" type="range" min="0.1" max="2" step="0.05" value="1" style="flex:1">
        </div>
      </div>
      <h3>ROLES</h3>
      <div id="pg-roles"></div>
      <button id="pg-copy">Copy anims mapping</button>
    `
    document.body.appendChild(panel)

    const toast = document.createElement('div')
    toast.id = 'pg-toast'
    document.body.appendChild(toast)
    this._toast = toast

    const hint = document.createElement('div')
    hint.id = 'pg-hint'
    hint.textContent = 'drag = orbit · wheel = zoom · ←/→ = clip · space = play/pause'
    document.body.appendChild(hint)

    // wire controls
    const $ = (id) => document.getElementById(id)
    $('pg-male').onclick = () => this._setGender('male')
    $('pg-female').onclick = () => this._setGender('female')
    $('pg-prev').onclick = () => this.step(-1)
    $('pg-next').onclick = () => this.step(1)
    $('pg-playpause').onclick = () => { this.togglePlay(); this._refreshPlayBtn() }
    $('pg-loop').onclick = () => {
      this.setLoop(!this.loop)
      $('pg-loop').classList.toggle('on', this.loop)
    }
    $('pg-speed').oninput = (e) => {
      const v = parseFloat(e.target.value)
      $('pg-speedval').textContent = v.toFixed(2)
      this.setSpeed(v)
    }
    $('pg-copy').onclick = () => this._copyMapping()

    this._buildWeaponButtons()
    this._buildRolePanel()
  }

  _setGender(g) {
    if (g === this.gender) return
    this.gender = g
    document.getElementById('pg-male').classList.toggle('on', g === 'male')
    document.getElementById('pg-female').classList.toggle('on', g === 'female')
    this._loadModel()
  }

  _buildWeaponButtons() {
    const host = document.getElementById('pg-weapons')
    host.innerHTML = ''
    const none = document.createElement('button')
    none.textContent = 'None'
    none.dataset.idx = '-1'
    none.className = this.weaponIndex < 0 ? 'on' : ''
    none.onclick = () => this.selectWeapon(-1)
    host.appendChild(none)
    WEAPON_NAMES.forEach((name, i) => {
      const b = document.createElement('button')
      b.textContent = name
      b.dataset.idx = String(i)
      b.className = this.weaponIndex === i ? 'on' : ''
      b.onclick = () => this.selectWeapon(i)
      host.appendChild(b)
    })
  }

  _refreshWeaponButtons() {
    document.querySelectorAll('#pg-weapons button').forEach((b) => {
      b.classList.toggle('on', parseInt(b.dataset.idx, 10) === this.weaponIndex)
    })
  }

  _rebuildClipList() {
    const host = document.getElementById('pg-clips')
    if (!host) return
    host.innerHTML = ''
    this.groups.forEach((e) => {
      const row = document.createElement('div')
      row.className = 'pg-clip'
      row.textContent = e.name
      row.dataset.name = e.name
      row.title = e.name
      row.onclick = () => this.play(e.name)
      host.appendChild(row)
    })
    this._highlightActive()
  }

  _highlightActive() {
    document.querySelectorAll('#pg-clips .pg-clip').forEach((r) => {
      r.classList.toggle('active', r.dataset.name === this.currentName)
    })
    const active = document.querySelector('#pg-clips .pg-clip.active')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }

  _buildRolePanel() {
    const host = document.getElementById('pg-roles')
    host.innerHTML = ''
    ROLES.forEach((role) => {
      const row = document.createElement('div')
      row.className = 'role'
      const key = document.createElement('span')
      key.className = 'rk'
      key.textContent = role
      const val = document.createElement('span')
      val.id = 'pg-role-' + role
      val.textContent = this.mapping[role] || '—'
      val.title = this.mapping[role] || ''
      const btn = document.createElement('button')
      btn.textContent = 'set'
      btn.onclick = () => this._assignRole(role)
      row.appendChild(key)
      row.appendChild(val)
      row.appendChild(btn)
      host.appendChild(row)
    })
  }

  _assignRole(role) {
    if (!this.currentName) return
    this.mapping[role] = this.currentName
    const val = document.getElementById('pg-role-' + role)
    if (val) { val.textContent = this.currentName; val.title = this.currentName }
    this._showToast(role + ' = ' + this.currentName)
  }

  _copyMapping() {
    const m = this.mapping
    const text =
      'anims: {\n' +
      "  idle: '" + (m.idle || '') + "',\n" +
      "  run: '" + (m.run || '') + "',\n" +
      "  jump: '" + (m.jump || '') + "',\n" +
      "  shoot: '" + (m.shoot || '') + "',\n" +
      "  hit: '" + (m.hit || '') + "',\n" +
      "  death: '" + (m.death || '') + "',\n" +
      '},'
    console.log('[playground] anims mapping:\n' + text)
    try {
      navigator.clipboard.writeText(text).then(
        () => this._showToast('copied to clipboard'),
        () => this._showToast('logged to console (clipboard blocked)'),
      )
    } catch (e) {
      this._showToast('logged to console')
    }
  }

  _showToast(msg) {
    if (!this._toast) return
    this._toast.textContent = msg
    this._toast.classList.add('show')
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => this._toast.classList.remove('show'), 1600)
  }

  _refreshPlayBtn() {
    const b = document.getElementById('pg-playpause')
    if (b && this.current) b.textContent = this.current.isPlaying ? 'Pause' : 'Play'
  }

  _updateReadout() {
    const el = document.getElementById('pg-readout')
    if (!el) return
    if (!this.current) { el.textContent = '—'; return }
    const g = this.current
    let frame = g.from
    const a = g.animatables && g.animatables[0]
    if (a && a.masterFrame != null) frame = a.masterFrame
    else if (a && a.getAnimations && a.getAnimations()[0]) frame = a.getAnimations()[0].currentFrame
    // clips carry their own frame rate (glTF import); use it so duration is real
    const ta = g.targetedAnimations && g.targetedAnimations[0]
    const fps = (ta && ta.animation && ta.animation.framePerSecond) || FPS
    const dur = ((g.to - g.from) / fps).toFixed(2)
    el.textContent = this.currentName + ' — f' + frame.toFixed(1) +
      ' / [' + g.from.toFixed(1) + '..' + g.to.toFixed(1) + '] — ' + dur + 's'
  }

  _onKey(e) {
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (e.key === 'ArrowLeft') { this.step(-1); e.preventDefault() }
    else if (e.key === 'ArrowRight') { this.step(1); e.preventDefault() }
    else if (e.key === ' ') { this.togglePlay(); this._refreshPlayBtn(); e.preventDefault() }
  }
}
