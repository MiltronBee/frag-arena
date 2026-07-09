import nengi from 'nengi'

class SwitchWeaponCommand {
	constructor(index) {
		this.index = index
	}
}

SwitchWeaponCommand.protocol = {
	index: nengi.UInt8
}

export default SwitchWeaponCommand
