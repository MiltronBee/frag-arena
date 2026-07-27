// IN-MATCH CHAT — Enter opens, Alt toggles TEAM/ALL, Enter sends, Esc cancels.
//
// The hard part is not the messages, it is that this game holds POINTER LOCK and reads
// raw keydown for movement and firing. Typing "wasd" into a chat box must not walk you
// into a wall, and pressing Enter must not deploy. So opening chat:
//   - exits pointer lock (the browser will not deliver text input while it is held)
//   - sets a flag the input layer checks, so movement/fire ignore keys while typing
//   - stops propagation on its own keydowns so nothing behind it ever sees them
//
// Lines are rendered with textContent, never innerHTML — the server sanitizes, but the
// client must not be the thing that makes markup executable if that ever regresses.
import ChatCommand from '../../common/command/ChatCommand'
import { CHAT_SCOPE, CHAT_MAX_LEN, CHAT_SOURCE, CHAT_SOURCE_LABEL, sanitizeChat } from '../../common/chat'

const FADE_AFTER_MS = 12000 // lines dim once the conversation moves on
const MAX_LINES = 60

export default class ChatControls {
	constructor(simulator) {
		this._sim = simulator
		this.open = false
		this.scope = CHAT_SCOPE.ALL
		this._log = document.getElementById('chat-log')
		this._bar = document.getElementById('chat-bar')
		this._input = document.getElementById('chat-input')
		this._scopeEl = document.getElementById('chat-scope')
		if (!this._log || !this._bar || !this._input) return

		this._input.maxLength = CHAT_MAX_LEN
		this._onKeyDown = this._onKeyDown.bind(this)
		// CAPTURE phase: the movement/fire handlers are bound on window/document too, and
		// this has to win before they see the key, not after.
		window.addEventListener('keydown', this._onKeyDown, true)
	}

	// Movement/fire code asks this before consuming a key.
	get typing() { return this.open }

	_onKeyDown(e) {
		if (!this._input) return

		if (!this.open) {
			// Only open on a bare Enter, and only in a match — Enter in the menu is the
			// deploy affordance and must keep working.
			if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
			if (e.ctrlKey || e.altKey || e.metaKey) return
			if (!this._inMatch()) return
			const tag = document.activeElement && document.activeElement.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA') return // callsign field etc
			e.preventDefault(); e.stopPropagation()
			this.show()
			return
		}

		// ---- open: this layer owns the keyboard ----
		if (e.code === 'Escape') {
			e.preventDefault(); e.stopPropagation()
			this.hide()
			return
		}
		if (e.code === 'AltLeft' || e.code === 'AltRight') {
			// Alt alone toggles scope. preventDefault stops the browser stealing it for
			// the menu bar on Windows/Linux, which would blur the input mid-sentence.
			e.preventDefault(); e.stopPropagation()
			this.setScope(this.scope === CHAT_SCOPE.TEAM ? CHAT_SCOPE.ALL : CHAT_SCOPE.TEAM)
			return
		}
		if (e.code === 'Enter' || e.code === 'NumpadEnter') {
			e.preventDefault(); e.stopPropagation()
			this.send()
			return
		}
		// Everything else is text. Swallow it so movement/fire never sees a keystroke
		// that was meant for the sentence being typed.
		e.stopPropagation()
	}

	_inMatch() {
		const s = this._sim
		return !!(s && s.client && s.myEntity)
	}

	setScope(scope) {
		// TEAM is meaningless in FFA; the server would coerce it anyway, so do not offer a
		// state the game will silently ignore.
		if (scope === CHAT_SCOPE.TEAM && !this._teamsEnabled()) scope = CHAT_SCOPE.ALL
		this.scope = scope
		if (this._scopeEl) {
			const team = scope === CHAT_SCOPE.TEAM
			this._scopeEl.textContent = team ? 'TEAM' : 'ALL'
			this._scopeEl.setAttribute('data-scope', team ? 'team' : 'all')
		}
	}

	_teamsEnabled() {
		const s = this._sim
		return !!(s && s.teamsEnabled !== false && s.gameMode !== 'FFA')
	}

	show() {
		this.open = true
		this._bar.classList.remove('chat-hidden')
		this.setScope(this.scope)
		// Pointer lock and text entry are mutually exclusive — the browser delivers no
		// printable keys while locked, so the box would silently eat everything typed.
		try { if (document.pointerLockElement) document.exitPointerLock() } catch (err) {}
		this._input.value = ''
		this._input.focus()
	}

	hide() {
		this.open = false
		this._bar.classList.add('chat-hidden')
		this._input.value = ''
		this._input.blur()
	}

	send() {
		const text = sanitizeChat(this._input.value)
		this.hide()
		if (!text) return
		const s = this._sim
		if (s && s.client) s.client.addCommand(new ChatCommand(text, this.scope))
	}

	// Called from the ChatMessage handler. `name` is resolved by the caller from the
	// same registry the nametags use, so chat and nametags can never disagree.
	addLine(name, text, scope, source) {
		if (!this._log) return
		const bridged = (source | 0) !== CHAT_SOURCE.PLAYER
		const li = document.createElement('div')
		li.className = 'chat-line'
		li.setAttribute('data-scope', scope === CHAT_SCOPE.TEAM ? 'team' : 'all')
		if (bridged) li.setAttribute('data-source', CHAT_SOURCE_LABEL[source] || 'EXT')
		if (scope === CHAT_SCOPE.TEAM && !bridged) {
			const tag = document.createElement('span')
			tag.className = 'chat-tag'
			tag.textContent = '[TEAM]'
			li.appendChild(tag)
		}
		if (bridged) {
			// A bridged line has no entity behind it, so there is no callsign to resolve —
			// it arrives already formatted as "user: text". Tagging the SOURCE is what
			// stops someone in a Telegram group being mistaken for a player in the arena.
			const tag = document.createElement('span')
			tag.className = 'chat-tag chat-src'
			tag.textContent = '[' + (CHAT_SOURCE_LABEL[source] || 'EXT') + ']'
			li.appendChild(tag)
			const what = document.createElement('span')
			what.className = 'chat-text'
			what.textContent = text
			li.appendChild(what)
			this._log.appendChild(li)
			this._trim(li)
			return
		}
		const who = document.createElement('span')
		who.className = 'chat-who'
		who.textContent = (name || 'PLAYER') + ':'
		const what = document.createElement('span')
		what.className = 'chat-text'
		what.textContent = text // textContent, never innerHTML
		li.appendChild(who); li.appendChild(what)
		this._log.appendChild(li)
		this._trim(li)
	}

	_trim(li) {
		while (this._log.childElementCount > MAX_LINES) this._log.removeChild(this._log.firstElementChild)
		this._log.scrollTop = this._log.scrollHeight
		// Dim rather than remove: a player glancing back should still see that something
		// was said, without chat permanently occluding the arena.
		setTimeout(() => li.classList.add('chat-stale'), FADE_AFTER_MS)
	}

	dispose() {
		window.removeEventListener('keydown', this._onKeyDown, true)
	}
}
