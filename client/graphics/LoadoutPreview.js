// LOADOUT PREVIEW — the character you are about to deploy as, in 3D, wearing exactly
// the armour your wallet holds.
//
// Season 1 gates every non-pistol weapon behind ownership (common/weaponsConfig.js
// `ownedOnly`). Without this screen that rule is INVISIBLE: a returning player finds
// their rifle gone, no weapons on the arena floor, and nothing anywhere explaining why
// or what linking a wallet would change. This screen is the explanation.
//
// It runs its OWN Babylon engine on its own canvas, entirely separate from the match
// renderer — the menu has no 3D scene of its own and the match scene does not exist
// until you deploy. That engine is created on open and disposed on close, so a player
// who never opens the panel pays nothing for it.
//
// The body, the bones, the armour transforms and the metal shading are NOT re-derived
// here: it builds a real CharacterModel from the real assetManifest spec, so the figure
// you inspect is the same rig, same mounts and same materials the arena renders. The one
// thing it changes is WHICH armour rows the spec carries — see specFor().
import * as BABYLON from '../babylon.js'
import CharacterModel from './CharacterModel'
import { assets } from '../assets/assetManifest'

// NFT on-chain name -> the assetManifest armour rows it puts on the body.
// Mirrors common/entitlements.js, which is the server's authority on what a token
// grants; this is only the visual half. One token can cover several mounts (the Joint
// Cap is one item across four joints, and pauldrons/boots are mirrored pairs).
export const ARMOR_BY_NFT = {
  'Cloth Cuirass': ['chest'],
  'Cloth Pauldron': ['pauldronL', 'pauldronR'],
  'Cloth Joint Cap': ['elbowL', 'elbowR', 'kneeL', 'kneeR'],
  'Cloth Sabaton': ['bootL', 'bootR'],
}
// The Helm is not an `armor` row — it mounts through the spec's separate `helmet` block.
export const HELMET_NFT = 'Degen Helm'

// Build a playerBody spec carrying only the armour the holder actually owns.
//
// Deliberately a FILTERED COPY rather than mounting everything and hiding pieces: the
// whole point is to show what ownership buys, and an empty shoulder has to read as
// genuinely empty. Mutating assets.playerBody would leak into the match renderer, so
// this never touches the original.
export function specFor(ownedNames) {
  const held = new Set(ownedNames || [])
  const wanted = new Set()
  for (const [nft, rows] of Object.entries(ARMOR_BY_NFT)) {
    if (held.has(nft)) rows.forEach((r) => wanted.add(r))
  }
  const spec = { ...assets.playerBody }
  spec.armor = (assets.playerBody.armor || []).filter((row) => wanted.has(row.name))
  spec.armorEnabled = spec.armor.length > 0
  if (!held.has(HELMET_NFT)) delete spec.helmet
  return spec
}

export default class LoadoutPreview {
  constructor(canvas) {
    this.canvas = canvas
    this.engine = null
    this.scene = null
    this.model = null
    this.host = null
    this._raf = null
    this._spin = 0
  }

  // (Re)build the figure for a given holdings list. Safe to call repeatedly — relinking a
  // wallet re-renders the body without leaking the previous one.
  // Hide the figure and let the lists carry the panel. Called when a second WebGL
  // context is unavailable or switched off — never fatal, the panel still explains the
  // gate without it.
  _fallback(why) {
    this._failed = why
    const fig = this.canvas && this.canvas.closest('.loadout-figure')
    if (fig) fig.style.display = 'none'
    const hint = document.getElementById('loadout-hint')
    if (hint) hint.style.display = 'none'
  }

  async show(ownedNames) {
    this._ensureEngine()
    if (!this.engine) return
    this._disposeModel()

    // CharacterModel rides a "host" it reads position/yaw/liveness off — in the match
    // that is the player's invisible collision box. Here it is a plain object: the
    // preview has no simulation, it just needs something with the same shape.
    this.host = {
      position: new BABYLON.Vector3(0, 0, 0),
      rotation: new BABYLON.Vector3(0, 0, 0),
      isAlive: true,
    }

    this.model = new CharacterModel(this.scene, this.host, specFor(ownedNames))
    // CharacterModel always creates an overhead nametag in #nametags. That belongs to
    // the arena HUD, not to a menu panel, so drop it immediately — otherwise a stray tag
    // floats over the menu for as long as the panel is open.
    if (this.model._nameTag) {
      try { this.model._nameTag.remove() } catch (e) {}
      this.model._nameTag = null
    }
    // FFA black uniform: the preview is "you", not a red or blue team member.
    this.model.setNeutral()
  }

  // SECOND WEBGL CONTEXT — deliberate, and deliberately optional.
  //
  // BABYLONRenderer already holds a context from page load (Simulator builds it in its
  // constructor, before anyone deploys), so this panel makes two. That is fine on a real
  // GPU and NOT fine everywhere: a low-end phone or a software rasteriser can refuse the
  // second context or die trying — this crashed a headless swiftshader browser outright.
  //
  // So the 3D is treated as enhancement, never as the message. If the context cannot be
  // had, the figure is hidden and the panel falls back to its lists, which is where the
  // load-bearing information (what you carry, what is LOCKED) actually lives. `?loadout3d=0`
  // forces that path for testing, matching the existing ?armor=0 / ?sky escape hatches.
  _ensureEngine() {
    if (this.engine || this._failed) return
    let wanted = true
    try { wanted = new URLSearchParams(location.search).get('loadout3d') !== '0' } catch (e) {}
    if (!wanted) { this._fallback('disabled'); return }
    try {
      this.engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false }, false)
    } catch (e) {
      this._fallback('no webgl context'); return
    }
    this.scene = new BABYLON.Scene(this.engine)
    // Transparent clear so the panel's own background shows through and the figure sits
    // in the menu art rather than in a grey box.
    this.scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)

    // Frames the body head-to-foot. beta just under horizontal looks slightly down the
    // figure, which reads as a character select rather than a floor-level shot.
    this.camera = new BABYLON.ArcRotateCamera('loadoutCam', -Math.PI / 2, Math.PI / 2.35, 3.4,
      new BABYLON.Vector3(0, 0.95, 0), this.scene)
    this.camera.lowerRadiusLimit = 2.2
    this.camera.upperRadiusLimit = 5.5
    this.camera.wheelDeltaPercentage = 0.01
    this.camera.attachControl(this.canvas, true)

    // Key + rim. The armour has its own environment map baked in by _makeArmorMetal, so
    // these are here for the UNIFORM and the skin, which are plain PBR and would
    // otherwise render as a silhouette against the transparent clear.
    const key = new BABYLON.DirectionalLight('key', new BABYLON.Vector3(-0.4, -0.8, 0.5), this.scene)
    key.intensity = 2.1
    const rim = new BABYLON.HemisphericLight('rim', new BABYLON.Vector3(0, 1, 0), this.scene)
    rim.intensity = 0.55

    let last = performance.now()
    this._raf = () => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // Slow turntable so the pauldrons and the back of the cuirass both get seen.
      this._spin += dt * 0.35
      if (this.host) this.host.rotation.y = this._spin
      if (this.model) this.model.update(dt)
      this.scene.render()
    }
    this.engine.runRenderLoop(this._raf)

    this._onResize = () => this.engine && this.engine.resize()
    window.addEventListener('resize', this._onResize)
  }

  _disposeModel() {
    if (this.model) { try { this.model.dispose() } catch (e) {} this.model = null }
    this.host = null
  }

  // Tear the whole engine down. Called when the panel closes: a menu is not a match, and
  // leaving a WebGL context and a render loop alive behind a hidden panel costs a real
  // frame budget on the machines this game targets.
  dispose() {
    this._disposeModel()
    if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null }
    if (this.engine) {
      try { this.engine.stopRenderLoop() } catch (e) {}
      try { this.scene && this.scene.dispose() } catch (e) {}
      try { this.engine.dispose() } catch (e) {}
    }
    this.engine = null
    this.scene = null
    this._raf = null
  }
}
