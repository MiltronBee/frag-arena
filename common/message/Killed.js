import nengi from 'nengi'

class Killed {
    constructor(killerNid, victimNid, weaponIndex, overkill) {
        // death event for the whole server: kill feed + gib trigger. All nids are
        // SMOOTH nids (the shared canonical identity every client sees). Broadcast
        // to ALL clients via instance.addLocalMessage — safe to reach everyone
        // because the network view deliberately covers the whole arena.
        // overkill is damage beyond what was needed to kill (client uses ~40+ for
        // gibs). killerNid may equal victimNid for unattributed/suicide-style deaths.
        this.killerNid = killerNid
        this.victimNid = victimNid
        this.weaponIndex = weaponIndex
        this.overkill = overkill
    }
}

Killed.protocol = {
    killerNid: nengi.UInt16,
    victimNid: nengi.UInt16,
    weaponIndex: nengi.UInt8,
    overkill: nengi.UInt8
}

export default Killed
