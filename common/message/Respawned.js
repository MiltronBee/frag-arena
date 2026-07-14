import nengi from 'nengi'

class Respawned {
    constructor(x, z) {
        // respawn teleport: the client predicts its own movement and permanently
        // ignores server x/y/z for its own entity (see Identity), so a respawn's
        // new spawn point must be handed over explicitly, exactly like the
        // initial spawn. Sent only to the respawning client.
        this.x = x
        this.z = z
    }
}

Respawned.protocol = {
    x: nengi.Float32,
    z: nengi.Float32
}

export default Respawned
