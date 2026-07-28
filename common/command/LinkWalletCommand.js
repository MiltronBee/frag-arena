import nengi from 'nengi'
import { encodeWallet, walletProtocol } from '../walletAddress'

// Link (or unlink) a wallet WITHOUT reconnecting. A REQUEST, never an assertion: the
// server re-reads the chain from the address itself and derives the grant, exactly as the
// handshake path does, so editing this in devtools buys nothing but a lookup of somebody
// else's holdings.
//
// The handshake carries the address too, and still should — a returning player with a
// saved address gets their ~25s mainnet read started at connect rather than at the moment
// they open the menu. This command is for the case the handshake structurally cannot
// serve: linking for the FIRST time, or changing wallets, mid-session.
//
// An EMPTY address is a valid, meaningful payload: it means unlink, and the server drops
// the grant. Sending nothing at all would leave a player who cleared the field still
// holding weapons they had just disowned.
class LinkWalletCommand {
	constructor(address) {
		encodeWallet(this, address)
	}
}
LinkWalletCommand.protocol = walletProtocol(nengi)
export default LinkWalletCommand
