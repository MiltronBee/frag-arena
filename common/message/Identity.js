import nengi from 'nengi'

class Identity {
    constructor(rawId, smoothId, x, z) {
        this.rawId = rawId
        this.smoothId = smoothId
        // spawn position: the client predicts its own movement and permanently
        // ignores server x/y/z for its own entity, so the spawn point must be
        // handed over explicitly (players no longer all spawn at the origin)
        this.x = x
        this.z = z
    }
}

Identity.protocol = {
    rawId: nengi.UInt16,
    smoothId: nengi.UInt16,
    x: nengi.Float32,
    z: nengi.Float32
}

export default Identity
