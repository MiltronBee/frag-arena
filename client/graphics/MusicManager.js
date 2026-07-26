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
//
// iOS SAFARI HAS NO WRITABLE VOLUME. On iPhone/iPad, WebKit makes
// HTMLMediaElement.volume read-only: the setter is silently ignored (no throw) and
// the property keeps reading back 1, because the hardware volume buttons are the
// only volume control Apple exposes. That does not merely disable the fade — it
// BREAKS THE HANDOFF, because _ease() steers on el.volume: the diff never closes,
// the settle branch that PAUSES the outgoing track is never reached, and both beds
// play at once, at full level, forever, with the RAF spinning behind them.
// (Field report 2026-07-26, iPhone 15 Pro / Safari: "the intro music and the game
// music are still playing at the same time".) So we detect a writable volume once
// and, where there isn't one, switch tracks by pause/play instead — a hard cut.

const TRACKS = {
  menu: '/assets/music/arena-signal.mp3',
  match: '/assets/music/frag-grenade.mp3',
}

// MIX RETUNE (2026-07-24, "music is too loud"). 0.35 sat on top of the weapons and
// the narrator; the bed belongs UNDER both. See WeaponAudio's MIX block for the two
// matching levers (narrator bus gain, shot gain).
const DEFAULT_VOLUME = 0.18   // low by default — background bed, not foreground
// Bumping MIX_VERSION RE-BASELINES every existing player's saved 'musicVolume' to the
// new default ONCE. Without this, changing DEFAULT_VOLUME would only affect brand-new
// browsers: anyone who has already played has 0.35 persisted in localStorage (written
// on first load) and would keep hearing the OLD, too-loud bed forever. A player who
// deliberately moves the Settings slider AFTER this migration keeps their choice,
// because the migration runs at most once per version.
const MIX_VERSION = '2'
const FADE_PER_SEC = 1.8      // volume units/sec while crossfading (~0.5s full fade)

// Is HTMLMediaElement.volume actually writable here? One probe element, once at
// construction. Anything that fails or refuses to take the value is treated as
// locked, so the safe hard-cut path is the fallback for every uncertain case.
function volumeIsWritable() {
  try {
    if (typeof Audio === 'undefined') return false
    const probe = new Audio()
    probe.volume = 0.5
    return probe.volume === 0.5
  } catch (e) { return false }
}

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
    // iOS Safari: no writable volume => no crossfade, and _ease() switches to a hard
    // cut. See the header block.
    this._volumeLocked = !volumeIsWritable()
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
    this._duckUntil = 0       // performance.now() ms at which the narrator duck releases
    this._duckAmount = 1      // multiplier on baseVolume while ducked (1 = no duck)
  }

  _loadVolume() {
    // ONE-TIME re-baseline to the new default when the mix version moves (see
    // MIX_VERSION). Runs before the stored read, so the stored value is replaced,
    // not merely ignored.
    try {
      if (localStorage.getItem('musicMixVersion') !== MIX_VERSION) {
        localStorage.setItem('musicMixVersion', MIX_VERSION)
        localStorage.setItem('musicVolume', String(DEFAULT_VOLUME))
        return DEFAULT_VOLUME
      }
    } catch (e) { /* private-mode / storage-disabled: fall through to the default */ }
    const raw = parseFloat(localStorage.getItem('musicVolume'))
    return isNaN(raw) ? DEFAULT_VOLUME : clamp01(raw)
  }

  // ── DUCKING (narrator priority) ────────────────────────────────────────────────
  // Push the bed down to `amount` (a multiplier on baseVolume) for `hold` seconds,
  // then release back. Called by WeaponAudio.announce via the hook the Simulator
  // wires up, so a callout is never fighting the music for the same space.
  //
  // Overlapping ducks take the DEEPEST level and the LATEST expiry, so a burst of
  // callouts holds the bed down continuously instead of pumping it back up between
  // them. The per-frame _ease already interpolates toward _targetFor(), so ducking is
  // just a factor there — no second animation loop.
  setDuck(amount, hold = 1.4) {
    const a = clamp01(amount)
    const until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + hold * 1000
    if (this._duckUntil && this._duckUntil > until && this._duckAmount <= a) {
      // an existing deeper/longer duck already covers this one
      this._ensureRaf()
      return
    }
    this._duckAmount = this._duckUntil && this._duckUntil > (typeof performance !== 'undefined' ? performance.now() : Date.now())
      ? Math.min(this._duckAmount, a)
      : a
    this._duckUntil = Math.max(this._duckUntil || 0, until)
    this._ensureRaf()
  }

  // current duck multiplier (1 = no duck). Expired ducks clear themselves here so
  // there is no timer to leak.
  _duckFactor() {
    if (!this._duckUntil) return 1
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now >= this._duckUntil) { this._duckUntil = 0; this._duckAmount = 1; return 1 }
    return this._duckAmount == null ? 1 : this._duckAmount
  }

  // the volume the CURRENT track eases toward (0 when muted); all others ease to 0.
  _targetFor(key) {
    if (key !== this.current) return 0
    if (this.muted) return 0
    return this.baseVolume * this._duckFactor()
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
    // HARD-CUT PATH (iOS Safari: volume is read-only — see the header). Nothing can be
    // ramped, so the ONLY thing that matters is that exactly one track is rolling:
    // start `current`, pause everything else. Playback is tied to `current` alone and
    // NOT to the target volume, deliberately — routing mute/volume-0 through pause()
    // would mean un-muting has to call play() from a RAF tick rather than from the tap
    // that toggled it, which iOS would reject, stranding the music off. `muted` IS
    // honored on iOS (it is a separate property from `volume`), so mute rides on that
    // and the track keeps rolling silently underneath, ready to resume with no gesture.
    // Returns settled immediately: there is no ramp to run, and leaving the RAF alive
    // to re-test an unchanging condition every frame is a battery leak on a phone.
    if (this._volumeLocked) {
      for (const key of Object.keys(this.tracks)) {
        const el = this.tracks[key]
        el.muted = this.muted || !(this.baseVolume > 0)
        if (key === this.current) { if (el.paused) this._start(key) }
        else if (!el.paused) el.pause()
      }
      return true
    }

    // A live duck must keep the RAF alive even once the fade has settled at the
    // DUCKED level — otherwise the loop stops and the bed never eases back up when
    // the duck expires. _duckFactor() self-clears on expiry, so this releases itself.
    let settled = this._duckFactor() === 1
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
