import nengi from 'nengi'

class HitConfirmed {
    constructor(victimNid, damage, wasKill) {
        // attacker-only feedback: confirms a shot connected so the shooter can
        // flash a hitmarker (and a kill-marker when wasKill). victimNid is the
        // victim's SMOOTH nid — the shared canonical identity every client agrees
        // on (Identity teaches each client its own raw+smooth pair). Sent ONLY to
        // the attacker's client via instance.message().
        this.victimNid = victimNid
        this.damage = damage
        this.wasKill = wasKill
    }
}

HitConfirmed.protocol = {
    victimNid: nengi.UInt16,
    damage: nengi.UInt8,
    wasKill: nengi.Boolean
}

export default HitConfirmed
