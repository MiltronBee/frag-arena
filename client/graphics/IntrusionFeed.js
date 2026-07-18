// IntrusionFeed — fake "hacking into a secure system" terminal theater (Part D).
//
// Pure flavor. While the triple gate is CLOSED, this appends invented hacker lines on a
// randomized cadence (~350–900ms) into two surfaces:
//   - MENU: a small terminal panel (#hack-feed / #hack-feed-lines) bottom-left of the
//     entry overlay — ~4–6 visible lines, older lines dim/scroll up, green phosphor.
//   - SPLASH: one single cycling ticker line (#splash-hack) near the corner readout.
//
// It NEVER duplicates gate logic — it reads the same Simulator fields ProgressReadout
// reads (_connectionState / _arenaReady / _assetsReady / _assetStage) each tick.
//
// States:
//   gate closed  → keep appending random lines on the cadence
//   READY (open) → one distinct green climax line "ACCESS GRANTED …", then STOP
//   disconnected → one red "CONNECTION TRACED :: UPLINK LOST", then STOP
//
// Reduced motion: lines still swap on cadence, but instantly (no typewriter / scroll
// animation). All timers are killed once terminal (READY/lost) or dismissed → no
// perpetual work after entry.

const MAX_LINES = 6          // rows kept in the menu panel DOM (CSS caps visible rows)
const CADENCE_MIN = 350      // ms
const CADENCE_MAX = 900      // ms

// tone class per line: 'ok' (bright bracket), 'warn' (amber-ish), plain (dim phosphor).
// { t: template, s: stage-bias tag (matches Simulator._assetStage) }
const POOL = [
  { t: 'scanning perimeter nodes ... {n1} found' },
  { t: 'bypassing firewall [OK]', ok: 1 },
  { t: 'injecting code subroutine 0x{hex4}' },
  { t: 'spoofing hardware signature :: {mac}' },
  { t: 'decrypting weapon vault keys ... OK', ok: 1, s: 'WEAPONS' },
  { t: 'handshake accepted :: relay {n1}', ok: 1 },
  { t: 'escalating privileges → root', warn: 1 },
  { t: 'tunneling through proxy 10.4.{n255}.{n255}' },
  { t: 'disabling intrusion countermeasures', warn: 1 },
  { t: 'patching mainframe hooks [OK]', ok: 1 },
  { t: 'exfiltrating arena schematics ... {kb}kb', s: 'MAP' },
  { t: 'overriding turret lockouts', warn: 1 },
  { t: 'seeding frag protocol v{n1}.{n1}' },
  { t: 'resolving shard cluster {hex4}::{port}' },
  { t: 'brute-forcing keyslot [{n2}%]', warn: 1 },
  { t: 'mapping arena geometry ... {n2} sectors', s: 'MAP' },
  { t: 'loading combat avatars :: {n2} rigs', s: 'CHARACTERS' },
  { t: 'flashing muzzle firmware 0x{hex4}', s: 'WEAPONS' },
  { t: 'staging audio payload ... {kb}kb', s: 'SOUNDS' },
  { t: 'priming particle cannons [OK]', ok: 1, s: 'EFFECTS' },
  { t: 'compiling shader intrusion kernel', s: 'EFFECTS' },
  { t: 'rerouting through darknet gateway {ip}' },
  { t: 'ghosting session id {hex4}{hex4}' },
  { t: 'cracking vault sig ... {n2}% [{hex4}]' },
  { t: 'planting rootkit :: node {n255}', warn: 1 },
  { t: 'sniffing telemetry stream port {port}' },
  { t: 'forging clearance token [OK]', ok: 1 },
  { t: 'wiping access trail ... clean', ok: 1 },
  { t: 'hijacking uplink relay {n1}', warn: 1 },
  { t: 'defeating countermeasure grid 0x{hex4}', warn: 1 },
  { t: 'unlocking loadout registry [OK]', ok: 1, s: 'WEAPONS' },
  { t: 'syncing kill protocol {hex4}' },
  { t: 'finalizing breach vector [{n2}%]', s: 'FINALIZING' },
]

function rInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)) }
function rHex(n) {
  let s = ''
  for (let i = 0; i < n; i++) s += '0123456789ABCDEF'[rInt(0, 15)]
  return s
}
function rMac() {
  const p = []
  for (let i = 0; i < 6; i++) p.push(rHex(2).toLowerCase())
  return p.join(':')
}
function fill(t) {
  return t
    .replace(/\{hex4\}/g, () => rHex(4))
    .replace(/\{n255\}/g, () => String(rInt(0, 255)))
    .replace(/\{n2\}/g, () => String(rInt(10, 99)))
    .replace(/\{n1\}/g, () => String(rInt(2, 9)))
    .replace(/\{kb\}/g, () => String(rInt(64, 992)))
    .replace(/\{port\}/g, () => String(rInt(1024, 9999)))
    .replace(/\{mac\}/g, rMac)
    .replace(/\{ip\}/g, () => `${rInt(11, 210)}.${rInt(0, 255)}.${rInt(0, 255)}.${rInt(1, 254)}`)
}

export default class IntrusionFeed {
  constructor(sim) {
    this._sim = sim
    this._reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this._timer = null
    this._done = false        // terminal state reached (READY/lost) → no more timers
    this._started = false

    // menu panel + splash ticker (may not exist yet / may be removed on dismiss).
    this._linesEl = null
    this._splashEl = null
    this._rows = []           // {el} kept for dim/scroll bookkeeping
  }

  // called once by Simulator after construction. Kicks the first line + schedules more.
  start() {
    if (this._started) return
    this._started = true
    this._cacheEls()
    // seed one immediately so the panel isn't empty on first paint
    this._emit(this._nextLine())
    this._schedule()
  }

  _cacheEls() {
    if (!this._linesEl) this._linesEl = document.getElementById('hack-feed-lines')
    // splash ticker re-queried each use (node removed on splash dismiss → guarded)
    this._splashEl = document.getElementById('splash-hack')
  }

  // Terminal-state header: swap the "BREAKING INTO SECURE NETWORK" title and tag the
  // panel so CSS freezes the animated ellipsis/dot (green on breach, red on trace).
  _setHeader(cls, title) {
    const panel = document.getElementById('hack-feed')
    if (panel) { panel.classList.remove('hack-done', 'hack-lost'); panel.classList.add(cls) }
    const titleEl = document.getElementById('hack-feed-title')
    if (titleEl) titleEl.textContent = title
  }

  // gate state, read straight off the sim (single source, same as ProgressReadout).
  _gate() {
    const sim = this._sim
    const connected = sim._connectionState === 'connected'
    const disconnected = sim._connectionState === 'disconnected'
    const open = connected && !!sim._arenaReady && !!sim._assetsReady
    return { open, disconnected, stage: sim._assetStage }
  }

  _schedule() {
    if (this._done) return
    clearTimeout(this._timer)
    const delay = rInt(CADENCE_MIN, CADENCE_MAX)
    this._timer = setTimeout(() => this._tick(), delay)
  }

  _tick() {
    if (this._done) return
    this._cacheEls()
    const { open, disconnected } = this._gate()

    if (disconnected) {
      this._emit({ text: 'CONNECTION TRACED :: UPLINK LOST', tone: 'lost' })
      this._setHeader('hack-lost', 'UPLINK SEVERED')
      this._finish()
      return
    }
    if (open) {
      this._emit({ text: 'ACCESS GRANTED — ARENA UPLINK SECURE', tone: 'granted' })
      this._setHeader('hack-done', 'NETWORK BREACHED')
      this._finish()
      return
    }
    this._emit(this._nextLine())
    this._schedule()
  }

  // build the next flavored line, biased toward the current load stage when possible.
  _nextLine() {
    const { stage } = this._gate()
    let pick
    // ~45% of the time, if the current stage has matching lines, prefer one.
    if (stage && Math.random() < 0.45) {
      const staged = POOL.filter(p => p.s === stage)
      if (staged.length) pick = staged[rInt(0, staged.length - 1)]
    }
    if (!pick) pick = POOL[rInt(0, POOL.length - 1)]
    const tone = pick.ok ? 'ok' : (pick.warn ? 'warn' : '')
    return { text: '> ' + fill(pick.t), tone }
  }

  // write a line to the menu panel (scrolling) + the splash ticker (single line).
  _emit(line) {
    if (!line) return
    // ---- menu panel ----
    if (this._linesEl) {
      const row = document.createElement('div')
      row.className = 'hack-line' + (line.tone ? ' hack-' + line.tone : '')
      row.textContent = line.text
      if (this._reduced) row.classList.add('no-anim')
      this._linesEl.appendChild(row)
      this._rows.push(row)
      // trim to MAX_LINES (drop oldest DOM nodes)
      while (this._rows.length > MAX_LINES) {
        const old = this._rows.shift()
        if (old && old.parentNode) old.parentNode.removeChild(old)
      }
      // re-grade opacity so older lines dim toward the top
      const n = this._rows.length
      for (let i = 0; i < n; i++) {
        this._rows[i].style.opacity = String(0.28 + 0.72 * ((i + 1) / n))
      }
    }
    // ---- splash ticker (single cycling line) ----
    if (this._splashEl) {
      this._splashEl.className = 'splash-hack' + (line.tone ? ' hack-' + line.tone : '') +
        (this._reduced ? ' no-anim' : '')
      this._splashEl.textContent = line.text
    }
  }

  // terminal climax reached — stop all timers; leave the final line visible.
  _finish() {
    this._done = true
    clearTimeout(this._timer)
    this._timer = null
  }

  // hard stop (e.g. arena entered / overlay gone). Idempotent.
  stop() {
    this._done = true
    clearTimeout(this._timer)
    this._timer = null
  }
}
