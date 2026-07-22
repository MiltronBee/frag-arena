import nengi from 'nengi'
import PlayerCharacter from './entity/PlayerCharacter'
import Identity from './message/Identity'
import WeaponFired from './message/WeaponFired'
import Respawned from './message/Respawned'
import Teleported from './message/Teleported'
import HitConfirmed from './message/HitConfirmed'
import Killed from './message/Killed'
import DamageTaken from './message/DamageTaken'
import PlayerName from './message/PlayerName'
import MoveCommand from './command/MoveCommand'
import DeployCommand from './command/DeployCommand'
import SpectatorHeartbeatCommand from './command/SpectatorHeartbeatCommand'
import SetNameCommand from './command/SetNameCommand'
import FireCommand from './command/FireCommand'
import SwitchWeaponCommand from './command/SwitchWeaponCommand'
import DevUpdateWeaponConfigCommand from './command/DevUpdateWeaponConfigCommand'
import Obstacle from './entity/Obstacle'
import Projectile from './entity/Projectile'
import Grenade from './entity/Grenade'
import MegaHealthPickup from './entity/MegaHealthPickup'
import Pickup from './entity/Pickup'
import MatchState from './entity/MatchState'

const config = {
    UPDATE_RATE: 40, // raised 20->40 (2026-07-16): halves per-tick dodge jump (0.57m->0.285m)
                     // for target trackability. MAX_DELTA in applyCommand derives from this.

    ID_BINARY_TYPE: nengi.UInt16,
    TYPE_BINARY_TYPE: nengi.UInt8, 

    ID_PROPERTY_NAME: 'nid',
    TYPE_PROPERTY_NAME: 'ntype', 

    USE_HISTORIAN: true,
    // 80 ticks @ 40Hz = 2000ms lag-comp rewind window — PRESERVES the old window
    // (was 40 @ 20Hz = 2000ms). Sized in TICKS, so it MUST scale with UPDATE_RATE
    // or the rewind window in ms silently shrinks and high-ping shots stop
    // registering. 2000ms comfortably covers latency + 100ms interp + margin.
    HISTORIAN_TICKS: 80,

    DIMENSIONALITY: 3,

    protocols: {
        entities: [
            ['PlayerCharacter', PlayerCharacter],
            ['Obstacle', Obstacle],
            ['Projectile', Projectile],
            ['Grenade', Grenade],
            ['MegaHealthPickup', MegaHealthPickup],
            ['Pickup', Pickup],
            ['MatchState', MatchState]
        ],
        localMessages: [],
        messages: [
            ['Identity', Identity],
            ['WeaponFired', WeaponFired],
            ['Respawned', Respawned],
            ['Teleported', Teleported],
            ['HitConfirmed', HitConfirmed],
            ['Killed', Killed],
            ['DamageTaken', DamageTaken],
            ['PlayerName', PlayerName]
        ],
        commands: [
            ['MoveCommand', MoveCommand],
            ['DeployCommand', DeployCommand],
            ['SpectatorHeartbeatCommand', SpectatorHeartbeatCommand],
            ['FireCommand', FireCommand],
            ['SwitchWeaponCommand', SwitchWeaponCommand],
            ['DevUpdateWeaponConfigCommand', DevUpdateWeaponConfigCommand],
            ['SetNameCommand', SetNameCommand]
        ],
        basics: []
    }
}

export default config