// ProgressReadout — the nerdy fake-hardware LED loading readout (Part B).
//
// Blends the real load gates into ONE 0..100 target and eases a DISPLAYED value
// toward it every frame so the digits tick smoothly through fractions. It drives
// two segment-display surfaces:
//   - the menu header uplink readout (#entry-seg / .seg-live), amber while loading,
//     green when the triple gate opens.
//   - a small echo on the splash cards (#splash-seg), updated only while the splash
//     node still exists (the inline splash can't reach Simulator state itself).
//
// Model (weights sum to 1.0):
//   asset preload fraction   0.85   (this._assetProgress)
//   websocket connected      0.08   (connectionState === 'connected')
//   first-entity / arenaReady 0.07  (_arenaReady)
//
// The "99.99 hold": while assets are done but the server gates are still pending,
// the target CRAWLS asymptotically toward 99.99 and HOLDS there — we never show
// 100.00 until the gate actually opens. On gate-open we snap to 100.00 + READY.
//
// Reduced motion: no easing, values jump straight to the target (still updated).

const ASSET_WEIGHT = 0.85
const CONN_WEIGHT = 0.08
const READY_WEIGHT = 0.07

// per-second ease factor for the displayed value chasing the target (exponential
// approach; frame-rate independent via 1 - exp(-k*dt)).
const EASE_K = 6.0

export default class ProgressReadout {
  constructor(sim) {
    this._sim = sim
    this._display = 0        // 0..100, the smoothly-eased shown value
    this._target = 0         // 0..100, the blended gate target
    this._open = false       // triple gate open (snap to 100 + READY)
    this._disconnected = false
    this._reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // header readout (menu). Cached lazily — the element may not exist yet at ctor.
    // Split-size digits: the integer part (.seg-int) is rendered LARGE, the fractional
    // part (.seg-frac) SMALL, gas-pump style; we write into the two sub-spans so the
    // ghost "888"/".88" underlay overlays the live glyphs exactly.
    this._intEl = null
    this._fracEl = null
    this._pctEl = null
    this._wrapEl = null
    this._splashIntEl = null
    this._splashFracEl = null
  }

  _cacheEls() {
    if (!this._intEl) this._intEl = document.getElementById('seg-int')
    if (!this._fracEl) this._fracEl = document.getElementById('seg-frac')
    if (!this._pctEl) this._pctEl = document.getElementById('seg-pct')
    if (!this._wrapEl) this._wrapEl = document.getElementById('entry-seg')
    // splash echo may be removed once the splash dismisses — re-query each frame is
    // cheap and self-heals (returns null once gone → guarded below).
    this._splashIntEl = document.getElementById('splash-seg-int')
    this._splashFracEl = document.getElementById('splash-seg-frac')
  }

  // Recompute the 0..100 target from the live gate state on the simulator. Called
  // every frame from update(); reading straight off the sim keeps a single source.
  _recomputeTarget() {
    const sim = this._sim
    const connected = sim._connectionState === 'connected'
    this._disconnected = sim._connectionState === 'disconnected'
    const assetFrac = Math.max(0, Math.min(1, sim._assetProgress || 0))
    const arenaReady = !!sim._arenaReady
    this._open = connected && arenaReady && !!sim._assetsReady

    if (this._open) { this._target = 100; return }

    let t = assetFrac * ASSET_WEIGHT +
      (connected ? CONN_WEIGHT : 0) +
      (arenaReady ? READY_WEIGHT : 0)
    t *= 100

    // Assets done but server gates pending → aim at 99.99 and HOLD. The per-frame ease
    // makes the shown value crawl 99.90 → 99.99 and settle. Never reaches 100 until the
    // gate truly opens (handled by the _open branch above).
    if (sim._assetsReady && !this._open) t = Math.max(t, 99.99)
    // general safety: below the open gate, never present a full 100.
    if (t > 99.99) t = 99.99
    this._target = t
  }

  // per-frame tick. `dt` in seconds (from the main loop). Eases the display toward
  // target, then paints both surfaces only when the shown text changes.
  update(dt) {
    this._cacheEls()
    this._recomputeTarget()

    if (this._open) {
      // snap on gate-open so READY reads a clean 100.00
      this._display = 100
    } else if (this._reduced) {
      this._display = this._target
    } else {
      const k = 1 - Math.exp(-EASE_K * Math.max(0.0001, Math.min(0.1, dt || 0.016)))
      this._display += (this._target - this._display) * k
      // when very close, keep crawling the last hundredths so 99.99 is reached
      if (this._target - this._display > 0 && this._target - this._display < 0.005) {
        this._display = this._target
      }
    }

    this._paint()
  }

  // format the displayed value into split int/frac parts. The integer part varies
  // 1..3 chars ("0".."100") and is rendered LARGE; the frac (".NN") is rendered small.
  // Disconnected → int "--", frac ".--" (the leading dot keeps the small-glyph column
  // aligned with the live/ghost layout). Returns { int, frac }.
  _parts() {
    if (this._disconnected) return { int: '--', frac: '.--' }
    let v = this._display
    if (v < 0) v = 0
    if (v > 100) v = 100
    // 2dp; the integer part is NOT zero-padded (gas-pump meters show "0".."100"),
    // the reserved fixed width + right-alignment stops any jitter as it grows.
    const s = v.toFixed(2)
    const dot = s.indexOf('.')
    return { int: s.slice(0, dot), frac: s.slice(dot) }
  }

  _paint() {
    const { int, frac } = this._parts()

    // ---- menu header readout (split large int / small frac) ----
    if (this._intEl && this._intEl.textContent !== int) this._intEl.textContent = int
    if (this._fracEl && this._fracEl.textContent !== frac) this._fracEl.textContent = frac
    if (this._wrapEl) {
      // state attr drives the amber/green/red LED styling (CSS).
      const state = this._disconnected ? 'lost' : (this._open ? 'ready' : 'loading')
      if (this._wrapEl.getAttribute('data-state') !== state) {
        this._wrapEl.setAttribute('data-state', state)
      }
      // hide the % sign when showing dashes (no meaningful percent)
      if (this._pctEl) this._pctEl.style.visibility = this._disconnected ? 'hidden' : 'visible'
    }

    // ---- splash echo (guard: nodes removed once splash dismisses) ----
    if (this._splashIntEl && this._splashIntEl.textContent !== int) this._splashIntEl.textContent = int
    if (this._splashFracEl && this._splashFracEl.textContent !== frac) this._splashFracEl.textContent = frac
  }
}
