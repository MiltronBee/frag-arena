import * as BABYLON from '../babylon.js'
import { weapons } from '../../common/weaponsConfig'

// ============================================================================
// FRAG LAYER — the client-side kill-feedback / "juice" layer for Frag Arena.
//
// Modeled on solSoccer's FunLayer: an isolated module bolted ON TOP of the
// netcode sim. Simulator's message handlers forward server combat events here;
// FragLayer owns ALL the DOM/UI + world FX that make a kill *feel* like a kill.
// Nothing here is authoritative — it's pure presentation, decoupled from the
// replicated state (which is exactly why a corpse can persist a few seconds
// after isAlive flips, and why a fast respawn must cancel it).
//
// It NEVER predicts kills. Kill feedback is driven only by server messages
// (HitConfirmed / Killed / DamageTaken). The predicted flesh-hit marker stays
// in Simulator; FragLayer only UPGRADES it when a HitConfirmed lands.
//
// Everything is built from primitives + procedural DOM: no art assets, no
// third-party FX. Chunks are babylon boxes; gibs/corpses are simulated in
// update(delta) off the same render loop as the rest of the game.
// ============================================================================

const KILL_FEED_MAX = 4        // visible kill-feed entries
const KILL_FEED_LIFE = 4600    // ms an entry lives before it fades
const FRAG_BANNER_LIFE = 2700  // ms the centered frag banner holds
const CORPSE_LIFE = 3800       // ms a tipped-over corpse persists
const CORPSE_FADE = 900        // ms of sink+fade at the end of a corpse's life
const GIB_OVERKILL = 40        // overkill damage that upgrades a death to gibs
const GIB_LIFE = 2000          // ms gib chunks live
const DAMAGE_ARC_LIFE = 500    // ms the directional damage arc holds

// ── GIT GUD DEATH SCREEN ────────────────────────────────────────────────────
// Ported from BonkGames (same studio, same assets): a black takeover that either
// slaps the taunt plate up with a VHS/RGB-split treatment or just screams the word.
// Markup + CSS live inline in public/index.html (#gitgud); this owns the lifecycle.
//
// PLACEMENT IN THE DEATH WINDOW is the whole design. In BonkGames this was a
// once-per-run game-over card; here you die every ~30s and the instant of death is
// already spoken for by _startDeathCam's drop + roll. So it does NOT fire on the
// death frame — it is scheduled into the QUIET GAP at the END of the death window:
// cam falls, world holds, then the taunt lands as punctuation and tears down as the
// player comes back. Every knob below is one line to retune.
const GITGUD_ENABLED = true          // master switch (false = never fires)
const GITGUD_LIFE = 600              // ms the takeover holds. BonkGames was 333, which is
                                     // a once-per-run game-over card; here it is punctuation
                                     // you see every death, and 333 was too short to read the
                                     // plate. Everything else scales off this one number.
const GITGUD_IMAGE_CHANCE = 0.3      // P(taunt plate); otherwise the giant "GIT GUD"
const GITGUD_EVERY_N_DEATHS = 1      // fire on every Nth own death (1 = every death)
// Total death->respawn window, in ms. Only a SEED: the real number is the server's
// GameInstance.RESPAWN_DELAY_MS, which the client cannot import (server-side module),
// so _gitGudLearnWindow() measures the actual death->respawn interval and keeps the
// SMALLEST one it has seen this session. Smallest is the safe direction: an
// underestimate just lands the taunt slightly early in the gap, an overestimate
// would let the respawn cut it off.
const GITGUD_RESPAWN_WINDOW = 2500
const GITGUD_PRE_RESPAWN_GAP = 140   // ms of clear air between the taunt ending and respawn
const GITGUD_MIN_DELAY = 400         // ms floor after death — never start on top of the
                                     // death-cam (its drop+roll completes in 200ms)
const GITGUD_TAUNT_TICK = 30         // ms per glitch tick, taunt-plate variant
const GITGUD_WORD_TICK = 50          // ms per glitch tick, word variant
// Tick COUNTS are derived, not authored: the glitch has to cover the whole hold or the
// takeover freezes clean for its back half. (BonkGames hardcoded 11 and 6, which is
// exactly ceil(333/30) and ceil(333/50) — same rule, written out.)
const GITGUD_TAUNT_TICKS = Math.ceil(GITGUD_LIFE / GITGUD_TAUNT_TICK)
const GITGUD_WORD_TICKS = Math.ceil(GITGUD_LIFE / GITGUD_WORD_TICK)

export default class FragLayer {
  constructor(simulator) {
    this.sim = simulator
    this.scene = simulator.renderer.scene

    // per-victim corpse state, keyed by smooth nid. Decoupled from isAlive so a
    // slow corpse animation can outlive the death flag; a respawn cancels it.
    this._corpses = new Map()   // nid -> { t0, killerYaw, gibbed }
    this._gibs = []             // active gib chunks (simulated each frame)

    // own-death camera state (drop + roll). Applied in applyDeathCamera(), reset
    // by Respawned. Rotation-only tilt applied AFTER Simulator reads the aim ray,
    // so it never changes the shot ray / MoveCommand the server judges with.
    this._deathCam = { active: false, t0: 0, roll: 0, pitch: 0, appliedPitch: 0 }

    // directional damage arc canvas state
    this._damageArc = null // { t0, yaw }

    // GIT GUD death screen. `window` is the learned death->respawn interval (see
    // GITGUD_RESPAWN_WINDOW); `timer`/`raf` are the two things a respawn must kill.
    this._gitGud = {
      active: false, timer: null, raf: null, t0: 0,
      deathAt: 0, deaths: 0, window: GITGUD_RESPAWN_WINDOW, tick: -1,
    }

    this._buildDom()
  }

  // -------------------------------------------------------------------------
  // DOM scaffolding: kill feed (top-right), frag banner (center), directional
  // damage arc canvas (full-screen edge overlay). All appended into #arena-hud
  // so they inherit the pointer-none HUD layer.
  // -------------------------------------------------------------------------
  _buildDom() {
    const hud = document.getElementById('arena-hud') || document.body

    this.feedEl = document.getElementById('kill-feed')
    if (!this.feedEl) {
      this.feedEl = document.createElement('div')
      this.feedEl.id = 'kill-feed'
      this.feedEl.setAttribute('aria-hidden', 'true')
      hud.appendChild(this.feedEl)
    }

    this.bannerEl = document.getElementById('frag-banner')
    if (!this.bannerEl) {
      this.bannerEl = document.createElement('div')
      this.bannerEl.id = 'frag-banner'
      this.bannerEl.setAttribute('role', 'status')
      hud.appendChild(this.bannerEl)
    }

    // medal / streak callout: the visual voice for the announcer's double-kill /
    // spree clips (HUD2030 §C). Sits above the frag banner; Simulator drives it
    // via showMedal().
    this.medalEl = document.getElementById('medal-callout')
    if (!this.medalEl) {
      this.medalEl = document.createElement('div')
      this.medalEl.id = 'medal-callout'
      this.medalEl.setAttribute('aria-hidden', 'true')
      hud.appendChild(this.medalEl)
    }

    // pickup toast ("+ FLAK CANNON"): the acquire cue when the local player grabs a
    // NEW weapon. Low-center, accent-green (gold is reserved for kills — color law).
    // Simulator drives it via showPickupToast() off the ownedWeapons diff.
    this.pickupToastEl = document.getElementById('pickup-toast')
    if (!this.pickupToastEl) {
      this.pickupToastEl = document.createElement('div')
      this.pickupToastEl.id = 'pickup-toast'
      this.pickupToastEl.setAttribute('aria-hidden', 'true')
      hud.appendChild(this.pickupToastEl)
    }

    this.arcEl = document.getElementById('damage-arc')
    if (!this.arcEl) {
      this.arcEl = document.createElement('canvas')
      this.arcEl.id = 'damage-arc'
      this.arcEl.setAttribute('aria-hidden', 'true')
      hud.appendChild(this.arcEl)
    }

    // hit-confirm flash: a brief, subtle red vignette when YOUR shot lands. Kept
    // fast (≤0.2 alpha, ~80ms) so it reads as "hit!" without clutter (FX consult).
    // Inline-styled so no CSS-file dependency; a CSS opacity transition drives it.
    this.confirmEl = document.getElementById('hit-confirm')
    if (!this.confirmEl) {
      this.confirmEl = document.createElement('div')
      this.confirmEl.id = 'hit-confirm'
      this.confirmEl.setAttribute('aria-hidden', 'true')
      Object.assign(this.confirmEl.style, {
        position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
        pointerEvents: 'none', opacity: '0', zIndex: '5',
        // GOLD confirm vignette (color law: gold/white = own feedback; red stays
        // incoming-damage only). Fallback if playtest rejects gold: threat hex 255,59,70.
        background: 'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 62%, rgba(255,194,75,0.55) 100%)',
        transition: 'opacity 80ms ease-out',
      })
      hud.appendChild(this.confirmEl)
    }

    // GIT GUD overlay: authored inline in public/index.html (it needs a real <img>
    // and a stylesheet, not procedural DOM), so here we only bind. Every reference is
    // optional — a missing node simply disables the effect rather than throwing on
    // the death path.
    this.ggEl = document.getElementById('gitgud')
    if (this.ggEl) {
      this.ggPlateEl = this.ggEl.querySelector('.gg-taunt')
      this.ggWordEl = this.ggEl.querySelector('.gg-word')
      this.ggNoiseEl = this.ggEl.querySelector('.gg-noise')
      this.ggGhostEls = this.ggEl.querySelectorAll('.gg-ghost')
    }
  }

  // brief red vignette pulse on a confirmed local hit. Snap to peak alpha, then let
  // the CSS transition fade it to 0. `kill` doubles the weight (α 0.2→0.3, 80→140ms)
  // per the kill-package spec — impact from the vignette, not from any timescale change.
  // Skipped on the low FX tier.
  _confirmFlash(kill) {
    const r = this.sim && this.sim.renderer
    if (r && r._fxTier === 'low') return
    const el = this.confirmEl
    if (!el) return
    const peak = kill ? '0.30' : '0.16'
    const fade = kill ? 140 : 80
    // Force a reflow to COMMIT the peak opacity as its own paint before the
    // fade starts. The old single-rAF pattern let the browser coalesce the
    // peak and the fade into one style pass, silently dropping the flash frame
    // under load / low FPS — i.e. "the gun sometimes has no hit feedback".
    el.style.transition = 'none'
    el.style.opacity = peak
    void el.offsetHeight // reflow: peak is now committed
    el.style.transition = 'opacity ' + fade + 'ms ease-out'
    el.style.opacity = '0'
  }

  // convenience: a display label for a smooth nid — the player's callsign,
  // resolved via the Simulator name registry (falls back to "Player <nid>").
  // Self reads "You" in banners, handled at callsites.
  _label(nid) { return this.sim.getName(nid) }

  _weaponName(index) {
    const w = weapons[index]
    return (w && w.name) || 'Frag'
  }

  _mySmoothNid() {
    const e = this.sim.mySmoothEntity
    return e ? e.nid : -1
  }

  // =========================================================================
  // 1) HITMARKER CONFIRM-UPGRADE  (HitConfirmed, attacker-only)
  // The predicted white marker already flashed instantly in Simulator; here we
  // upgrade it to the server-confirmed red marker (or the kill treatment).
  // =========================================================================
  onHitConfirmed(message) {
    const kill = !!message.wasKill
    // AUTHORITATIVE headshot flag (server-classified pose model). The predicted flesh
    // hitmarker already flashed instantly in Simulator; the HEADSHOT marker + announce
    // come ONLY from here — never predicted.
    const headshot = !!message.isHeadshot
    // reuse Simulator's marker helper: kill => the rotating red-X kill treatment,
    // headshot => the distinct heavy/headshot marker, otherwise the red confirm pop.
    if (typeof this.sim._showHitMarker === 'function') {
      this.sim._showHitMarker(kill, false, headshot)
    }
    // brief screen-space red vignette so a landed hit registers viscerally; a kill
    // gets the doubled-weight pulse (spec §5.2).
    this._confirmFlash(kill)
    // kill sound: WeaponAudio.hitMarker(true) is a brighter rising two-tone.
    if (kill && this.sim.audio && typeof this.sim.audio.hitMarker === 'function') {
      this.sim.audio.hitMarker(true)
    }
    // Headshot announcer: reuse the audio system. announceHeadshot() plays the
    // 'headshot' voice clip IF that asset exists (it does NOT ship yet — see
    // WeaponAudio.announceHeadshot); until then it is a wired no-op.
    if (headshot && this.sim.audio && typeof this.sim.audio.announceHeadshot === 'function') {
      this.sim.audio.announceHeadshot()
    }
  }

  // =========================================================================
  // 2/3) KILL FEED + FRAG BANNER + corpse/gib triggers  (Killed, broadcast)
  // =========================================================================
  onKilled(message) {
    const { killerNid, victimNid, weaponIndex, overkill } = message
    const headshot = !!message.isHeadshot
    const myNid = this._mySmoothNid()
    const suicide = killerNid === victimNid
    const iKilled = !suicide && killerNid === myNid
    const iDied = victimNid === myNid

    this._pushKillFeed({ killerNid, victimNid, weaponIndex, suicide, iKilled, iDied, headshot })

    if (iKilled) this._showFragBanner(victimNid)

    // corpse / gib visual for the victim's CharacterModel (remote players only —
    // the local player is invisible in first person; own-death is a camera move)
    if (!iDied) {
      // Doom kill-emphasis: a ~140ms freeze on the VICTIM's body only (not a global
      // slow-mo) the instant the kill lands, just before the corpse takes over the rig.
      // Skipped for a gib death (the body vanishes into chunks immediately).
      const victimModel = this.sim.characterModels.get(victimNid)
      if (victimModel && overkill < GIB_OVERKILL) victimModel.hitStop(140, true)
      this._dropCorpse(victimNid, killerNid, overkill)
    }

    // own death: camera drop/roll + strong wash, held until Respawned
    if (iDied) {
      this._startDeathCam(killerNid)
      // ...and, ~2s later (after the cam has landed), the GIT GUD taunt.
      this._gitGudSchedule()
    }
  }

  _pushKillFeed({ killerNid, victimNid, weaponIndex, suicide, iKilled, iDied, headshot }) {
    const row = document.createElement('div')
    row.className = 'kill-feed-row'
    if (iKilled || iDied) row.classList.add('kill-feed-mine') // back-compat hook
    // HUD2030 §5c: split the state edge — own kills accent, own deaths threat.
    if (iKilled) row.classList.add('kf-own-kill')
    if (iDied) row.classList.add('kf-own-death')
    // headshot kill-feed flavour (authoritative). A suicide/fall is never a headshot.
    if (headshot && !suicide) row.classList.add('kill-feed-headshot')

    if (suicide) {
      row.innerHTML =
        `<span class="kf-victim">${this._label(victimNid)}</span>` +
        `<span class="kf-weapon">[${this._weaponName(weaponIndex)}]</span>`
      row.classList.add('kill-feed-suicide')
    } else {
      // headshot -> insert a HEADSHOT badge between weapon and victim (kf-headshot CSS
      // hook; degrades to plain text if unstyled).
      const hs = headshot ? `<span class="kf-headshot">HEADSHOT</span>` : ''
      row.innerHTML =
        `<span class="kf-killer">${iKilled ? 'You' : this._label(killerNid)}</span>` +
        `<span class="kf-weapon">[${this._weaponName(weaponIndex)}]</span>` + hs +
        `<span class="kf-victim">${iDied ? 'You' : this._label(victimNid)}</span>`
    }

    this.feedEl.insertBefore(row, this.feedEl.firstChild)

    // trim to max visible
    while (this.feedEl.children.length > KILL_FEED_MAX) {
      this.feedEl.removeChild(this.feedEl.lastChild)
    }

    // enter animation, then a timed fade-out + removal
    requestAnimationFrame(() => row.classList.add('kf-in'))
    setTimeout(() => {
      row.classList.add('kf-out')
      setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row) }, 400)
    }, KILL_FEED_LIFE)
  }

  // OBJECTIVE FEED (CTF/DOM): a killfeed-styled line for a flag/point event. Reuses the
  // kill-feed element + trim/fade. `text` is built client-side from a server enum (never
  // untrusted input), so setting innerHTML is safe here.
  pushObjectiveFeed(text) {
    if (!this.feedEl) return
    const row = document.createElement('div')
    row.className = 'kill-feed-row kf-objective'
    row.innerHTML = `<span class="kf-objective-text">${text}</span>`
    this.feedEl.insertBefore(row, this.feedEl.firstChild)
    while (this.feedEl.children.length > KILL_FEED_MAX) this.feedEl.removeChild(this.feedEl.lastChild)
    requestAnimationFrame(() => row.classList.add('kf-in'))
    setTimeout(() => {
      row.classList.add('kf-out')
      setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row) }, 400)
    }, KILL_FEED_LIFE)
  }

  _showFragBanner(victimNid) {
    const el = this.bannerEl
    // gold verb + ink callsign (HUD2030 §B2). textContent-built spans so a hostile
    // callsign can never inject markup into the banner.
    el.textContent = ''
    const verb = document.createElement('span')
    verb.className = 'fb-verb'
    verb.textContent = 'FRAGGED '
    const name = document.createElement('span')
    name.className = 'fb-name'
    name.textContent = this._label(victimNid).toUpperCase()
    el.appendChild(verb)
    el.appendChild(name)
    el.classList.remove('frag-banner-show')
    void el.offsetWidth // restart the animation
    el.classList.add('frag-banner-show')
    clearTimeout(this._bannerTimer)
    this._bannerTimer = setTimeout(() => {
      el.classList.remove('frag-banner-show')
    }, FRAG_BANNER_LIFE)
  }

  // medal / streak callout ("DOUBLE KILL", "KILLING SPREE", "FIRST BLOOD").
  // Driven by Simulator's announcer path so audio + visual land as one moment.
  showMedal(text) {
    const el = this.medalEl
    if (!el) return
    el.textContent = text
    el.classList.remove('medal-show')
    void el.offsetWidth // restart the animation
    el.classList.add('medal-show')
    clearTimeout(this._medalTimer)
    this._medalTimer = setTimeout(() => el.classList.remove('medal-show'), 1800)
  }

  // PICKUP TOAST ("+ FLAK CANNON") — the acquire cue for grabbing a NEW weapon. Same
  // transient-element discipline as showMedal(): one reused node, restart the pop,
  // auto-dismiss (~2s). `name` is a weaponsConfig display name (trusted), but built with
  // textContent spans anyway per the banner convention. Accent (not gold) per color law.
  showPickupToast(name) {
    const el = this.pickupToastEl
    if (!el) return
    el.textContent = ''
    const plus = document.createElement('span')
    plus.className = 'pt-plus'
    plus.textContent = '+ '
    const nm = document.createElement('span')
    nm.className = 'pt-name'
    nm.textContent = String(name || '').toUpperCase()
    el.appendChild(plus)
    el.appendChild(nm)
    el.classList.remove('pickup-toast-show')
    void el.offsetWidth // restart the animation (rapid grabs must not drop the toast)
    el.classList.add('pickup-toast-show')
    clearTimeout(this._pickupToastTimer)
    this._pickupToastTimer = setTimeout(() => el.classList.remove('pickup-toast-show'), 2000)
  }

  // =========================================================================
  // 4/5) CORPSE POSE + GIB-LITE  (drives the victim's CharacterModel)
  // =========================================================================
  _dropCorpse(victimNid, killerNid, overkill) {
    const model = this.sim.characterModels.get(victimNid)
    if (!model) return

    const gibbed = overkill >= GIB_OVERKILL

    // yaw from the victim toward the killer (so we tip the body AWAY from the
    // shooter). Fall back to 0.
    let killerYaw = 0
    const killer = this.sim.client.entities.get(killerNid)
    const victim = this.sim.client.entities.get(victimNid)
    if (killer && victim && killerNid !== victimNid) {
      killerYaw = Math.atan2(killer.x - victim.x, killer.z - victim.z)
    }

    // sawDead: has isAlive===false been observed for this corpse yet? Gates the
    // fast-respawn cancel so a stale-true isAlive right after death can't abort the
    // death animation. See the race guard in update().
    this._corpses.set(victimNid, { t0: performance.now(), killerYaw, gibbed, sawDead: false })

    if (gibbed) {
      // gibs replace the body: hide the model immediately + spawn chunks
      model.setCorpse(true)
      model.setHidden(true)
      this._spawnGibs(victim || killer)
    } else {
      // enter corpse mode: CharacterModel.update stops overriding pose/tint while
      // corpse mode is on. The tip-over itself is animated here in update().
      model.setCorpse(true)
    }
  }

  _spawnGibs(atEntity) {
    const x = atEntity ? atEntity.x : 0
    const y = atEntity ? atEntity.y : 0
    const z = atEntity ? atEntity.z : 0
    const count = 5 + Math.floor(Math.random() * 4) // 5..8
    // Floor for the chunks to land on, resolved ONCE from the geometry under the victim
    // rather than a hardcoded -0.95. Box arenas have a single floor at a known height,
    // but on a MESH MAP (common/mapMesh.js) the deck sits at an arbitrary world height
    // (CTF-Visage ~ -25) that varies across the map, so the old constant was ~24m ABOVE
    // the spawn point — gibs spawned already "below" the floor and the next tick snapped
    // them up into the sky. Delegated to the renderer so the floor rule lives in one
    // place (FragLayer already reaches into simulator.renderer for the scene).
    // null = nothing underneath (gibbed over the void): chunks just fall until they fade.
    const floorY = this.sim.renderer._floorYBelow(new BABYLON.Vector3(x, y, z))
    for (let i = 0; i < count; i++) {
      const size = 0.08 + Math.random() * 0.10
      const mesh = BABYLON.MeshBuilder.CreateBox('gib', { size: 1 }, this.scene)
      mesh.scaling.set(size, size, size)
      mesh.isPickable = false
      const mat = new BABYLON.StandardMaterial('gibMat', this.scene)
      const r = 0.45 + Math.random() * 0.35
      mat.diffuseColor = new BABYLON.Color3(r, 0.03, 0.03)
      mat.emissiveColor = new BABYLON.Color3(r * 0.4, 0.0, 0.0)
      mesh.material = mat
      mesh.position.set(
        x + (Math.random() - 0.5) * 0.3,
        y + 0.6 + Math.random() * 0.4,
        z + (Math.random() - 0.5) * 0.3
      )
      const vel = new BABYLON.Vector3(
        (Math.random() - 0.5) * 4.5,
        2.5 + Math.random() * 3.5,
        (Math.random() - 0.5) * 4.5
      )
      const spin = new BABYLON.Vector3(
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20
      )
      this._gibs.push({ mesh, mat, vel, spin, t0: performance.now(), life: GIB_LIFE, floorY })
    }
  }

  // =========================================================================
  // 6) VICTIM FEEDBACK — directional damage arc + own-death camera
  // =========================================================================
  onDamageTaken(message) {
    // directional arc pointing toward the attacker, relative to current cam yaw
    this._damageArc = { t0: performance.now(), yaw: message.directionYaw }
    // brief red edge wash scaled by damage (drives a CSS var read by #damage-flash)
    const frac = Math.max(0.35, Math.min(1, message.damage / 40))
    document.body.style.setProperty('--damage-wash', frac.toFixed(2))
  }

  _startDeathCam(killerNid) {
    this._deathCam.active = true
    this._deathCam.t0 = performance.now()
    // roll ~23deg, small forward pitch drop. Direction of roll biased toward the
    // killer (body falls toward the shooter) if we can resolve it, else fixed.
    let sign = -1
    const killer = this.sim.client.entities.get(killerNid)
    const me = this.sim.mySmoothEntity
    if (killer && me && killerNid !== me.nid) {
      const camYaw = this.sim.renderer.camera.rotation.y
      const toKiller = Math.atan2(killer.x - me.x, killer.z - me.z)
      let rel = toKiller - camYaw
      while (rel > Math.PI) rel -= Math.PI * 2
      while (rel < -Math.PI) rel += Math.PI * 2
      sign = rel >= 0 ? 1 : -1
    }
    this._deathCam.roll = sign * 0.40 // ~23 degrees
    this._deathCam.pitch = 0.10
    document.body.classList.add('own-death')
  }

  // Own-teleport flash: a brief cyan-white fullscreen wash so passing through a
  // portal reads as an EVENT (the world just cut to somewhere else). Same
  // lazily-created-overlay + snap-peak-then-CSS-fade pattern as _confirmFlash;
  // cool tint so it can never be mistaken for damage (red) or a hit (gold).
  // Called from Simulator's Teleported handler. Skipped on the low FX tier.
  onTeleported() {
    const r = this.sim && this.sim.renderer
    if (r && r._fxTier === 'low') return
    if (!this._teleFlashEl) {
      const hud = document.getElementById('hud') || document.body
      this._teleFlashEl = document.createElement('div')
      this._teleFlashEl.id = 'teleport-flash'
      this._teleFlashEl.setAttribute('aria-hidden', 'true')
      Object.assign(this._teleFlashEl.style, {
        position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
        pointerEvents: 'none', opacity: '0', zIndex: '5',
        background: 'radial-gradient(circle at 50% 50%, rgba(210,245,255,0.85) 0%, rgba(120,220,255,0.45) 55%, rgba(40,120,200,0.15) 100%)',
        transition: 'opacity 180ms ease-out',
      })
      hud.appendChild(this._teleFlashEl)
    }
    const el = this._teleFlashEl
    el.style.transition = 'none'
    el.style.opacity = '0.55'
    void el.offsetHeight // commit the peak as its own paint (see _confirmFlash)
    el.style.transition = 'opacity 180ms ease-out'
    el.style.opacity = '0'
  }

  // =========================================================================
  // GIT GUD DEATH SCREEN — see the constant block at the top of this file.
  //
  // Lifecycle mirrors _showFragBanner(): one reused node, a class that turns it on,
  // a timer that turns it off. The differences are that this one is SCHEDULED
  // (it fires late in the death window, not on the death frame) and it drives a
  // per-tick glitch off requestAnimationFrame while it holds.
  // =========================================================================

  // Arm the taunt for THIS death. Cancels anything still in flight first, so dying
  // again mid-effect (or a death that races a respawn) can never stack overlays or
  // leak a second rAF loop.
  _gitGudSchedule() {
    if (!GITGUD_ENABLED || !this.ggEl) return
    this._gitGudCancel()
    this._gitGud.deathAt = performance.now()
    this._gitGud.deaths++
    if (GITGUD_EVERY_N_DEATHS > 1 && this._gitGud.deaths % GITGUD_EVERY_N_DEATHS !== 0) return
    // land the hold so its LAST frame is GITGUD_PRE_RESPAWN_GAP short of the respawn,
    // and never before the death-cam has finished falling.
    const delay = Math.max(
      GITGUD_MIN_DELAY,
      this._gitGud.window - GITGUD_LIFE - GITGUD_PRE_RESPAWN_GAP
    )
    this._gitGud.timer = setTimeout(() => {
      this._gitGud.timer = null
      // Still dead? A respawn normally cancels us through onRespawned, but that is an
      // edge and edges get missed (dropped packet, map-rotation rejoin) — so re-check
      // the replicated truth before taking the screen away from a live player.
      const me = this.sim && this.sim.myRawEntity
      if (me && me.isAlive !== false) return
      this._gitGudShow()
    }, delay)
  }

  // Learn the real death->respawn window from what the server actually did (the client
  // can't import GameInstance.RESPAWN_DELAY_MS). Keep the smallest sane interval seen:
  // observed values carry latency on top of the true delay, and erring small only
  // moves the taunt earlier into the gap.
  _gitGudLearnWindow() {
    const t = this._gitGud.deathAt
    if (!t) return
    const dt = performance.now() - t
    this._gitGud.deathAt = 0
    if (dt < 800 || dt > 30000) return // spectate / intermission / tab-throttle: not a sample
    this._gitGud.window = Math.min(this._gitGud.window, dt)
  }

  _gitGudShow() {
    const el = this.ggEl
    if (!el) return
    const gg = this._gitGud
    gg.active = true
    gg.t0 = performance.now()
    gg.tick = -1

    // roll the variant (BonkGames: Math.random() < 0.3 => the meme)
    const taunt = Math.random() < GITGUD_IMAGE_CHANCE
    el.dataset.variant = taunt ? 'taunt' : 'word'
    el.classList.remove('gg-rgb', 'gg-noise-on', 'gg-track-on', 'gg-ink')
    el.style.setProperty('--gg-dx', '0px')
    el.style.setProperty('--gg-dy', '0px')
    el.style.setProperty('--gg-scale', '1')
    el.style.setProperty('--gg-alpha', '1')
    el.classList.add('gg-on')
    if (!taunt) this._gitGudFitWord()

    // the sting, hard-cut to the same GITGUD_LIFE so audio and picture end together
    if (this.sim.audio && typeof this.sim.audio.interference === 'function') {
      this.sim.audio.interference(GITGUD_LIFE)
    }

    // HARD CAP, independent of the rAF loop below. requestAnimationFrame is only
    // serviced while the page produces frames — a backgrounded/occluded tab (or an
    // engine stall) starves it, and a starved loop would leave a full-screen black
    // takeover parked on the player's screen until the next respawn. A timer keeps
    // firing when rAF does not, so this is the guarantee that the effect ENDS.
    gg.timer = setTimeout(() => this._gitGudCancel(), GITGUD_LIFE + 60)

    // reduced motion: the card is the joke, the strobe is not. Hold it, skip the loop.
    const calm = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (calm) return

    const period = taunt ? GITGUD_TAUNT_TICK : GITGUD_WORD_TICK
    const ticks = taunt ? GITGUD_TAUNT_TICKS : GITGUD_WORD_TICKS
    const loop = () => {
      if (!gg.active) return
      const age = performance.now() - gg.t0
      if (age >= GITGUD_LIFE) { this._gitGudCancel(); return }
      // One rAF loop drives everything. The original nested a delayedCall inside every
      // roll to snap the jitter/tint/split back; here each effect just carries an
      // expiry that the next frame retires — no timer per glitch.
      const i = Math.min(ticks - 1, Math.floor(age / period))
      if (i !== gg.tick) { gg.tick = i; this._gitGudTick(taunt, age, period) }
      this._gitGudRetire(age)
      gg.raf = requestAnimationFrame(loop)
    }
    gg.raf = requestAnimationFrame(loop)
  }

  // One glitch tick. Every roll below is the BonkGames threshold, unchanged.
  _gitGudTick(taunt, age, period) {
    const el = this.ggEl
    const gg = this._gitGud
    const R = (a, b) => a + Math.random() * (b - a)

    if (!taunt) {
      if (Math.random() > 0.5) {                       // position jitter, 30ms
        el.style.setProperty('--gg-dx', ((R(-10, 10)) | 0) + 'px')
        el.style.setProperty('--gg-dy', ((R(-8, 8)) | 0) + 'px')
        gg.jitterUntil = age + 30
      }
      if (Math.random() > 0.7) {                       // white/black tint, 40ms.
        el.classList.toggle('gg-ink', Math.random() > 0.5) // black-on-black = blink out
        gg.tintUntil = age + 40
      }
      return
    }

    if (Math.random() > 0.4) {                          // position jitter, 20ms
      el.style.setProperty('--gg-dx', ((R(-15, 15)) | 0) + 'px')
      el.style.setProperty('--gg-dy', ((R(-12, 12)) | 0) + 'px')
      gg.jitterUntil = age + 20
    }
    if (Math.random() > 0.7) el.style.setProperty('--gg-scale', R(0.95, 1.05).toFixed(3))
    if (Math.random() > 0.8) el.style.setProperty('--gg-alpha', R(0.7, 1).toFixed(3))
    if (Math.random() > 0.8) {                          // RGB split, 50ms
      if (this.ggGhostEls) {
        this.ggGhostEls.forEach((g) => g.style.setProperty('--gg-split', ((R(-5, 5)) | 0) + 'px'))
      }
      el.classList.add('gg-rgb')
      gg.splitUntil = age + 50
    }
    // video dropout: one coarse canvas the compositor upscales, instead of the
    // original's 50 fillRects into a full-screen Graphics every tick.
    if (Math.random() > 0.9) { this._gitGudNoise(); gg.noiseUntil = age + period }
    else el.classList.remove('gg-noise-on')
    // scanlines are a static gradient; only the tracking band is rolled (30%/tick)
    if (Math.random() > 0.7) {
      el.style.setProperty('--gg-track-y', (Math.random() * 96).toFixed(1) + '%')
      el.classList.add('gg-track-on')
      gg.trackUntil = age + period
    } else el.classList.remove('gg-track-on')
  }

  // Retire whatever the tick armed, once its (very short) window has passed.
  _gitGudRetire(age) {
    const el = this.ggEl
    const gg = this._gitGud
    if (gg.jitterUntil && age >= gg.jitterUntil) {
      gg.jitterUntil = 0
      el.style.setProperty('--gg-dx', '0px')
      el.style.setProperty('--gg-dy', '0px')
    }
    if (gg.splitUntil && age >= gg.splitUntil) { gg.splitUntil = 0; el.classList.remove('gg-rgb') }
    if (gg.tintUntil && age >= gg.tintUntil) { gg.tintUntil = 0; el.classList.remove('gg-ink') }
    if (gg.noiseUntil && age >= gg.noiseUntil) { gg.noiseUntil = 0; el.classList.remove('gg-noise-on') }
    if (gg.trackUntil && age >= gg.trackUntil) { gg.trackUntil = 0; el.classList.remove('gg-track-on') }
  }

  // Repaint the 160x104 dropout canvas. Cheap by construction: ~1/10 ticks, ~160 px
  // ops, then the GPU stretches it over the plate (image-rendering: pixelated).
  _gitGudNoise() {
    const c = this.ggNoiseEl
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    for (let i = 0; i < 160; i++) {
      const s = 1 + ((Math.random() * 3) | 0)
      ctx.fillRect((Math.random() * c.width) | 0, (Math.random() * c.height) | 0, s, 1)
    }
    this.ggEl.classList.add('gg-noise-on')
  }

  // Auto-fit "GIT GUD" to ~90% of the viewport width (85% + a height cap in portrait,
  // as in the original). Measured by laying the real element out at 100px and scaling
  // — exact for whatever face actually resolved. Both writes happen in ONE task, so
  // the browser only ever paints the final size; cached per viewport.
  _gitGudFitWord() {
    const el = this.ggWordEl
    if (!el) return
    const w = window.innerWidth, h = window.innerHeight
    const fit = this._ggWordFit
    if (!fit || fit.w !== w || fit.h !== h) {
      const portrait = w < h
      this.ggEl.style.setProperty('--gg-word-size', '100px')
      const measured = el.offsetWidth || 420 // sync layout, once per viewport
      let size = Math.floor(100 * (w * (portrait ? 0.85 : 0.9)) / measured)
      if (portrait) size = Math.min(size, Math.floor(h * 0.15))
      this._ggWordFit = { w, h, size }
    }
    this.ggEl.style.setProperty('--gg-word-size', this._ggWordFit.size + 'px')
  }

  // Tear down: idempotent, and the ONLY way the overlay ever goes away. Safe to call
  // when nothing is armed (respawn calls it on every path).
  _gitGudCancel() {
    const gg = this._gitGud
    if (gg.timer) { clearTimeout(gg.timer); gg.timer = null }
    if (gg.raf) { cancelAnimationFrame(gg.raf); gg.raf = null }
    gg.active = false
    gg.jitterUntil = gg.splitUntil = gg.tintUntil = gg.noiseUntil = gg.trackUntil = 0
    const el = this.ggEl
    if (!el) return
    el.classList.remove('gg-on', 'gg-rgb', 'gg-noise-on', 'gg-track-on', 'gg-ink')
  }

  // Respawn resets everything the death state touched. Called from Simulator's
  // existing Respawned handler.
  onRespawned() {
    // GIT GUD: measure the window we just lived through, then kill anything still
    // pending or on screen. A respawn that arrives EARLY (forced respawn, map
    // rotation, match end) cuts the taunt mid-flight; one that arrives LATE finds
    // nothing to cancel, because the effect capped itself at GITGUD_LIFE.
    this._gitGudLearnWindow()
    this._gitGudCancel()

    this._deathCam.active = false
    const cam = this.sim.renderer.camera
    cam.rotation.x -= this._deathCam.appliedPitch || 0
    this._deathCam.appliedPitch = 0
    cam.rotation.z = 0
    document.body.classList.remove('own-death')
    // HARD CAMERA-TRANSFORM RESET on respawn (playtest 2026-07-25: "sometimes you
    // respawn and the camera is still tilted the way it tilts when you die").
    // Clearing the death-cam's own roll/pitch above is not sufficient: ANY other
    // channel that writes camera rotation and is mid-flight at the moment of death
    // (the recoil spring, the sustained-fire climb lean, a queued pump-dip) carries
    // its offset into the new life. Ask the Simulator to zero every one of them so a
    // fresh life always starts from a level camera, whatever was happening when we
    // died. Idempotent — this runs on every respawn path (message, isAlive edge, and
    // the level-triggered backstop).
    if (this.sim && typeof this.sim.resetCameraTransform === 'function') this.sim.resetCameraTransform()
  }

  // apply the death camera tilt AFTER Simulator has rebased the camera from the
  // entity + read the aim ray. A rotation.z roll + a small pitch drop; because
  // Simulator reads getForwardRay()/camRay BEFORE this runs, the fire ray and
  // MoveCommand aim are never rotated by the death cam.
  applyDeathCamera() {
    const cam = this.sim.renderer.camera
    // rotation.x is the player's PERSISTENT aim pitch (mouse look increments it),
    // so the death pitch must be a tracked offset that is removed before being
    // re-applied — adding to rotation.x directly compounds every frame and the
    // corruption survives respawn.
    cam.rotation.x -= this._deathCam.appliedPitch || 0
    this._deathCam.appliedPitch = 0
    if (!this._deathCam.active) {
      cam.rotation.z = 0
      return
    }
    const t = Math.min(1, (performance.now() - this._deathCam.t0) / 200)
    const ease = 1 - (1 - t) * (1 - t) // ease-out quad
    cam.rotation.z = this._deathCam.roll * ease
    const base = cam.rotation.x
    const pitched = Math.min(Math.PI * 0.499, base + this._deathCam.pitch * ease)
    this._deathCam.appliedPitch = pitched - base
    cam.rotation.x = pitched
  }

  // =========================================================================
  // FRAME UPDATE — corpses, gibs, damage arc. Driven from Simulator.update().
  // =========================================================================
  update(delta) {
    const now = performance.now()

    // ---- corpses: tip-over animation + timed cleanup/reset ----
    if (this._corpses.size) {
      this._corpses.forEach((corpse, nid) => {
        const model = this.sim.characterModels.get(nid)
        const entity = this.sim.client.entities.get(nid)

        // model gone (entity fully removed) -> nothing left to reset, drop it.
        if (!model) {
          this._corpses.delete(nid)
          return
        }

        // FAST RESPAWN cancel: the model was reused and the player is alive again
        // while our corpse timer still runs. Reset the model cleanly and drop it.
        //
        // RACE GUARD: this corpse was spawned off the Killed MESSAGE, which can beat
        // the replicated isAlive FIELD to the client by a frame or two — so isAlive
        // may still read stale-true immediately after death. Cancelling on that would
        // instantly kill the just-started death clip (the intermittent "body freezes
        // standing" bug). Only honor a respawn once we've actually SEEN isAlive go
        // false (death confirmed); a genuine respawn is 2.5s out (RESPAWN_DELAY_MS)
        // and always transitions false->true, so this never misses a real reuse.
        if (entity && entity.isAlive === false) corpse.sawDead = true
        if (corpse.sawDead && entity && entity.isAlive === true) {
          model.setCorpse(false)
          this._corpses.delete(nid)
          return
        }

        const age = now - corpse.t0
        if (!corpse.gibbed) {
          // tip over ~90deg around a horizontal axis within ~200ms + darken; then
          // persist; then sink + fade over the final CORPSE_FADE window.
          const tip = Math.min(1, age / 200)
          model.applyCorpsePose(corpse.killerYaw, tip)
        }

        if (age >= CORPSE_LIFE) {
          this._corpses.delete(nid)
          model.setCorpse(false) // restore for reuse
        } else if (age >= CORPSE_LIFE - CORPSE_FADE) {
          const k = (age - (CORPSE_LIFE - CORPSE_FADE)) / CORPSE_FADE
          model.setCorpseFade(k) // sink + fade
        }
      })
    }

    // ---- gib chunks: ballistic + gravity + spin, fade tail, then dispose ----
    if (this._gibs.length) {
      const dt = Math.min(delta || 0.016, 0.05)
      for (let i = this._gibs.length - 1; i >= 0; i--) {
        const g = this._gibs[i]
        const age = now - g.t0
        if (age >= g.life) {
          g.mesh.dispose()
          g.mat.dispose()
          this._gibs[i] = this._gibs[this._gibs.length - 1]
          this._gibs.pop()
          continue
        }
        g.vel.y -= 9.8 * dt
        g.mesh.position.addInPlace(g.vel.scale(dt))
        g.mesh.rotation.addInPlace(g.spin.scale(dt))
        // rest a hair above the floor so a chunk sits ON the deck instead of z-fighting
        // into it (0.05 preserves the old box-arena look: floor -1.00, gib -0.95).
        if (g.floorY != null && g.mesh.position.y < g.floorY + 0.05) {
          g.mesh.position.y = g.floorY + 0.05
          g.vel.y = Math.abs(g.vel.y) * 0.35
          g.vel.x *= 0.6; g.vel.z *= 0.6
        }
        const left = 1 - age / g.life
        if (left < 0.3) g.mesh.visibility = left / 0.3
      }
    }

    // ---- directional damage arc: draw toward the attacker, fade over ~0.5s ----
    this._drawDamageArc(now)
  }

  _drawDamageArc(now) {
    const arc = this._damageArc
    const canvas = this.arcEl
    if (!arc) {
      if (canvas.dataset.painted === '1') {
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
        canvas.dataset.painted = '0'
      }
      return
    }
    const age = now - arc.t0
    if (age >= DAMAGE_ARC_LIFE) {
      this._damageArc = null
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.dataset.painted = '0'
      return
    }

    const w = window.innerWidth, h = window.innerHeight
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)

    // screen-relative angle: world yaw toward attacker minus our camera yaw.
    // Canvas angles are measured from +x axis CCW, "up" = -PI/2. A world yaw of
    // rel (clockwise-from-forward) maps to screenAngle = -PI/2 + rel.
    const camYaw = this.sim.renderer.camera.rotation.y
    const rel = arc.yaw - camYaw
    const alpha = 1 - age / DAMAGE_ARC_LIFE

    const cx = w / 2, cy = h / 2
    const radius = Math.min(w, h) * 0.34
    const screenAngle = -Math.PI / 2 + rel
    const spread = 0.42 // arc half-width in radians

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, screenAngle - spread, screenAngle + spread)
    ctx.lineWidth = 12
    ctx.strokeStyle = `rgba(255, 59, 70, ${(0.8 * alpha).toFixed(3)})` /* --x30-threat */
    ctx.shadowColor = `rgba(255, 59, 70, ${(0.9 * alpha).toFixed(3)})`
    ctx.shadowBlur = 8
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()
    canvas.dataset.painted = '1'
  }
}
