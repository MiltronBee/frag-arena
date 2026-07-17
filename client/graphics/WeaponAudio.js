// Hybrid weapon audio (WebAudio): a procedural synth core LAYERED with ElevenLabs-
// generated sample components (public/assets/sfx/*.mp3, authored OFFLINE by
// scripts/generate-sfx.mjs — the game never calls the API at runtime). Each gunshot
// and reload is assembled from PHYSICAL PARTS — powder report, mechanical action,
// ejected brass, reload motions — mixed live so every weapon has its own voice from
// shared parts. If a sample buffer hasn't loaded yet (or its fetch failed), the call
// FALLS BACK to the procedural synth, so the game is never silent.
//
// Procedural core: a punchy per-weapon transient (a filtered noise "crack") layered
// with a low body "thump" (a fast downward pitch sweep) and a short mechanical click.
// The whole bus runs through a DynamicsCompressor/limiter so sustained automatic fire
// never clips. Every voice is built from transient nodes that are stop()-scheduled
// and never retained, so they garbage-collect the instant they finish — no growing
// pool of audio nodes. Sample playback follows the same fire-and-forget discipline.
//
// WebAudio requires a user gesture to start, so resume() must be called from a click
// / pointer-lock / touch handler (the Simulator wires this). resume() also kicks off
// a one-time async load+decode of the sample library.

import { distanceGain } from './firingFx'

// The generated sample library (public/assets/sfx/<name>.mp3). Physical components,
// not whole-gun clips — layered per weapon in fire()/reload(). See generate-sfx.mjs.
// DIRECT whole-event clips (one full fire + one full reload per weapon). See
// scripts/generate-sfx.mjs.
const SFX_NAMES = [
  'rifle_fire', 'smg_fire', 'shotgun_fire', 'pistol_fire',
  'rifle_reload', 'smg_reload', 'shotgun_reload', 'pistol_reload',
  'impact_flesh', 'pain_grunt', 'kill_confirm',
]
// weapon index -> clip prefix (0=rifle,1=smg,2=shotgun,3=pistol). Any other index
// (e.g. plasma) has no prefix -> procedural path.
const WEAPON_PREFIX = ['rifle', 'smg', 'shotgun', 'pistol']

// Per-weapon synthesized SUB-THUMP (FX consult): a sine sweep layered under the
// AI clip supplies the physical low-end punch that mp3 generation can't. f0->f1
// swept over ~80ms; `gain` scales the base sub level; `dur` is the amp decay.
const SUB_THUMP = {
  rifle:   { f0: 100, f1: 38, gain: 1.0, dur: 0.09 },
  smg:     { f0: 85,  f1: 45, gain: 0.7, dur: 0.09 }, // lighter (high rate of fire)
  shotgun: { f0: 120, f1: 30, gain: 1.4, dur: 0.12 }, // deeper, longer chest thump
  pistol:  { f0: 110, f1: 42, gain: 1.0, dur: 0.09 },
}

// Pure, testable: map a weapon's report preset + distance to bounded synth params.
// Kept free of any AudioContext so it can be unit-tested under plain node.
export function voiceParams(report, distance = 0) {
  const r = report || {}
  const level = r.level == null ? 0.8 : r.level
  const gain = Math.max(0, Math.min(1, level * distanceGain(distance)))
  return {
    kind: r.kind || 'ballistic',
    gain,
    bodyFreq: Math.max(20, r.bodyFreq || 200),
    bodyDrop: Math.max(20, r.bodyDrop || 60),
    noiseHz: Math.max(100, r.noiseHz || 2000),
    noiseQ: Math.max(0.1, r.noiseQ || 1),
    decay: Math.max(0.02, Math.min(1.5, r.decay || 0.12)),
    mech: Math.max(0, Math.min(1, r.mech == null ? 0.4 : r.mech)),
  }
}

export default class WeaponAudio {
  constructor() {
    this.ctx = null
    this.comp = null
    this.master = null
    this._noise = null
    this._volume = this._readVolume()
    this._lastShotAt = -1
    this._buf = {}              // name -> decoded AudioBuffer (absent = not loaded)
    this._samplesLoading = false
    this._samplesLoaded = false
  }

  _readVolume() {
    if (typeof localStorage === 'undefined') return 0.9
    const v = parseFloat(localStorage.getItem('sfxVol'))
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.9
  }

  // Idempotent; safe to call on every gesture. Creates the context + master bus on
  // first call, and resumes it if the browser auto-suspended it.
  resume() {
    if (typeof window === 'undefined') return
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    if (!this.ctx) {
      try {
        this.ctx = new AC()
      } catch (e) { return }
      // master bus: limiter/compressor -> gain -> speakers
      this.comp = this.ctx.createDynamicsCompressor()
      // "slam" settings (FX consult): fast 3ms attack lets each transient crack
      // through, then a hard 5:1 squash + 80ms release makes automatic fire pump
      // without clipping.
      this.comp.threshold.value = -16
      this.comp.knee.value = 8
      this.comp.ratio.value = 5
      this.comp.attack.value = 0.003
      this.comp.release.value = 0.08
      this.master = this.ctx.createGain()
      this.master.gain.value = this._volume
      this.comp.connect(this.master)
      this.master.connect(this.ctx.destination)
      this._noise = this._makeNoiseBuffer(0.5)
      // Self-heal: whenever the browser/OS moves the context off 'running' (mobile
      // screen dim, notification, app switch, or iOS's non-standard 'interrupted'
      // after a call/Siri), try to resume it immediately. Cheap + idempotent.
      this.ctx.onstatechange = () => {
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
      }
    }
    // state !== 'running' (not just 'suspended') so we also recover from iOS's
    // non-standard 'interrupted' state, where resume was otherwise skipped.
    if (this.ctx.state !== 'running') this.ctx.resume()
    this.loadSamples() // one-time; guarded internally
  }

  // One-time async load + decode of the ElevenLabs sample library. Individual
  // failures are tolerated — that clip simply stays absent and its callers fall
  // back to the procedural synth. Cache-busted with __BUILD_ID__ like the bundle.
  loadSamples() {
    if (this._samplesLoading || this._samplesLoaded || !this.ctx) return
    this._samplesLoading = true
    const v = (typeof window !== 'undefined' && window.__BUILD_ID__) ? '?v=' + window.__BUILD_ID__ : ''
    Promise.allSettled(SFX_NAMES.map((name) =>
      fetch('/assets/sfx/' + name + '.mp3' + v)
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { this._buf[name] = buf })
    )).then(() => { this._samplesLoaded = true; this._samplesLoading = false })
  }

  // Play a loaded sample clip through the master (limiter) bus. Fire-and-forget:
  // the node GCs when it ends. Returns false (no-op) if the buffer isn't loaded.
  playClip(name, opts = {}) {
    const buf = this._buf[name]
    if (!buf || !this.ctx) return false
    const { gain = 1, delay = 0, rate = 1 } = opts
    // opts.pos => route through a PannerNode (positional/remote); else 2D to this.comp.
    const panner = this._makePanner(opts.pos)
    const dest = panner || this.comp
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = this.ctx.createGain()
    g.gain.value = Math.max(0, Math.min(1.5, gain))
    src.connect(g); g.connect(dest)
    this._teardownWhenDone([src], panner ? [src, g, panner] : [src, g])
    src.start(this.ctx.currentTime + Math.max(0, delay))
    return true
  }

  // Build a PannerNode for a POSITIONAL (remote) voice, wired panner -> this.comp,
  // and placed at the shot's world position. Returns the panner (the voice connects
  // its own output INTO it) or null when no world position was supplied (local /
  // first-person cues stay 2D — they connect straight to this.comp as before).
  //
  // Double-attenuation is avoided by making the panner the SOLE distance model:
  // panner-routed voices are built at FULL gain (their caller passes distance 0 / g 1),
  // and 'inverse' distanceModel + rolloffFactor below reproduce the loudness feel of
  // firingFx.distanceGain (1/(1+(d/14)^2), floored ~0.05). We deliberately do NOT
  // also multiply by distanceGain for these voices.
  //
  // panningModel 'equalpower' is the cheap constant-power pan; swapping in 'HRTF' is a
  // drop-in upgrade (binaural, heavier) — no other change required.
  _makePanner(pos) {
    if (!pos || !this.ctx) return null
    const ctx = this.ctx
    let panner
    try { panner = ctx.createPanner() } catch (e) { return null }
    panner.panningModel = 'equalpower' // 'HRTF' is a drop-in upgrade (binaural, costlier)
    panner.distanceModel = 'inverse'
    panner.refDistance = 14   // matches firingFx.distanceGain ref (~half-volume distance)
    panner.maxDistance = 400  // sane cap; attenuation clamps beyond this
    panner.rolloffFactor = 1  // 'inverse' owns ALL distance attenuation here
    // modern AudioParam API, with the deprecated setter as a Safari fallback
    if (panner.positionX) {
      panner.positionX.value = pos.x
      panner.positionY.value = pos.y
      panner.positionZ.value = pos.z
    } else if (panner.setPosition) {
      panner.setPosition(pos.x, pos.y, pos.z)
    }
    panner.connect(this.comp)
    return panner
  }

  // Per-frame listener pose so panned voices resolve to the right side/direction.
  // No-op before the AudioContext exists (audio not yet resumed / no user gesture).
  // Cheap; the Simulator calls it once per render frame.
  updateListener(pos, forward, up) {
    if (!this.ctx || !pos) return
    const l = this.ctx.listener
    if (!l) return
    if (l.positionX) { // modern AudioParam API
      l.positionX.value = pos.x
      l.positionY.value = pos.y
      l.positionZ.value = pos.z
      if (forward && l.forwardX) {
        l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z
      }
      if (up && l.upX) {
        l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z
      }
    } else { // Safari fallback
      if (l.setPosition) l.setPosition(pos.x, pos.y, pos.z)
      if (forward && up && l.setOrientation) {
        l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
      }
    }
  }

  get ready() { return !!this.ctx }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v))
    if (typeof localStorage !== 'undefined') localStorage.setItem('sfxVol', String(this._volume))
    if (this.master) this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.01)
  }

  _makeNoiseBuffer(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds)
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    let s = 0x2545f491 >>> 0 // deterministic LCG so the noise is reproducible
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      data[i] = (s / 0x80000000) - 1
    }
    return buf
  }

  // fire a weapon report. `report` is a firingFx weapon report preset; opts.distance
  // (world units) attenuates remote/positional shots.
  shoot(report, opts = {}) {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    if (now - this._lastShotAt < 0.008) return // hard floor: never stack voices on one frame
    this._lastShotAt = now
    // Positional (remote) shot: the panner is the sole distance model, so build the
    // voice at FULL gain (distance 0) and let the panner attenuate. Local/2D shots
    // keep their manual distanceGain via voiceParams(opts.distance).
    const panner = this._makePanner(opts.pos)
    const p = voiceParams(report, panner ? 0 : (opts.distance || 0))
    if (p.gain <= 0.001) return
    const dest = panner || this.comp
    if (p.kind === 'plasma') this._plasmaVoice(p, now, dest, panner)
    else this._gunVoice(p, now, dest, panner)
  }

  // Composite weapon fire (preferred entry point). Layers the caliber's sample
  // components — report + mechanical action + ejected brass — for a per-weapon
  // voice from shared parts, with pitch jitter so repeated shots don't sound
  // machine-cloned. Falls back to the procedural shoot() if the report sample
  // isn't loaded yet. `report` is the firingFx preset (used only by the fallback).
  fire(weaponIndex, report, opts = {}) {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    if (now - this._lastShotAt < 0.008) return // shared anti-stack floor
    const prefix = WEAPON_PREFIX[weaponIndex]
    // Positional (remote) shot: route through a panner (sole distance model) at FULL
    // gain. Local/2D shot: keep the manual distanceGain. Never both (no double atten).
    const panner = this._makePanner(opts.pos)
    const g = panner ? 1 : distanceGain(opts.distance || 0)
    if (g <= 0.001) { this._lastShotAt = now; return }
    // sample path — the AI clip is the mid "body"; synth adds the punch it lacks.
    if (prefix && this._buf[prefix + '_fire']) {
      this._lastShotAt = now
      const rate = 1 + (Math.random() - 0.5) * 0.12 // ±6% pitch jitter so repeats don't clone
      this._fireLayers(prefix, g, rate, now, panner || this.comp, panner)
      return
    }
    // fallback: procedural voice (shoot() re-checks + advances the floor itself, and
    // makes its OWN panner from opts.pos). Drop this one so it doesn't dangle on comp.
    if (panner) { try { panner.disconnect() } catch (e) {} }
    this.shoot(report, opts)
  }

  // Assemble one gunshot from three simultaneous layers through the limiter bus:
  //   A) the AI clip (mid body + mechanical), warmed by a subtle shared saturator
  //   B) a synth transient CRACK (highpassed noise burst) — restores the sharp
  //      attack the mp3 generator smears
  //   C) a per-weapon synth SUB-THUMP (sine sweep) — the low-end "felt" punch
  // All start at t0; the transient nodes stop() shortly after their envelopes so
  // they garbage-collect (no retained/pooled nodes).
  //
  // `dest` is the node the layers feed (this.comp for 2D shots, or a PannerNode for a
  // positional remote shot). `panner` (when present) is torn down with the layer that
  // outlives the others (the AI body buffer) so the panner disconnects with no leak.
  _fireLayers(prefix, g, rate, t0, dest = this.comp, panner = null) {
    const ctx = this.ctx

    // A) AI body through a subtle saturation "glue"
    const body = ctx.createBufferSource()
    body.buffer = this._buf[prefix + '_fire']
    body.playbackRate.value = rate
    const bodyGain = ctx.createGain()
    bodyGain.gain.value = Math.min(1.5, 0.9 * g)
    const sat = this._saturator()
    body.connect(sat); sat.connect(bodyGain); bodyGain.connect(dest)
    // the panner (if any) tears down with the body — the longest-lived layer.
    this._teardownWhenDone([body], panner ? [body, sat, bodyGain, panner] : [body, sat, bodyGain])
    body.start(t0) // auto-stops + GCs at buffer end

    // B) transient crack: highpassed white-noise burst, ~15ms. Random slice of the
    // cached noise buffer so repeats aren't identical.
    const crack = ctx.createBufferSource()
    crack.buffer = this._noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'; hp.frequency.value = 1200
    const cg = ctx.createGain()
    cg.gain.setValueAtTime(0.7 * g, t0)
    cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.015)
    crack.connect(hp); hp.connect(cg); cg.connect(dest)
    this._teardownWhenDone([crack], [crack, hp, cg])
    crack.start(t0, Math.random() * 0.3); crack.stop(t0 + 0.03)

    // C) per-weapon sub-thump: a sine sweep down for the chest punch
    const s = SUB_THUMP[prefix] || SUB_THUMP.rifle
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(s.f0, t0)
    sub.frequency.exponentialRampToValueAtTime(s.f1, t0 + 0.08)
    const sg = ctx.createGain()
    sg.gain.setValueAtTime(Math.min(1.2, 0.55 * g * s.gain), t0)
    sg.gain.exponentialRampToValueAtTime(0.001, t0 + s.dur)
    sub.connect(sg); sg.connect(dest)
    this._teardownWhenDone([sub], [sub, sg])
    sub.start(t0); sub.stop(t0 + s.dur + 0.04)
  }

  // Shared soft-saturation WaveShaper for "glue"/warmth. The curve is built ONCE
  // and cached; a fresh (cheap) node per shot reuses it and GCs after the shot.
  _saturator() {
    if (!this._satCurve) {
      const n = 1024, curve = new Float32Array(n), amount = 12, deg = Math.PI / 180
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1
        curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x))
      }
      this._satCurve = curve
    }
    const ws = this.ctx.createWaveShaper()
    ws.curve = this._satCurve
    ws.oversample = '2x'
    return ws
  }

  // Layered reload: sequence the physical motions timed to reloadTime (seconds).
  // Mag-fed guns drop the empty, seat a fresh mag, then charge; the shotgun feeds
  // shells then racks the pump. Each clip is a no-op if its sample isn't loaded
  // (the procedural synth has no reload voice, so reload is sample-only).
  reload(weaponIndex) {
    if (!this.ctx) return
    const prefix = WEAPON_PREFIX[weaponIndex]
    if (prefix) this.playClip(prefix + '_reload', { gain: 0.8 })
  }

  // Victim pain grunt (an observed remote player took damage). Pitch-varied so
  // crossfire doesn't sound cloned; distance-attenuated. Sample-only.
  pain(opts = {}) {
    // positional (remote) grunt: full base gain, the panner owns distance (no double
    // attenuation); 2D fallback keeps the manual distanceGain.
    const g = opts.pos ? 0.55 : 0.55 * distanceGain(opts.distance || 0)
    if (g <= 0.02) return
    this.playClip('pain_grunt', { gain: g, rate: 0.9 + Math.random() * 0.2, pos: opts.pos })
  }

  // `dest` is the destination node (this.comp for 2D, or a PannerNode for positional).
  _voiceOut(gain, dest = this.comp) {
    const out = this.ctx.createGain()
    out.gain.value = gain
    out.connect(dest)
    return out
  }

  // Free a voice's node graph once its driving source(s) finish. On iOS, WebAudio
  // nodes that are only left to GC accumulate on the live graph and can silence all
  // audio after a few minutes, so we explicitly disconnect the WHOLE chain the
  // moment the terminal source(s) fire onended (BufferSources/Oscillators fire it
  // after their scheduled stop). `sources` drive the teardown; `nodes` (gains,
  // filters, shapers, sources) are all disconnected. Purely teardown — never
  // touches gains/envelopes/routing, so the SOUND is unchanged.
  _teardownWhenDone(sources, nodes) {
    let pending = sources.length
    const tearDown = () => {
      if (--pending > 0) return
      nodes.forEach((n) => { try { n.disconnect() } catch (e) {} })
    }
    sources.forEach((s) => { s.onended = tearDown })
  }

  // pump/rack mechanical double-clack (shotgun), scheduled `delay` seconds out so
  // it lands with the viewmodel's rack motion, not the muzzle report
  pump(delay = 0.35) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const out = this._voiceOut(0.5)
    const sources = [], nodes = [out]
    ;[[t0, 1400, 420], [t0 + 0.09, 1100, 320]].forEach(([t, f0, f1]) => {
      const click = ctx.createOscillator()
      click.type = 'square'
      click.frequency.setValueAtTime(f0, t)
      click.frequency.exponentialRampToValueAtTime(f1, t + 0.025)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.3, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
      click.connect(g); g.connect(out)
      click.start(t); click.stop(t + 0.06)
      sources.push(click); nodes.push(click, g)
    })
    this._teardownWhenDone(sources, nodes)
  }

  _gunVoice(p, t0, dest = this.comp, panner = null) {
    const ctx = this.ctx
    const out = this._voiceOut(p.gain, dest)
    const sources = [], nodes = panner ? [out, panner] : [out]

    // 1) crack — white noise through a bandpass with a fast exponential decay
    const noise = ctx.createBufferSource()
    noise.buffer = this._noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = p.noiseHz
    bp.Q.value = p.noiseQ
    const nGain = ctx.createGain()
    nGain.gain.setValueAtTime(1.0, t0)
    nGain.gain.exponentialRampToValueAtTime(0.001, t0 + p.decay)
    noise.connect(bp); bp.connect(nGain); nGain.connect(out)
    noise.start(t0); noise.stop(t0 + p.decay + 0.02)
    sources.push(noise); nodes.push(noise, bp, nGain)

    // 2) body — a low osc with a fast downward pitch sweep (the thump)
    const body = ctx.createOscillator()
    body.type = 'triangle'
    body.frequency.setValueAtTime(p.bodyFreq, t0)
    body.frequency.exponentialRampToValueAtTime(p.bodyDrop, t0 + p.decay * 0.9)
    const bGain = ctx.createGain()
    bGain.gain.setValueAtTime(0.9, t0)
    bGain.gain.exponentialRampToValueAtTime(0.001, t0 + p.decay)
    body.connect(bGain); bGain.connect(out)
    body.start(t0); body.stop(t0 + p.decay + 0.02)
    sources.push(body); nodes.push(body, bGain)

    // 3) mechanical transient — a very short falling click (bolt/action)
    if (p.mech > 0.01) {
      const click = ctx.createOscillator()
      click.type = 'square'
      click.frequency.setValueAtTime(1800, t0)
      click.frequency.exponentialRampToValueAtTime(500, t0 + 0.02)
      const cGain = ctx.createGain()
      cGain.gain.setValueAtTime(0.25 * p.mech, t0)
      cGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.03)
      click.connect(cGain); cGain.connect(out)
      click.start(t0); click.stop(t0 + 0.04)
      sources.push(click); nodes.push(click, cGain)
    }
    this._teardownWhenDone(sources, nodes)
  }

  _plasmaVoice(p, t0, dest = this.comp, panner = null) {
    const ctx = this.ctx
    const out = this._voiceOut(p.gain, dest)

    // descending FM-ish zap: a saw carrier whose frequency is modulated + swept down
    const carrier = ctx.createOscillator()
    carrier.type = 'sawtooth'
    carrier.frequency.setValueAtTime(p.bodyFreq * 1.6, t0)
    carrier.frequency.exponentialRampToValueAtTime(p.bodyDrop, t0 + p.decay)
    const mod = ctx.createOscillator()
    mod.type = 'sine'
    mod.frequency.value = 55
    const modGain = ctx.createGain()
    modGain.gain.value = p.bodyFreq * 0.8
    mod.connect(modGain); modGain.connect(carrier.frequency)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'; bp.frequency.value = p.noiseHz; bp.Q.value = p.noiseQ
    const eGain = ctx.createGain()
    eGain.gain.setValueAtTime(0.9, t0)
    eGain.gain.exponentialRampToValueAtTime(0.001, t0 + p.decay)
    carrier.connect(bp); bp.connect(eGain); eGain.connect(out)
    carrier.start(t0); carrier.stop(t0 + p.decay + 0.03)
    mod.start(t0); mod.stop(t0 + p.decay + 0.03)

    // a touch of high sizzle
    const noise = ctx.createBufferSource()
    noise.buffer = this._noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'; hp.frequency.value = 1800
    const nGain = ctx.createGain()
    nGain.gain.setValueAtTime(0.16, t0)
    nGain.gain.exponentialRampToValueAtTime(0.001, t0 + p.decay * 0.7)
    noise.connect(hp); hp.connect(nGain); nGain.connect(out)
    noise.start(t0); noise.stop(t0 + p.decay)
    const nodes = [out, carrier, bp, eGain, mod, modGain, noise, hp, nGain]
    if (panner) nodes.push(panner)
    this._teardownWhenDone([carrier, mod, noise], nodes)
  }

  // short surface-aware impact tick (world hit). opts.distance attenuates.
  impact(surfaceKey, opts = {}) {
    if (!this.ctx) return
    // opts.pos => positional (remote) impact: the panner owns distance, so use the
    // base gain and skip the manual distanceGain (no double attenuation). 2D otherwise.
    const positional = !!opts.pos
    // flesh: prefer the generated wet-impact sample (far meatier than the synth
    // tick — the top "did it land?" cue). Other surfaces stay procedural.
    if (surfaceKey === 'flesh' && this._buf.impact_flesh) {
      const fg = positional ? 0.9 : 0.9 * distanceGain(opts.distance || 0)
      if (fg > 0.02) this.playClip('impact_flesh', { gain: fg, rate: 0.92 + Math.random() * 0.16, pos: opts.pos })
      return
    }
    const ctx = this.ctx, t0 = ctx.currentTime
    const g = positional ? 0.5 : 0.5 * distanceGain(opts.distance || 0)
    if (g <= 0.002) return
    const panner = this._makePanner(opts.pos)
    const out = this._voiceOut(g, panner || this.comp)
    const map = {
      flesh: { f: 300, q: 4, dur: 0.09, type: 'sine', noise: 0.1 },
      metal: { f: 3200, q: 8, dur: 0.06, type: 'triangle', noise: 0.5 },
      stone: { f: 900, q: 3, dur: 0.08, type: 'triangle', noise: 0.4 },
      concrete: { f: 700, q: 3, dur: 0.09, type: 'triangle', noise: 0.4 },
      energy: { f: 1500, q: 6, dur: 0.12, type: 'sawtooth', noise: 0.3 },
    }
    const m = map[surfaceKey] || map.concrete
    const osc = ctx.createOscillator()
    osc.type = m.type
    osc.frequency.setValueAtTime(m.f, t0)
    osc.frequency.exponentialRampToValueAtTime(m.f * 0.4, t0 + m.dur)
    const oGain = ctx.createGain()
    oGain.gain.setValueAtTime(0.6, t0)
    oGain.gain.exponentialRampToValueAtTime(0.001, t0 + m.dur)
    osc.connect(oGain); oGain.connect(out)
    osc.start(t0); osc.stop(t0 + m.dur + 0.02)
    const sources = [osc], nodes = panner ? [out, panner, osc, oGain] : [out, osc, oGain]
    if (m.noise > 0 && this._noise) {
      const noise = ctx.createBufferSource(); noise.buffer = this._noise
      const bp = ctx.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = m.f * 0.5
      const nGain = ctx.createGain()
      nGain.gain.setValueAtTime(m.noise * 0.6, t0)
      nGain.gain.exponentialRampToValueAtTime(0.001, t0 + m.dur * 0.7)
      noise.connect(bp); bp.connect(nGain); nGain.connect(out)
      noise.start(t0); noise.stop(t0 + m.dur)
      sources.push(noise); nodes.push(noise, bp, nGain)
    }
    this._teardownWhenDone(sources, nodes)
  }

  // crisp positive tick when the local player's shot hits an enemy; a brighter rising
  // two-tone for a kill.
  hitMarker(kill = false) {
    if (!this.ctx) return
    // kill: prefer the generated confirm blip. The non-kill tick stays procedural
    // (it's a snappy synthetic UI beep by design).
    if (kill && this._buf.kill_confirm) { this.playClip('kill_confirm', { gain: 0.6 }); return }
    const ctx = this.ctx, t0 = ctx.currentTime
    const out = this._voiceOut(0.5)
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(kill ? 880 : 1400, t0)
    if (kill) osc.frequency.exponentialRampToValueAtTime(1760, t0 + 0.05)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.4, t0)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + (kill ? 0.12 : 0.06))
    osc.connect(g); g.connect(out)
    this._teardownWhenDone([osc], [out, osc, g])
    osc.start(t0); osc.stop(t0 + (kill ? 0.14 : 0.08))
  }
}
