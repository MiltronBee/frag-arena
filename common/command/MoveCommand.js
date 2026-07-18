import nengi from 'nengi'

class MoveCommand {
    constructor(props) {
		// lazy shorthand, see the protocol below to know what the props are
		Object.assign(this, props)
    }
}

MoveCommand.protocol = {
    forwards: nengi.Boolean,
    left: nengi.Boolean,
    backwards: nengi.Boolean,
	right: nengi.Boolean,
	jump: nengi.Boolean,
	dodge: nengi.UInt8, // 0 = none, else a DODGE_DIRS code (see applyCommand)
	camRayX: nengi.Float32,
	camRayY: nengi.Float32,
	camRayZ: nengi.Float32,
	weaponIndex: nengi.UInt8,
	reload: nengi.Boolean,
	fireInput: nengi.Boolean,
	throwInput: nengi.Boolean, // Phase 3: rising-edge frag-grenade throw (edge-triggered client-side)
	aimInput: nengi.Boolean, // ADS held (RMB/touch). Ramps entity.aimFactor in applyCommand → drives ADS accuracy (weapon.fire/firePattern). Networked so the server validates hits with the same spread the client predicted.
    delta: nengi.Float32
}

export default MoveCommand
