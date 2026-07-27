import nengi from 'nengi'
import nengiConfig, { INTERP_DELAY_MS } from '../common/nengiConfig'
import Simulator from './Simulator'
import niceClientExtension from './niceClientExtension'

class GameClient {
	constructor() {
		this.client = new nengi.Client(nengiConfig, INTERP_DELAY_MS)
		this.client.factory = {}
		niceClientExtension(this.client)// API EXTENSION
		this.simulator = new Simulator(this.client)

		this.simulator.setConnectionState('connecting')
		this.client.on('connected', res => {
			console.log('onConnect response:', res)
			this.simulator.setConnectionState('connected')
		})
		this.client.on('disconnected', () => {
			console.log('connection closed')
			this.simulator.setConnectionState('disconnected')
		})
		// over https the game socket is proxied by nginx at /ws; in local dev
		// we talk straight to the game server's port
		const wsUrl = location.protocol === 'https:'
			? `wss://${location.host}/ws`
			: `ws://${location.hostname}:8079`
		// WALLET LINK (read-only). Whatever the player pasted on the menu rides along in
		// the nengi handshake (plain JSON, no protocol/schema change). It is only a hint:
		// the server re-reads the chain itself and derives the grant, so editing this in
		// devtools buys nothing. Nothing is signed and no key is ever handled here.
		const wallet = (() => {
			try { return (localStorage.getItem('degen.wallet') || '').trim() } catch { return '' }
		})()
		this.client.connect(wsUrl, wallet ? { wallet } : undefined)
	}

	update(delta, tick, now) {
		this.client.readNetworkAndEmit()
		this.simulator.update(delta)
		this.client.update()
	}
}

export default GameClient
