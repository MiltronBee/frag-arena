import nengi from 'nengi'

// Ask to wear a different armour finish. A REQUEST, never an assertion: the server
// re-checks it against what the wallet actually holds (entitlements.resolveFinish), so a
// modified client asking for Solana it does not own simply keeps what it had.
//
// A set is one finish — there is no per-slot field here on purpose. Mixing finishes is
// not a thing the protocol can express, which is the cheapest possible way to enforce it.
class EquipCommand {
	constructor(finishIndex) {
		this.finish = finishIndex | 0
	}
}
EquipCommand.protocol = { finish: nengi.UInt8 }
export default EquipCommand
