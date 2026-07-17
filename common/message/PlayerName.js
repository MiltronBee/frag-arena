import nengi from 'nengi'
import { encodeName } from '../playerNames'

class PlayerName {
    constructor(smoothNid, name) {
        this.smoothNid = smoothNid
        encodeName(this, name)
    }
}
PlayerName.protocol = {
    smoothNid: nengi.UInt16,
    c0: nengi.UInt8, c1: nengi.UInt8, c2: nengi.UInt8, c3: nengi.UInt8,
    c4: nengi.UInt8, c5: nengi.UInt8, c6: nengi.UInt8, c7: nengi.UInt8,
    c8: nengi.UInt8, c9: nengi.UInt8, c10: nengi.UInt8, c11: nengi.UInt8
}
export default PlayerName
