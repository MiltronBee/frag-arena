import GameInstance from './GameInstance';
import nengiConfig from '../common/nengiConfig';
import http from 'http';

// MAP env selects this instance's map (any id/name in common/mapRegistry.js);
// unset → registry default. The client learns it via the /mapinfo handshake below.
const gameInstance = new GameInstance(process.env.MAP || null)

// MAP HANDSHAKE endpoint: the client asks which map this instance runs before it
// builds the world (clientMain.boot). Plain HTTP on :8078 (MAPINFO_PORT), CORS-open
// (dev hits it cross-origin from vite :8080); production proxies it at /mapinfo.
const MAPINFO_PORT = parseInt(process.env.MAPINFO_PORT || '8078', 10)
http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({
        mapId: gameInstance.map.id,
        name: gameInstance.map.name,
        mode: gameInstance.gameMode,
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
