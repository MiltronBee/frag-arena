import nengi from 'nengi'
import { encodeChat, chatTextProtocol } from '../chat'

// Client -> server chat. The server RE-SANITIZES and re-decides scope on receipt; this
// carries intent, never authority (a hand-crafted packet can claim any scope it likes).
class ChatCommand {
	constructor(text, scope) {
		this.scope = scope | 0
		encodeChat(this, text)
	}
}
ChatCommand.protocol = {
	scope: nengi.UInt8,
	...chatTextProtocol(nengi),
}
export default ChatCommand
