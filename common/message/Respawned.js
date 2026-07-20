import nengi from 'nengi'

class Respawned {
    constructor(x, y, z) {
        // respawn teleport: the client predicts its own movement and permanently
        // ignores server x/y/z for its own entity (see Identity), so a respawn's
        // new spawn point must be handed over explicitly, exactly like the
        // initial spawn. Sent only to the respawning client.
        //
        // y IS PART OF THE WIRE. It used to be omitted because the box arena's floor
        // was the plane y=0, so the client could just assume 0 — and it did, literally
        // (`this.myRawEntity.y = 0`). On a mesh map the floor is wherever the artist
        // put it (CTF-Visage's deck is world y ~-25), so a y-less respawn dropped the
        // player ~24m through the air on EVERY death: for the ~1.6s fall their
        // predicted position — and the origin of every shot and muzzle FX — was up to
        // 24m from where the server had them, and at spawns under geometry the y=0
        // start could land the capsule inside a column.
        this.x = x
        this.y = y
        this.z = z
    }
}

Respawned.protocol = {
    x: nengi.Float32,
    y: nengi.Float32,
    z: nengi.Float32
}

export default Respawned
