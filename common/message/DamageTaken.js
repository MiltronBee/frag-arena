import nengi from 'nengi'

class DamageTaken {
    constructor(attackerNid, damage, directionYaw) {
        // victim-only feedback: drives the directional damage arc / screen flash.
        // attackerNid is the attacker's SMOOTH nid (shared canonical identity).
        // directionYaw is the world yaw from the victim toward the attacker,
        // Math.atan2(dx, dz), so the client can point the arc at the shooter.
        // Sent ONLY to the victim's client via instance.message().
        this.attackerNid = attackerNid
        this.damage = damage
        this.directionYaw = directionYaw
    }
}

DamageTaken.protocol = {
    attackerNid: nengi.UInt16,
    damage: nengi.UInt8,
    directionYaw: nengi.Float32
}

export default DamageTaken
