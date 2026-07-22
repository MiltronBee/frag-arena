import nengi from 'nengi'

// TELEPORT_KEEP_YAW: sentinel yaw meaning "keep your current facing" (the UT
// destination actor had no yaw). A real yaw is a world radian in (-π, π], so
// -999 can never collide with one.
export const TELEPORT_KEEP_YAW = -999

class Teleported {
    constructor(x, y, z, yaw, velX, velY, velZ) {
        // portal teleport for the client's OWN predicted entity: like Respawned,
        // the client permanently ignores server x/y/z snapshots for itself (see
        // Identity / shouldIgnore), so the only way the server can move it is
        // this explicit handover. Sent only to the teleported client (bots have
        // no socket — the server-side move IS their teleport).
        //
        // Unlike Respawned this carries VELOCITY: a teleport preserves the
        // horizontal speed magnitude redirected along the exit facing (UT99
        // behaviour), so the client must snap its predicted velocity too or its
        // next predicted ticks drift from the server's.
        this.x = x
        this.y = y
        this.z = z
        // world yaw (radians, camera.rotation.y convention) to face on arrival,
        // or TELEPORT_KEEP_YAW when the destination has no facing.
        this.yaw = yaw
        this.velX = velX
        this.velY = velY
        this.velZ = velZ
    }
}

Teleported.protocol = {
    x: nengi.Float32,
    y: nengi.Float32,
    z: nengi.Float32,
    yaw: nengi.Float32,
    velX: nengi.Float32,
    velY: nengi.Float32,
    velZ: nengi.Float32
}

export default Teleported
