import GameInstance from './GameInstance';
import nengiConfig from '../common/nengiConfig';
import { ROTATION, MODE_DISPLAY, mapDisplayName, effectiveMode } from '../common/mapRegistry';
import { readRotationIndex, writeRotationIndex } from './rotation';
import http from 'http';

// MAP SELECTION. Explicit MAP env overrides everything (dev/probes pin a map);
// otherwise the persisted rotation index (.rotation-state.json, server/rotation.js)
// picks the map + mode this process plays. One process = one map: at the end of the
// MATCH_END intermission the rotation advances and the process exits 0 (below);
// pm2 (production) / scripts/serve-loop.sh (dev) restart it on the next entry.
const rotationIndex = readRotationIndex()
const rotationEntry = ROTATION[rotationIndex]
const mapOverride = process.env.MAP || null
const gameInstance = mapOverride
    ? new GameInstance(mapOverride, null)                       // env-pinned: mode from MODE env / map record
    : new GameInstance(rotationEntry.mapId, rotationEntry.mode) // rotation-driven

// Rotation restart is armed ONLY for rotation-driven boots (an env-pinned map would
// otherwise exit + reboot onto the SAME map forever — probes want a perpetual
// server). ROTATE=0 is the explicit off-switch for a rotation boot (long soaks).
if (!mapOverride && process.env.ROTATE !== '0') {
    gameInstance.onMatchCycle = () => {
        const next = (rotationIndex + 1) % ROTATION.length
        writeRotationIndex(next)
        console.log(`[rotation] intermission over -> exiting for ${ROTATION[next].mapId} (index ${next})`)
        process.exit(0) // clean exit = "next map, please" to pm2 / serve-loop.sh
    }
}

// MAP HANDSHAKE endpoint: the client asks which map this instance runs before it
// builds the world (clientMain.boot). Plain HTTP on :8078 (MAPINFO_PORT), CORS-open
// (dev hits it cross-origin from vite :8080); production proxies it at /mapinfo.
//
// Response contract (the menu builds against EXACTLY this shape — do not rename):
//   { mapId, mode, mapName, modeName, players, bots, next: { mapId, mapName, modeName } }
// `mode` is the effective mode string ('TDM'|'FFA'); mapName/modeName are display
// strings ('DM-SOMNUS', 'FREE FOR ALL'); players/bots are LIVE counts (humans past
// the nengi handshake / current bot roster) so the menu can show "5 IN ARENA";
// `next` is the rotation entry after this one. `name` stays for legacy consumers.
const MAPINFO_PORT = parseInt(process.env.MAPINFO_PORT || '8078', 10)
// What comes after this match: the entry AFTER the current rotation position. An
// env-pinned map is a rotation PAUSE, so "next" is where the cycle resumes.
const nextEntry = mapOverride ? ROTATION[rotationIndex] : ROTATION[(rotationIndex + 1) % ROTATION.length]
http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    })
    // Mirror the live instance's mode as a string: an explicit MODE env wins (it wins
    // inside GameInstance too), else the rotation entry / the pinned map's record.
    const envMode = (process.env.MODE || '').toUpperCase()
    const mode = envMode === 'FFA' || envMode === 'TDM' ? envMode
        : mapOverride ? effectiveMode(gameInstance.map)
        : rotationEntry.mode
    res.end(JSON.stringify({
        mapId: gameInstance.map.id,
        name: gameInstance.map.name, // legacy field (pre-menu handshake shape)
        mode,
        mapName: mapDisplayName(gameInstance.map),
        modeName: MODE_DISPLAY[mode],
        players: gameInstance._humanCount,
        bots: gameInstance.bots.length,
        next: { mapId: nextEntry.mapId, mapName: nextEntry.mapName, modeName: nextEntry.modeName },
    }))
}).listen(MAPINFO_PORT, () => console.log(`[map] /mapinfo on :${MAPINFO_PORT} -> ${gameInstance.map.id}`))

const hrtimeMs = function() {
    let time = process.hrtime()
    return time[0] * 1000 + time[1] / 1000000
}

let tick = 0
let previous = hrtimeMs()
const tickLengthMs = 1000 / nengiConfig.UPDATE_RATE

const loop = function() {
    const now = hrtimeMs()
    if (previous + tickLengthMs <= now) {
        const delta = (now - previous) / 1000
        previous = now
        tick++

        //let start = hrtimeMs() // uncomment to benchmark
        gameInstance.update(delta, tick, Date.now())
        //let stop = hrtimeMs()
        //console.log('game update took', stop-start, 'ms')
    }

    if (hrtimeMs() - previous < tickLengthMs - 4) {
        setTimeout(loop)
    } else {
        setImmediate(loop)
    }
}

loop()
