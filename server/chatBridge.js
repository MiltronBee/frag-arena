// EXTERNAL CHAT BRIDGE — Telegram and pump.fun livechat, piped INTO the arena chat.
//
// Ported from the Tokidoki rig (~/pumpfunchat/stream/server.js), which does the same two
// reads for its stream dashboard. Two things carried over deliberately:
//
//   1. TOKENS LIVE ONLY HERE. Tokidoki's architecture rule is that anything able to spend
//      a key or move money stays in the private half, and the public half only ever reads
//      published state. The same rule applies: TELEGRAM_TOKEN is read from the game
//      server's environment and never reaches a client. Bridged lines go out as ordinary
//      ChatMessages carrying text and nothing else.
//   2. ONE-WAY, INBOUND ONLY. Nothing in the arena relays back out. Relaying out would
//      mean a path from "any player can type" to "the bot posts", which is a spam and
//      abuse vector with a token behind it. Read-only is the whole safety argument.
//
// Both feeds are optional and independent — unset the env var and that half stays dark,
// with the game entirely unaffected. Neither is on the critical path: a dead Telegram API
// or a pump.fun outage costs log noise and nothing else.
import { sanitizeChat } from '../common/chat.js'

const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM || ''
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID) : null
const PUMP_CA = process.env.PUMP_CA || process.env.CA || ''
const LIVECHAT = process.env.PUMP_LIVECHAT || 'https://livechat.pump.fun'

// A bridged line is "user: text" in one 96-char slot, so the username gets a hard cap and
// the message takes the rest. Long enough for a name, short enough to leave room to say
// something.
const NAME_MAX = 16

// Bridged chat competes with the match for the player's attention, and an external room
// can be far busier than an arena. Rate-limit per source so a lively Telegram group
// cannot bury the kill feed.
const RATE_MAX = 5
const RATE_DECAY_MS = 4000

function formatLine(user, text) {
  const u = sanitizeChat(user).slice(0, NAME_MAX) || 'anon'
  const t = sanitizeChat(text)
  if (!t) return null
  return `${u}: ${t}`
}

export default class ChatBridge {
  // `emit(text, source)` is called for each accepted line. The caller owns delivery, so
  // this module never touches nengi and can be tested on its own.
  constructor(emit) {
    this.emit = emit
    this._stopped = false
    this._buckets = new Map() // source -> { n, at }
  }

  // Leaky bucket per source, same shape as the per-client chat limit in GameInstance.
  _allow(source) {
    const now = Date.now()
    const b = this._buckets.get(source) || { n: 0, at: now }
    b.n = b.n * Math.pow(0.5, (now - b.at) / RATE_DECAY_MS)
    b.at = now
    if (b.n > RATE_MAX) { this._buckets.set(source, b); return false }
    b.n += 1
    this._buckets.set(source, b)
    return true
  }

  _push(user, text, source) {
    const line = formatLine(user, text)
    if (!line) return
    if (!this._allow(source)) return
    try { this.emit(line, source) } catch (e) { /* delivery is the caller's problem */ }
  }

  start(sources) {
    if (TG_TOKEN) this._startTelegram(sources.TELEGRAM)
    else console.log('[chat-bridge] no TELEGRAM_TOKEN — telegram feed off')
    if (PUMP_CA) this._startPump(sources.PUMP)
    else console.log('[chat-bridge] no PUMP_CA — pump.fun feed off')
  }

  // getUpdates long-poll with offset tracking, exactly as the Tokidoki rig does it. The
  // 25s server-side timeout means this is one idle connection, not a busy loop.
  _startTelegram(source) {
    let offset = 0
    const poll = async () => {
      if (this._stopped) return
      try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${offset}`)
        const j = await r.json()
        for (const u of j.result || []) {
          offset = u.update_id + 1
          const m = u.message || u.channel_post
          if (!m || !m.text) continue
          // TELEGRAM_CHAT_ID restricts the bridge to one group. Without it the bot would
          // relay every chat it has been added to straight into the arena.
          if (TG_CHAT_ID && String(m.chat && m.chat.id) !== TG_CHAT_ID) continue
          const user = m.from ? (m.from.username || m.from.first_name || 'tg') : (m.chat && m.chat.title) || 'tg'
          this._push(user, m.text, source)
        }
      } catch (e) { /* transient — keep polling */ }
      setTimeout(poll, 500)
    }
    console.log(`[chat-bridge] telegram: polling getUpdates${TG_CHAT_ID ? ` (chat ${TG_CHAT_ID})` : ' (ALL chats — set TELEGRAM_CHAT_ID)'}`)
    poll()
  }

  // pump.fun livechat is socket.io. socket.io-client is NOT a dependency of the game
  // server and adding one to the match process for a cosmetic feed is a poor trade, so
  // the client is imported lazily: if it is absent the feed simply stays off and the game
  // is untouched. `npm i socket.io-client` turns it on.
  async _startPump(source) {
    let clientIO
    try {
      ({ io: clientIO } = await import('socket.io-client'))
    } catch (e) {
      console.log('[chat-bridge] pump.fun: socket.io-client not installed — feed off (npm i socket.io-client)')
      return
    }
    const up = clientIO(LIVECHAT, { transports: ['websocket'] })
    up.on('connect', () => {
      console.log(`[chat-bridge] pump.fun: joined room ${PUMP_CA.slice(0, 8)}…`)
      up.emit('joinRoom', { roomId: PUMP_CA, username: '' })
    })
    up.on('connect_error', () => { /* pump.fun down — the arena does not care */ })
    up.onAny((event, ...args) => {
      if (event !== 'newMessage') return
      const a = args[0] || {}
      this._push(a.username || a.userAddress || 'pump', a.message, source)
    })
    this._pumpSocket = up
  }

  stop() {
    this._stopped = true
    if (this._pumpSocket) { try { this._pumpSocket.close() } catch (e) {} this._pumpSocket = null }
  }
}
