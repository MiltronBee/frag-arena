// Background music (HTMLAudio): a tiny two-track player that gives the game a
// UT99-style front-end theme and a separate in-match track. WeaponAudio owns the
// WebAudio SFX bus; music is deliberately kept OFF that graph and on plain
// HTMLAudioElements — streamed mp3 loops don't need sample-accurate scheduling,
// and two <audio> elements crossfade cheaply by ramping .volume per frame.
//
// Tracks:
//   menu  -> /assets/music/arena-signal.mp3  (loops on the entry / settings menu)
//   match -> /assets/music/frag-grenade.mp3  (loops once you enter the arena)
//
// Autoplay: browsers block audio until a user gesture, exactly like WeaponAudio's
// AudioContext. So play(key) only records the DESIRED track; the sound doesn't
// actually start until unlock() runs from a real gesture (the Simulator calls it
// from the same pointerdown/touchstart handlers that resume() WeaponAudio). After
// unlock the manager stays live and every play()/setVolume()/setMuted() takes
// effect immediately.
//
// Volume + mute persist to localStorage ('musicVolume' 0..1, 'musicMuted' '0'/'1')
// and are surfaced in the Settings menu.

const TRACKS = {
  menu: '/assets/music/arena-signal.mp3',
  match: '/assets/music/frag-grenade.mp3',
}

const DEFAULT_VOLUME = 0.35   // low by default — background bed, not foreground
const FADE_PER_SEC = 1.8      // volume units/sec while crossfading (~0.5s full fade)

function clamp01(v) {
  if (!(v >= 0)) return 0     // also catches NaN
  return v > 1 ? 1 : v
}

export default class MusicManager {
  constructor() {
    // one long-lived <audio> per track; loop + preload so re-entering a state is
    // instant and never re-fetches. volume starts at 0 so the first fade-in is clean.
    this.tracks = {}
    this._preUnlocked = false
    for (const key of Object.keys(TRACKS)) {
      // Adopt an inline <audio id="bg-<key>"> if the page shipped one (the menu track
      // does). On mobile the splash gate may have already STARTED it off the first tap,
      // before this bundle booted — reusing that exact element means no double-play and,
      // crucially, no lost gesture: we inherit its live, already-unlocked playback
      // instead of newing up a fresh element the browser would refuse to play.
      const adopted = typeof document !== 'undefined' && document.getElementById('bg-' + key)
      const el = adopted || new Audio()
      if (!el.getAttribute('src')) el.src = TRACKS[key]
      el.loop = true
      el.preload = 'auto'
      const alreadyPlaying = !!(adopted && !el.paused)
      // A fresh (or idle) element starts silent so its first fade-in is clean. Don't
      // stomp the volume of an element that's already audibly rolling from the gate
      // tap — let _ease glide from wherever it is.
      if (!alreadyPlaying) el.volume = 0
      // fire-and-forget: a failed fetch/decode must never break gameplay, so a
      // missing track just stays silent (mirrors WeaponAudio's sample fallback).
      el.addEventListener('error', () => { this._failed = this._failed || {}; this._failed[key] = true })
      this.tracks[key] = el
      // Adopted a track that's already playing => audio is already unlocked. Record it
      // so play('match') later actually starts instead of waiting for a gesture.
      if (alreadyPlaying) this._preUnlocked = true
    }

    this.baseVolume = this._loadVolume()
    this.muted = localStorage.getItem('musicMuted') === '1'
    this.current = null       // key of the track that SHOULD be audible (or null)
    this.unlocked = this._preUnlocked
    this._rafId = null
    this._lastTs = null
  }

  _loadVolume() {
    const raw = parseFloat(localStorage.getItem('musicVolume'))
    return isNaN(raw) ? DEFAULT_VOLUME : clamp01(raw)
  }

  // the volume the CURRENT track eases toward (0 when muted); all others ease to 0.
  _targetFor(key) {
    if (key !== this.current) return 0
    return this.muted ? 0 : this.baseVolume
  }

  // Record the desired track and, if we're unlocked, start easing toward it. Safe
  // to call before unlock() — the track begins on the next unlock(). No-ops when
  // the desired track is already current.
  play(key) {
    if (!(key in this.tracks)) return
    if (this.current === key) return
    this.current = key
    if (this.unlocked) {
      this._start(key)
      this._ensureRaf()
    }
  }

  // Called from a genuine user gesture. Kicks the desired track's playback (the
  // browser now permits it) and starts the per-frame volume easing.
  //
  // NB: deliberately NO early-return on `this.unlocked`. Some mobile browsers
  // (observed on Android Chrome) REJECT an HTMLAudio play() attempted from
  // pointerdown/touchstart with NotAllowedError, yet ALLOW it from a later
  // click/touchend on the SAME tap. So every gesture must be free to RE-attempt
  // playback — `_start()` no-ops when the track is already rolling, so retrying is
  // cheap. Gating on a one-shot `unlocked` flag would strand the track silent after
  // the first (rejected) pointerdown attempt.
  unlock() {
    this.unlocked = true
    if (this.current) this._start(this.current)
    this._ensureRaf()
  }

  _start(key) {
    const el = this.tracks[key]
    if (!el || (this._failed && this._failed[key])) return
    if (el.paused) {
      const p = el.play()
      if (p && p.catch) p.catch(() => {}) // autoplay race: retried on next gesture
    }
  }

  setVolume(v) {
    this.baseVolume = clamp01(v)
    localStorage.setItem('musicVolume', String(this.baseVolume))
    this._ensureRaf()
  }

  setMuted(m) {
    this.muted = !!m
    localStorage.setItem('musicMuted', this.muted ? '1' : '0')
    this._ensureRaf()
  }

  toggleMute() {
    this.setMuted(!this.muted)
    return this.muted
  }

  _ensureRaf() {
    if (this._rafId != null) return
    this._lastTs = null
    const step = (ts) => {
      const dt = this._lastTs == null ? 0 : Math.min(0.1, (ts - this._lastTs) / 1000)
      this._lastTs = ts
      const done = this._ease(dt)
      if (done) { this._rafId = null; this._lastTs = null }
      else this._rafId = requestAnimationFrame(step)
    }
    this._rafId = requestAnimationFrame(step)
  }

  // Ease every track toward its target volume. Returns true when everything has
  // settled (so the RAF can stop and we're idle until the next state change).
  _ease(dt) {
    let settled = true
    const maxStep = FADE_PER_SEC * dt
    for (const key of Object.keys(this.tracks)) {
      const el = this.tracks[key]
      const target = this._targetFor(key)
      const diff = target - el.volume
      if (Math.abs(diff) <= (maxStep || 0.0001)) {
        el.volume = clamp01(target)
        // fully faded-out non-current track: pause to free the decoder, keep buffered
        if (key !== this.current && el.volume === 0 && !el.paused) el.pause()
      } else {
        el.volume = clamp01(el.volume + Math.sign(diff) * maxStep)
        settled = false
      }
    }
    return settled
  }
}
