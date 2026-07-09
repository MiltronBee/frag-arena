import nengi from 'nengi'
import nengiConfig from '../common/nengiConfig'
import Simulator from './Simulator'
import niceClientExtension from './niceClientExtension'

class GameClient {
	constructor() {
		this.client = new nengi.Client(nengiConfig, 100)
		this.client.factory = {}
		niceClientExtension(this.client)// API EXTENSION
		this.simulator = new Simulator(this.client)

		this.client.on('connected', res => { console.log('onConnect response:', res) })
		this.client.on('disconnected', () => { console.log('connection closed') })
		// over https the game socket is proxied by nginx at /ws; in local dev
		// we talk straight to the game server's port
		const wsUrl = location.protocol === 'https:'
			? `wss://${location.host}/ws`
			: `ws://${location.hostname}:8079`
		this.client.connect(wsUrl)
	}

	update(delta, tick, now) {
		this.client.readNetworkAndEmit()
		this.simulator.update(delta)
		this.client.update()
	}
}

export default GameClient
