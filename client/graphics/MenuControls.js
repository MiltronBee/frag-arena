import { CURRENCY } from '../config/currency'
import EquipCommand from '../../common/command/EquipCommand'
import LinkWalletCommand from '../../common/command/LinkWalletCommand'
import MenuScreens from './MenuScreens'
import { FINISHES, ownedFinishes, NFT_ENTITLEMENTS } from '../../common/entitlements.js'

// NFT on-chain name -> how the loadout panel labels it. Keyed by the SAME on-chain names
// common/entitlements.js grants on, so the panel can never claim a weapon the server
// would not actually hand out. Order is the weapon-rack order, weakest first.
const WEAPON_NFT_LABELS = [
  ['Static Repeater', 'SMG'],
  ['Vector Rifle', 'Rifle'],
  ['Breach Ward', 'Shotgun'],
  ['Long Debt', 'Sniper'],
]
const ARMOR_NFT_LABELS = [
  ['Degen Helm', 'Helm'],
  ['Cloth Cuirass', 'Cuirass'],
  ['Cloth Pauldron', 'Pauldron'],
  ['Cloth Joint Cap', 'Joint Cap'],
  ['Cloth Sabaton', 'Sabaton'],
]
const WEAPON_NFTS = new Set(WEAPON_NFT_LABELS.map(([n]) => n))

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
    // Screens come last: MenuScreens reads the hash on construction and may open a screen
    // straight away (a shared #/codex/proof-of-blood link), which needs the plates and
    // modals already wired so the surface it reveals is a finished one.
    this._screens = new MenuScreens(simulator, this)
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
    // wallet-modal is in this list so it gets the SAME close wiring (✕ / click-outside /
    // ESC) as the info modals — without it the wallet panel opens but cannot be dismissed,
    // which made linking feel broken from the main menu too.
    //
    // LOADOUT, ISSUANCE and WHITEPAPER are no longer here: they are screens now, and
    // MenuScreens owns their open/close. What remains are the genuine interruptions —
    // things you return FROM, rather than places you go.
    this._modals = Array.from(document.querySelectorAll(
      '#howto-modal, #roadmap-modal, #wallet-modal'
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
    // This closes siblings by class directly rather than through closeModal(), so the
    // preview teardown has to be repeated here — switching LOADOUT -> SETTINGS would
    // otherwise strand a live WebGL context behind a hidden panel.
    if (target.id !== 'loadout-modal') this._closeLoadout()
    target.classList.remove(this._closedClass(target))
    if (this._sim && this._sim.audio) this._sim.audio.menuOpen()
  }

  closeModal(modal) {
    if (!modal) return
    modal.classList.add(this._closedClass(modal))
    // Release the preview's WebGL context and render loop. openModal also closes any
    // other modal to open a new one, so this is routed through here rather than through
    // the close button — otherwise switching straight from LOADOUT to SETTINGS would
    // leave a second engine rendering behind a hidden panel forever.
    if (modal.id === 'loadout-modal') this._closeLoadout()
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

  // LINK WALLET (read-only). Stores the pasted address locally; GameClient sends it in
  // the next join handshake and the SERVER re-reads the chain to decide the grant. This
  // page never connects a wallet, never asks for a signature and never sees a key — the
  // preview below is purely so the player can confirm they pasted the right address.
  _initWalletLink() {
    if (this._walletWired) return
    this._walletWired = true
    const input = document.getElementById('wallet-input')
    const btn = document.getElementById('wallet-link-btn')
    const status = document.getElementById('wallet-status')
    const rows = document.getElementById('wallet-holdings')
    const sub = document.getElementById('wallet-plate-sub')
    if (!input || !btn) return

    const saved = (() => { try { return localStorage.getItem('degen.wallet') || '' } catch { return '' } })()
    if (saved) { input.value = saved; this._walletLookup(saved) }

    const go = () => {
      const addr = (input.value || '').trim()
      if (!addr) {
        try { localStorage.removeItem('degen.wallet') } catch {}
        if (status) status.textContent = 'unlinked.'
        if (rows) rows.innerHTML = ''
        if (sub) sub.textContent = 'read-only · unlock what you own'
        this._sendWalletLink('')
        return
      }
      try { localStorage.setItem('degen.wallet', addr) } catch {}
      this._walletLookup(addr)
      // TELL THE GAME SERVER, not just the HTTP lookup. localStorage alone only reaches
      // the server through the handshake, which already happened at page load — so
      // before this existed, linking a wallet for the first time granted nothing until
      // the player happened to reload. See common/command/LinkWalletCommand.js.
      this._sendWalletLink(addr)
    }
    btn.addEventListener('click', go)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go() } })
  }

  // The server finished its chain read and applied (or declined) a grant. This is the
  // authoritative line — it reports what the GAME will actually hand you, which is a
  // different question from what the chain says you hold, and the one that was quietly
  // wrong before. Names the weapons rather than counting them: "SNIPER, SMG READY" tells
  // a player what to press; "2 weapons" does not.
  onWalletLinked(count, weaponMask) {
    const status = document.getElementById('wallet-status')
    if (!status) return
    if (!count) { status.textContent = 'no Degen Tournament items in this wallet'; return }
    const armed = WEAPON_NFT_LABELS
      .filter(([name]) => {
        const e = NFT_ENTITLEMENTS[name]
        return e && (weaponMask & (1 << e.weaponIndex))
      })
      .map(([, label]) => label.toUpperCase())
    status.textContent = armed.length
      ? `${armed.join(', ')} READY · ${count} item${count === 1 ? '' : 's'} held`
      : `${count} item${count === 1 ? '' : 's'} held · armour only, no weapon NFT`
  }

  // Push the linked address down the game socket. Separate from _walletLookup on purpose:
  // that one asks the CHAIN what is held (and paints the list), this one tells the GAME
  // to re-derive the grant. They used to be the same call, which is exactly how the panel
  // ended up able to show you a wallet full of weapons you could not draw.
  //
  // The menu is reachable before the socket finishes connecting, so a send can arrive too
  // early. Rather than drop it — which would put us straight back in the silent-failure
  // hole this fixes — the address is held and re-sent until it lands.
  _sendWalletLink(addr) {
    this._pendingWalletLink = addr
    if (this._walletLinkTimer) { clearInterval(this._walletLinkTimer); this._walletLinkTimer = null }
    let tries = 0
    const attempt = () => {
      const s = this._sim
      if (s && s.client && typeof s.client.addCommand === 'function') {
        s.client.addCommand(new LinkWalletCommand(this._pendingWalletLink))
        if (this._walletLinkTimer) { clearInterval(this._walletLinkTimer); this._walletLinkTimer = null }
        return true
      }
      // ~10s of grace, then give up quietly: the address is in localStorage regardless,
      // so the next page load carries it in the handshake and nothing is permanently lost.
      if (++tries > 20 && this._walletLinkTimer) {
        clearInterval(this._walletLinkTimer); this._walletLinkTimer = null
      }
      return false
    }
    if (!attempt()) this._walletLinkTimer = setInterval(attempt, 500)
  }

  _walletLookup(addr) {
    const status = document.getElementById('wallet-status')
    const rows = document.getElementById('wallet-holdings')
    const sub = document.getElementById('wallet-plate-sub')
    if (status) status.textContent = 'reading chain…'
    if (rows) rows.innerHTML = ''
    // same origin in prod (nginx proxies /wallet); dev hits the mapinfo port directly
    const base = location.protocol === 'https:' ? '' : `http://${location.hostname}:8078`
    fetch(`${base}/wallet/${encodeURIComponent(addr)}`, { cache: 'no-store' })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) { if (status) status.textContent = j.error || 'read failed'; return }
        const n = j.count || 0
        if (status) {
          // NOT "unlocks apply on next join" any more. That was written when the address
          // only ever reached the server via the handshake, and it was a promise the game
          // could not keep — there is no next join without a reload. The grant is now
          // pushed live (see _sendWalletLink), and the server confirms what it actually
          // applied via the WalletLinked message, which overwrites this line.
          status.textContent = n
            ? `${n} item${n === 1 ? '' : 's'} held · arming…`
            : 'no Degen Tournament items in this wallet'
        }
        if (sub) sub.textContent = n ? `${addr.slice(0, 4)}…${addr.slice(-4)} · ${n} held` : 'read-only · unlock what you own'
        if (rows) {
          rows.innerHTML = ''
          for (const name of (j.names || []).slice().sort()) {
            const li = document.createElement('li')
            const a = document.createElement('span'); a.textContent = name
            const b = document.createElement('b')
            // Was hardcoded to 'Long Debt' back when the Sniper was the only NFT that
            // granted anything. All four weapon NFTs grant their weapon now, so ask the
            // shared table instead of naming one item — otherwise a Vector Rifle holder
            // is told their weapon is merely "OWNED".
            b.textContent = WEAPON_NFTS.has(name) ? 'WEAPON UNLOCKED' : 'OWNED'
            li.appendChild(a); li.appendChild(b); rows.appendChild(li)
          }
        }
        // keep the loadout panel truthful the moment a wallet is (un)linked
        this._lastHoldings = j.names || []
        if (this._loadout) this._renderLoadout()
      })
      .catch((e) => { if (status) status.textContent = 'read failed: ' + e.message })
  }

  // ── LOADOUT ────────────────────────────────────────────────────────────────
  // Opening the panel builds the 3D preview lazily (its own engine — see
  // LoadoutPreview) and paints the two lists. Closing tears the engine down again.
  async _openLoadout() {
    const canvas = document.getElementById('loadout-canvas')
    if (!canvas) return
    // Read whatever the wallet panel last resolved; if the player linked in a previous
    // session we still have the address, so re-read rather than showing them nothing.
    if (!this._lastHoldings) {
      const saved = (() => { try { return localStorage.getItem('degen.wallet') || '' } catch { return '' } })()
      if (saved) this._walletLookup(saved)
    }
    this._renderLoadout()
    if (!this._loadout) {
      // Loaded on demand: the preview drags in CharacterModel and a second Babylon
      // engine, and a player who never opens this panel should never pay for either.
      const { default: LoadoutPreview } = await import('./LoadoutPreview.js')
      this._loadout = new LoadoutPreview(canvas)
    }
    this._loadout.show(this._lastHoldings || [], this._finish)
  }

  _closeLoadout() {
    if (this._loadout) { this._loadout.dispose(); this._loadout = null }
  }

  // The CHARACTER screen's lifecycle hooks, called by MenuScreens on enter/leave. Same
  // work _openLoadout/_closeLoadout did for the modal — the WebGL context and its render
  // loop are built on arrival and released on departure, because a second Babylon engine
  // idling behind a hidden surface is a real cost on the machines this has to run on.
  onCharacterScreenEnter() { this._openLoadout() }
  onCharacterScreenLeave() { this._closeLoadout() }

  // Paint the weapon rack and the Cloth list. Every gated weapon is listed whether or
  // not it is owned — a LOCKED row is the entire point, because it tells an unlinked
  // player what exists and what linking would give them.
  // Build the finish selector from what the wallet holds. A finish the player owns no
  // piece of is not offered at all — the server would refuse it anyway, and showing a
  // button that silently does nothing is worse than showing none.
  _renderFinishes(held) {
    const box = document.getElementById('finish-picker')
    if (!box) return
    box.innerHTML = ''
    const owned = ownedFinishes([...held])
    if (!owned.length) {
      const p = document.createElement('p')
      p.className = 'finish-none'
      p.textContent = 'No Cloth in this wallet — you deploy in the default kit.'
      box.appendChild(p)
      return
    }
    for (const o of owned) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'finish-btn'
      b.setAttribute('data-finish', o.finish.toLowerCase())
      if (this._finish === o.finish) b.setAttribute('aria-pressed', 'true')
      else b.setAttribute('aria-pressed', 'false')
      b.innerHTML = '<span class="fsw"></span><b>' + o.finish + '</b>' +
        '<span class="fstat">' + (o.complete ? 'full set' : o.slots.length + '/5') + '</span>'
      b.addEventListener('click', () => this._equip(o.finish))
      box.appendChild(b)
    }
  }

  // Send the request and repaint optimistically. The server re-checks it against the
  // wallet and simply ignores anything the holder cannot wear, so a rejected swap just
  // means the body never changes — no error state to handle.
  _equip(finish) {
    this._finish = finish
    try { localStorage.setItem('degen.finish', finish) } catch (e) {}
    const idx = FINISHES.indexOf(finish)
    const s = this._sim
    if (s && s.client && idx >= 0) s.client.addCommand(new EquipCommand(idx))
    this._renderFinishes(new Set(this._lastHoldings || []))
    if (this._loadout) this._loadout.show(this._lastHoldings || [], finish)
  }

  _renderLoadout() {
    const held = new Set(this._lastHoldings || [])
    if (!this._finish) {
      try { this._finish = localStorage.getItem('degen.finish') || null } catch (e) { this._finish = null }
    }
    // default to the first finish they actually own
    const own = ownedFinishes([...held])
    if (!own.some((o) => o.finish === this._finish)) this._finish = own.length ? own[0].finish : null
    this._renderFinishes(held)
    const wRows = document.getElementById('loadout-weapons')
    const aRows = document.getElementById('loadout-armor')
    const note = document.getElementById('loadout-note')
    const sub = document.getElementById('loadout-plate-sub')

    const row = (label, value, state) => {
      const li = document.createElement('li')
      if (state) li.setAttribute('data-state', state)
      const s = document.createElement('span'); s.textContent = label
      const b = document.createElement('b'); b.textContent = value
      li.appendChild(s); li.appendChild(b)
      return li
    }

    if (wRows) {
      wRows.innerHTML = ''
      // The Pistol is not in the collection and never can be — it is the free spawn
      // weapon, so it is always listed as issued rather than as something to acquire.
      wRows.appendChild(row('Pistol', 'ISSUED', 'issued'))
      for (const [nft, label] of WEAPON_NFT_LABELS) {
        wRows.appendChild(held.has(nft)
          ? row(label, 'CARRIED', 'owned')
          : row(label, 'LOCKED', 'locked'))
      }
    }

    if (aRows) {
      aRows.innerHTML = ''
      for (const [nft, label] of ARMOR_NFT_LABELS) {
        aRows.appendChild(held.has(nft)
          ? row(label, 'WORN', 'owned')
          : row(label, 'LOCKED', 'locked'))
      }
    }

    const nWeapons = WEAPON_NFT_LABELS.filter(([n]) => held.has(n)).length
    if (sub) sub.textContent = held.size ? `${held.size} held · ${nWeapons} weapon${nWeapons === 1 ? '' : 's'}` : 'see what you deploy with'
    if (note) {
      note.textContent = held.size
        ? 'Everyone spawns with the Pistol. Nothing else spawns on the arena floor — you carry what you own, and it drops where you die for whoever kills you.'
        : 'No wallet linked, so you deploy with the Pistol only. Nothing spawns on the arena floor any more: link a wallet to carry what you own, or take a weapon off someone you kill and keep it until you die.'
    }
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
      case 'link-wallet':
        this.openModal('wallet-modal')
        this._initWalletLink()
        break
      // These three are SCREENS, not modals — routed destinations that replace the menu
      // (see MenuScreens). Everything used to be a panel floating over the same surface,
      // which is what made the product read as one big menu.
      case 'loadout':
        this._screens && this._screens.enter('character')
        break
      case 'armory':
        this._screens && this._screens.enter('armory')
        break
      case 'fragbench':
        this._screens && this._screens.enter('fragbench')
        break
      case 'issuance':
        this._screens && this._screens.enter('issuance')
        break
      case 'whitepaper':
        this._screens && this._screens.enter('codex')
        break
      case 'roadmap':
        this.openModal('roadmap-modal')
        break
      default:
        break
    }
  }
}
