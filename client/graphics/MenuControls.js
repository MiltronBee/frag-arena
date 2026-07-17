import { CURRENCY } from '../config/currency'

// Wiring for the new main-menu (loadscreen) affordances that are NOT part of the
// enter-arena gate: the CALLSIGN input (persisted to localStorage), the SPL
// wallet plate (visual stub — no web3 dependency yet), and the HOW TO PLAY panel
// toggle. Kept OUT of Simulator so the netcode/entry-gate class stays lean; the
// gate, audio-resume and pointer-lock wiring all remain in Simulator untouched.
//
// This module only reads/writes presentation DOM. It never touches prediction,
// commands, or the triple-gate state.
export default class MenuControls {
  constructor() {
    this._wireCallsign()
    this._wireWallet()
    this._wireHowTo()
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

  // WALLET PLATE: parameterized SPL currency (config/currency.js). No wallet
  // adapter / web3 wired yet — this is a visual CONNECT stub. The ticker shows
  // the configured symbol (placeholder until the real token is chosen).
  _wireWallet() {
    const symbolEl = document.getElementById('wallet-symbol')
    if (symbolEl) symbolEl.textContent = CURRENCY.tokenSymbol
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

  // HOW TO PLAY: toggle the ghost modal open/closed. Content differs desktop vs
  // touch via CSS body classes already present; this only flips visibility.
  _wireHowTo() {
    const open = document.getElementById('how-to-play')
    const modal = document.getElementById('howto-modal')
    if (!open || !modal) return
    const show = () => modal.classList.remove('howto-closed')
    const hide = () => modal.classList.add('howto-closed')
    open.addEventListener('click', show)
    modal.addEventListener('click', (e) => {
      if (e.target === modal || (e.target.id === 'howto-close')) hide()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('howto-closed')) hide()
    })
  }
}
