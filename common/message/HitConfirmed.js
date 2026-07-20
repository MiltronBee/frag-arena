import nengi from 'nengi'

class HitConfirmed {
    constructor(victimNid, damage, wasKill, isHeadshot = false) {
        // attacker-only feedback: confirms a shot connected so the shooter can
        // flash a hitmarker (and a kill-marker when wasKill). victimNid is the
        // victim's SMOOTH nid — the shared canonical identity every client agrees
        // on (Identity teaches each client its own raw+smooth pair). Sent ONLY to
        // the attacker's client via instance.message().
        this.victimNid = victimNid
        this.damage = damage
        this.wasKill = wasKill
        // Body-zone feedback: true when this hit was a HEAD hit (server-classified
        // by the lag-comp pose model). Drives the distinct headshot hitmarker +
        // "Headshot!" announcer on the attacker's client. AUTHORITATIVE-only — the
        // client never predicts a headshot; it comes solely from this message.
        this.isHeadshot = isHeadshot
    }
}

HitConfirmed.protocol = {
    victimNid: nengi.UInt16,
    damage: nengi.UInt8,
    wasKill: nengi.Boolean,
    isHeadshot: nengi.Boolean
}

export default HitConfirmed
