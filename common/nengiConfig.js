import nengi from 'nengi'
import PlayerCharacter from './entity/PlayerCharacter'
import Identity from './message/Identity'
import WeaponFired from './message/WeaponFired'
import Respawned from './message/Respawned'
import HitConfirmed from './message/HitConfirmed'
import Killed from './message/Killed'
import DamageTaken from './message/DamageTaken'
import MoveCommand from './command/MoveCommand'
import FireCommand from './command/FireCommand'
import SwitchWeaponCommand from './command/SwitchWeaponCommand'
import DevUpdateWeaponConfigCommand from './command/DevUpdateWeaponConfigCommand'
import Obstacle from './entity/Obstacle'
import Projectile from './entity/Projectile'

const config = {
    UPDATE_RATE: 20, 

    ID_BINARY_TYPE: nengi.UInt16,
    TYPE_BINARY_TYPE: nengi.UInt8, 

    ID_PROPERTY_NAME: 'nid',
    TYPE_PROPERTY_NAME: 'ntype', 

    USE_HISTORIAN: true,
    HISTORIAN_TICKS: 40,

    DIMENSIONALITY: 3,

    protocols: {
        entities: [
            ['PlayerCharacter', PlayerCharacter],
            ['Obstacle', Obstacle],
            ['Projectile', Projectile]
        ],
        localMessages: [],
        messages: [
            ['Identity', Identity],
            ['WeaponFired', WeaponFired],
            ['Respawned', Respawned],
            ['HitConfirmed', HitConfirmed],
            ['Killed', Killed],
            ['DamageTaken', DamageTaken]
        ],
        commands: [
            ['MoveCommand', MoveCommand],
            ['FireCommand', FireCommand],
            ['SwitchWeaponCommand', SwitchWeaponCommand],
            ['DevUpdateWeaponConfigCommand', DevUpdateWeaponConfigCommand]
        ],
        basics: []
    }
}

export default config