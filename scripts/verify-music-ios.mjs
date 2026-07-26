// Reproduces the iPhone report against MusicManager: iOS Safari ignores writes to
// HTMLMediaElement.volume. Runs the same menu->match handoff twice, once with a
// writable volume (desktop) and once with a read-only one (iOS), and asserts that
// in BOTH cases exactly one track is left rolling.
class FakeAudio {
  constructor(readOnlyVolume) {
    this._ro = readOnlyVolume
    this._v = 1
    this.paused = true
    this.muted = false
    this.loop = false
    this.preload = ""
    this._src = ""
  }
  get volume() { return this._v }
  set volume(x) { if (!this._ro) this._v = x }   // iOS: silently dropped
  get src() { return this._src }
  set src(x) { this._src = x }
  getAttribute() { return this._src }
  addEventListener() {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}

async function run(readOnlyVolume) {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  globalThis.document = { getElementById: () => null }
  globalThis.Audio = class extends FakeAudio { constructor() { super(readOnlyVolume) } }
  const frames = []
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  const pump = (ms) => {
    let t = 0
    for (let i = 0; i < 600 && frames.length; i++) { t += ms; frames.shift()(t) }
    return frames.length // leftover == RAF still spinning
  }

  const { default: MusicManager } = await import("../client/graphics/MusicManager.js?" + readOnlyVolume)
  const m = new MusicManager()
  m.unlock()
  m.play("menu"); pump(16)
  m.play("match")
  const spinning = pump(16)
  return {
    menuPaused: m.tracks.menu.paused,
    matchPlaying: !m.tracks.match.paused,
    rafSpinning: spinning > 0,
  }
}

let bad = 0
for (const [label, ro] of [["desktop (writable volume)", false], ["iOS Safari (read-only volume)", true]]) {
  const r = await run(ro)
  const ok = r.menuPaused && r.matchPlaying && !r.rafSpinning
  if (!ok) bad++
  console.log((ok ? "PASS  " : "FAIL  ") + label,
    "| menu paused:", r.menuPaused, "| match playing:", r.matchPlaying, "| RAF still spinning:", r.rafSpinning)
}
process.exit(bad ? 1 : 0)
