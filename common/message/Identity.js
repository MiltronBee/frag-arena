import nengi from 'nengi'

class Identity {
    constructor(rawId, smoothId, x, y, z, yaw) {
        this.rawId = rawId
        this.smoothId = smoothId
        // spawn position: the client predicts its own movement and permanently
        // ignores server x/y/z for its own entity, so the spawn point must be
        // handed over explicitly (players no longer all spawn at the origin)
        //
        // y is carried for the same reason Respawned carries it (mesh maps have no
        // y=0 floor). NOTE: unlike Respawned, the INITIAL spawn was never actually
        // broken — niceClientExtension's create handler does Object.assign(entity,
        // data) from the create-snapshot, and that snapshot DOES carry y, so the
        // entity already lands on the right floor; createPlayerFactory then
        // overwrites only x and z from this message, leaving the good y alone.
        // Sending y here just removes the split-brain (x/z from this message, y from
        // the snapshot) so the two sources can't drift. createPlayerFactory.js still
        // only consumes x/z — wiring `entity.y = simulator.spawnPos.y` there is a
        // safe no-op today and would make the handoff fully explicit.
        this.x = x
        this.y = y
        this.z = z
        // spawn FACING: world yaw (radians, camera.rotation.y convention) the client
        // snaps to on this initial spawn — the UT PlayerStart's rotation, networked so
        // players no longer keep their pre-deploy facing (they never rotated on spawn).
        // TELEPORT_KEEP_YAW (-999, the shared keep-facing sentinel — see Teleported.js)
        // means the spawn had no authored rotation; the client leaves the current view.
        // A real yaw is a radian in (-π, π], so the sentinel can never collide with one.
        this.yaw = yaw
    }
}

Identity.protocol = {
    rawId: nengi.UInt16,
    smoothId: nengi.UInt16,
    x: nengi.Float32,
    y: nengi.Float32,
    z: nengi.Float32,
    yaw: nengi.Float32
}

export default Identity
