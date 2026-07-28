import nengi from 'nengi'

// Server -> one client: "your wallet read landed, and THIS is what it granted you."
//
// The menu already does its own /wallet HTTP lookup to paint the holdings list, but that
// only proves the chain agrees — it says nothing about whether the game server applied a
// grant, which is the thing the player actually cares about and the thing that was
// silently broken. The panel used to promise "unlocks apply on next join" on the strength
// of the HTTP read alone, while the game had never been told the address at all.
//
// `weaponMask` is the same bitmask as PlayerCharacter.ownedWeapons, so the client can name
// the exact weapons rather than a count. A mask of 0 with count > 0 is a real and
// legible state: you hold armour but no weapon NFT.
class WalletLinked {
	constructor(count, weaponMask) {
		this.count = count | 0
		this.weaponMask = weaponMask | 0
	}
}
WalletLinked.protocol = {
	count: nengi.UInt16,
	weaponMask: nengi.UInt32,
}
export default WalletLinked
