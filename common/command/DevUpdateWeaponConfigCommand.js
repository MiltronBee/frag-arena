import nengi from 'nengi'

class DevUpdateWeaponConfigCommand {
	constructor(props) {
		Object.assign(this, props)
	}
}

DevUpdateWeaponConfigCommand.protocol = {
	index: nengi.UInt8,
	type: nengi.UInt8, // 0 = hitscan, 1 = projectile
	fireCooldown: nengi.Float32,
	reloadTime: nengi.Float32,
	magazineCapacity: nengi.UInt16,
	maxReserveAmmo: nengi.UInt16,
	damage: nengi.Float32,
	range: nengi.Float32,
	projectileSpeed: nengi.Float32
}

export default DevUpdateWeaponConfigCommand
