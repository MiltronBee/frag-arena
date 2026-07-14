// Procedural weapon audio (WebAudio). 100% synthesized in-code — NO sample assets,
// NO external/paid generation. Provenance: white-noise buffers + oscillators +
// biquad filters + envelopes, all generated here. Nothing third-party is shipped.
//
// Design: a punchy per-weapon transient (a filtered noise "crack") layered with a
// low body "thump" (a fast downward pitch sweep) and a short mechanical click. The
// whole bus runs through a DynamicsCompressor/limiter so sustained automatic fire
// never clips. Every voice is built from transient nodes that are stop()-scheduled
// and never retained, so they garbage-collect the instant they finish — no growing
// pool of audio nodes. The white-noise buffer is generated ONCE and reused by every
// shot (no per-shot buffer allocation).
//
// WebAudio requires a user gesture to start, so resume() must be called from a click
// / pointer-lock / touch handler (the Simulator wires this).

import { distanceGain } from './firingFx'

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
      this.comp.threshold.value = -14
      this.comp.knee.value = 24
      this.comp.ratio.value = 12
      this.comp.attack.value = 0.002
      this.comp.release.value = 0.18
      this.master = this.ctx.createGain()
      this.master.gain.value = this._volume
      this.comp.connect(this.master)
      this.master.connect(this.ctx.destination)
      this._noise = this._makeNoiseBuffer(0.5)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
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
    const p = voiceParams(report, opts.distance || 0)
    if (p.gain <= 0.001) return
    if (p.kind === 'plasma') this._plasmaVoice(p, now)
    else this._gunVoice(p, now)
  }

  _voiceOut(gain) {
    const out = this.ctx.createGain()
    out.gain.value = gain
    out.connect(this.comp)
    return out
  }

  // pump/rack mechanical double-clack (shotgun), scheduled `delay` seconds out so
  // it lands with the viewmodel's rack motion, not the muzzle report
  pump(delay = 0.35) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const out = this._voiceOut(0.5)
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
    })
  }

  _gunVoice(p, t0) {
    const ctx = this.ctx
    const out = this._voiceOut(p.gain)

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
    }
  }

  _plasmaVoice(p, t0) {
    const ctx = this.ctx
    const out = this._voiceOut(p.gain)

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
  }

  // short surface-aware impact tick (world hit). opts.distance attenuates.
  impact(surfaceKey, opts = {}) {
    if (!this.ctx) return
    const ctx = this.ctx, t0 = ctx.currentTime
    const g = 0.5 * distanceGain(opts.distance || 0)
    if (g <= 0.002) return
    const out = this._voiceOut(g)
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
    if (m.noise > 0 && this._noise) {
      const noise = ctx.createBufferSource(); noise.buffer = this._noise
      const bp = ctx.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = m.f * 0.5
      const nGain = ctx.createGain()
      nGain.gain.setValueAtTime(m.noise * 0.6, t0)
      nGain.gain.exponentialRampToValueAtTime(0.001, t0 + m.dur * 0.7)
      noise.connect(bp); bp.connect(nGain); nGain.connect(out)
      noise.start(t0); noise.stop(t0 + m.dur)
    }
  }

  // crisp positive tick when the local player's shot hits an enemy; a brighter rising
  // two-tone for a kill.
  hitMarker(kill = false) {
    if (!this.ctx) return
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
    osc.start(t0); osc.stop(t0 + (kill ? 0.14 : 0.08))
  }
}
