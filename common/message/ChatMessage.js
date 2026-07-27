import nengi from 'nengi'
import { encodeChat, chatTextProtocol } from '../chat'

// Server -> client chat, delivered per-client (messageAll / message) rather than as a
// local event: nengi local events are spatially culled and would silently drop chat from
// anyone across the map, which is the opposite of what chat is for.
//
// `smoothNid` identifies the speaker so the client can resolve their callsign from the
// name registry it already keeps for nametags — the name is NOT re-sent per line.
class ChatMessage {
	constructor(smoothNid, text, scope, source) {
		this.smoothNid = smoothNid
		this.scope = scope | 0
		// 0 = a player in the arena; anything else is a bridged line (Telegram, pump.fun)
		// that has no entity and carries its own "user: text".
		this.source = source | 0
		encodeChat(this, text)
	}
}
ChatMessage.protocol = {
	smoothNid: nengi.UInt16,
	scope: nengi.UInt8,
	source: nengi.UInt8,
	...chatTextProtocol(nengi),
}
export default ChatMessage
