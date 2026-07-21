import { CURRENCY } from '../config/currency'

// Presentation wiring for the main menu (a place, not a progress dialog). Covers the
// affordances that are NOT part of the enter-arena gate:
//   - CALLSIGN input (persisted to localStorage)
//   - WALLET CONNECT stub (parameterized SPL ticker from config/currency.js)
//   - HOW TO PLAY modal + the ISSUANCE / WHITEPAPER / ROADMAP info modals
//   - vertical plate menu: hover/keyboard selection + activation routing
//
// It reads/writes presentation DOM only. The gate, audio-resume and pointer-lock
// wiring all stay in Simulator; MenuControls calls back into Simulator ONLY for
// `_openSettings()` (the SETTINGS plate) and cheap menu audio ticks (`audio.uiHover`
// / `audio.uiClick`), both of which are safe no-ops before the AudioContext exists.
export default class MenuControls {
  constructor(simulator) {
    this._sim = simulator || null
    this._wireCallsign()
    this._wireWallet()
    this._wireModals()
    this._wirePlates()
    this._wireNowPlaying()
  }

  // NOW PLAYING readout under the PLAY plate: poll /mapinfo (~10s) while the menu
  // is the active surface and render the live rotation line. Defensive by design:
  // an old server returns only { mapId, name, mode } — no modeName/mapName → the
  // line stays hidden (data-live="false"). Fetch failures are silent.
  _wireNowPlaying() {
    this._npEl = document.getElementById('now-playing')
    if (!this._npEl || typeof fetch !== 'function') return
    const url = location.protocol === 'https:'
      ? `https://${location.host}/mapinfo`
      : `http://${location.hostname}:8078/mapinfo`
    const poll = async () => {
      // only while the menu is actually up (interval keeps ticking cheaply)
      const overlay = document.getElementById('entry-overlay')
      if (!overlay || !overlay.classList.contains('is-visible')) return
      if (document.body.classList.contains('arena-entered')) return
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) this._paintNowPlaying(await res.json())
      } catch (e) { /* unreachable / pre-endpoint server — line stays hidden */ }
    }
    poll()
    this._npTimer = setInterval(poll, 10000)
  }

  _paintNowPlaying(info) {
    const el = this._npEl
    if (!el) return
    // extended shape only: { mapName, modeName, players, bots, next: {...} }
    if (!info || !info.modeName || !info.mapName) {
      el.setAttribute('data-live', 'false')
      return
    }
    const total = (info.players | 0) + (info.bots | 0)
    const now = `${info.modeName} · ${info.mapName} · ${total} IN ARENA`.toUpperCase()
    const nowEl = document.getElementById('np-now-text')
    if (nowEl && nowEl.textContent !== now) nowEl.textContent = now
    const nextWrap = el.querySelector('.np-next')
    const nextEl = document.getElementById('np-next-text')
    if (info.next && info.next.modeName && info.next.mapName) {
      const next = `${info.next.modeName} · ${info.next.mapName}`.toUpperCase()
      if (nextEl && nextEl.textContent !== next) nextEl.textContent = next
      if (nextWrap) nextWrap.style.display = ''
    } else if (nextWrap) {
      nextWrap.style.display = 'none'
    }
    el.setAttribute('data-live', 'true')
  }

  // CALLSIGN: persist to localStorage, prefill on return. Purely cosmetic today
  // (the protocol carries no name yet — FragLayer still renders "Player <nid>");
  // stored under `callsign` so a future named-player feature can adopt it.
  _wireCallsign() {
    const input = document.getElementById('callsign-input')
    if (!input) return
    const saved = localStorage.getItem('callsign')
    if (saved) input.value = saved
    input.addEventListener('input', () => {
      localStorage.setItem('callsign', input.value.slice(0, 24))
    })
  }

  // WALLET PLATE + ISSUANCE ticker: parameterized SPL currency (config/currency.js).
  // No wallet adapter / web3 wired yet — this is a visual CONNECT stub. Both the
  // footer plate and the ISSUANCE modal render the configured symbol (placeholder
  // until the real token is chosen — never hardcode SOL).
  _wireWallet() {
    const symbolEl = document.getElementById('wallet-symbol')
    if (symbolEl) symbolEl.textContent = CURRENCY.tokenSymbol
    const issuanceSym = document.getElementById('issuance-symbol')
    if (issuanceSym) issuanceSym.textContent = CURRENCY.tokenSymbol
    const btn = document.getElementById('wallet-connect')
    if (btn) {
      // TODO(currency): swap this stub for a real wallet-adapter connect flow once
      // tokenMint is known. For now it just flags "not wired" so it's obvious.
      btn.addEventListener('click', () => {
        btn.classList.add('is-pending')
        btn.textContent = 'SOON'
        setTimeout(() => { btn.classList.remove('is-pending'); btn.textContent = 'CONNECT' }, 1400)
      })
    }
  }

  // MODALS: HOW TO PLAY + ISSUANCE / WHITEPAPER / ROADMAP all share the same ghost
  // chrome. Only one open at a time (opening one closes the rest). Close via the ✕
  // (data-modal-close), click-outside, or ESC. Content differs desktop/touch via CSS
  // body classes already present; this only flips visibility.
  _wireModals() {
    this._modals = Array.from(document.querySelectorAll(
      '#howto-modal, #issuance-modal, #whitepaper-modal, #roadmap-modal'
    ))
    const openBtn = document.getElementById('how-to-play')
    if (openBtn) openBtn.addEventListener('click', () => this.openModal('howto-modal'))

    for (const modal of this._modals) {
      const closedClass = this._closedClass(modal)
      // click on the scrim (the modal itself) or the ✕ closes.
      modal.addEventListener('click', (e) => {
        if (e.target === modal || (e.target.closest && e.target.closest('[data-modal-close]'))) {
          this.closeModal(modal)
        }
      })
      // guard: initial state is closed
      if (!modal.classList.contains(closedClass)) modal.classList.add(closedClass)
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      const open = this._modals.find((m) => !m.classList.contains(this._closedClass(m)))
      if (open) { this.closeModal(open); e.stopPropagation() }
    })
  }

  _closedClass(modal) {
    // howto uses .howto-closed; the info modals use .info-closed.
    return modal.id === 'howto-modal' ? 'howto-closed' : 'info-closed'
  }

  openModal(id) {
    const target = typeof id === 'string' ? document.getElementById(id) : id
    if (!target || !this._modals) return
    for (const m of this._modals) m.classList.add(this._closedClass(m)) // one at a time
    target.classList.remove(this._closedClass(target))
    if (this._sim && this._sim.audio) this._sim.audio.menuOpen()
  }

  closeModal(modal) {
    if (!modal) return
    modal.classList.add(this._closedClass(modal))
    if (this._sim && this._sim.audio) this._sim.audio.menuClose()
  }

  // PLATE MENU: hover selects, click activates, ↑/↓/W/S move selection, Enter/Space
  // activates. Selection state is a class on the plate (CSS draws the bracket/edge).
  // Actions route by data-action; PLAY's own click is already wired in Simulator
  // (#enter-arena) — we only add selection cues + keyboard activation for it.
  _wirePlates() {
    this._plates = Array.from(document.querySelectorAll('.menu-plate[data-menu-plate]'))
    if (!this._plates.length) return
    this._selected = 0

    const canHover = typeof window.matchMedia !== 'function' || window.matchMedia('(hover:hover)').matches

    this._plates.forEach((plate, i) => {
      plate.addEventListener('mouseenter', () => { if (canHover) this._select(i, true) })
      plate.addEventListener('focus', () => this._select(i, false))
      // Real clicks: PLAY is owned by Simulator's #enter-arena listener + the
      // delegated uiClick (Simulator), so only route the NON-play plates here to
      // avoid double-firing. Keyboard activation goes through _activate(true).
      plate.addEventListener('click', () => {
        if (plate.getAttribute('data-action') === 'play') return
        this._activate(plate, false)
      })
    })

    // keyboard nav is only meaningful while the menu is the active surface (no arena,
    // no modal open, focus not in a text field).
    document.addEventListener('keydown', (e) => {
      const overlay = document.getElementById('entry-overlay')
      if (!overlay || !overlay.classList.contains('is-visible')) return
      if (document.body.classList.contains('arena-entered')) return
      if (this._anyModalOpen()) return
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        // let callsign typing pass; only Enter from the field deploys.
        if (e.key === 'Enter' && e.target.id === 'callsign-input') {
          this._activate(this._plates[0], true); e.preventDefault()
        }
        return
      }
      const k = e.key
      if (k === 'ArrowDown' || k === 's' || k === 'S') { this._move(1); e.preventDefault() }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { this._move(-1); e.preventDefault() }
      else if (k === 'Enter' || k === ' ') { this._activate(this._plates[this._selected], true); e.preventDefault() }
    })

    this._select(0, false)
  }

  _anyModalOpen() {
    return !!(this._modals && this._modals.some((m) => !m.classList.contains(this._closedClass(m))))
  }

  _move(dir) {
    const n = this._plates.length
    this._select((this._selected + dir + n) % n, true)
  }

  _select(i, tick) {
    if (i === this._selected && this._plates[i] && this._plates[i].classList.contains('is-selected')) return
    this._selected = i
    this._plates.forEach((p, j) => p.classList.toggle('is-selected', j === i))
    if (tick && this._sim && this._sim.audio) this._sim.audio.uiHover()
  }

  _activate(plate, viaKeyboard) {
    if (!plate) return
    const action = plate.getAttribute('data-action')
    // uiClick for non-play plates only; PLAY's click tick is owned by Simulator's
    // delegated pointerdown handler (avoid a double tick on real clicks).
    if (action !== 'play' && this._sim && this._sim.audio) this._sim.audio.uiClick()
    switch (action) {
      case 'play':
        // PLAY is #enter-arena — Simulator's own click handler owns the gate + pointer
        // lock. Real clicks reach it directly; keyboard Enter synthesizes a click so
        // it counts as a fresh user gesture for requestPointerLock.
        if (viaKeyboard) plate.click()
        break
      case 'settings':
        if (this._sim && this._sim._openSettings) this._sim._openSettings()
        break
      case 'issuance':
        this.openModal('issuance-modal')
        break
      case 'whitepaper':
        this.openModal('whitepaper-modal')
        break
      case 'roadmap':
        this.openModal('roadmap-modal')
        break
      default:
        break
    }
  }
}
