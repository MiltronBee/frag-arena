import nengi from 'nengi'

class WeaponFired {
    constructor(sourceId, x, y, z, tx, ty, tz, weaponIndex, seed, heat) {
        this.sourceId = sourceId
        this.x = x
		this.y = y
		this.z = z
        this.tx = tx
		this.ty = ty
		this.tz = tz
		// weapon identity + the shot's deterministic spread inputs, so observers
		// render the SAME pellet pattern (and per-weapon FX/report) the server
		// used for damage — not a generic guess (common/firePattern.js)
		this.weaponIndex = weaponIndex || 0
		this.seed = seed || 0
		this.heat = heat || 0
    }
}

WeaponFired.protocol = {
    sourceId: nengi.UInt16,
    x: nengi.Float32,
	y: nengi.Float32,
	z: nengi.Float32,
    tx: nengi.Float32,
	ty: nengi.Float32,
	tz: nengi.Float32,
	weaponIndex: nengi.UInt8,
	seed: nengi.UInt32,
	heat: nengi.Float32
}

export default WeaponFired
