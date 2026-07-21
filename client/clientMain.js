import GameClient from './GameClient';
import AnimPlayground from './playground/AnimPlayground';

// Boots the real multiplayer game by default. Append ?playground to the URL to
// run the client-only anim clip inspector (client/playground/AnimPlayground.js).
window.onload = function() {
    const params = new URLSearchParams(location.search)
    if (params.has('playground')) {
        console.log('window loaded (playground)')
        const pg = new AnimPlayground()
        window.playground = pg // dev hook
        return
    }

    console.log('window loaded')
    boot()
}

// MAP HANDSHAKE: ask the game server which map this instance runs BEFORE the world
// is built (Simulator/renderer/prediction all pin the map record at construction, so
// it cannot change after boot). Over https the endpoint is nginx-proxied at
// /mapinfo; in dev we hit the game server's info port directly. Any failure →
// default map (identical to pre-handshake behavior).
async function boot() {
    let mapId = null
    try {
        const url = location.protocol === 'https:'
            ? `https://${location.host}/mapinfo`
            : `http://${location.hostname}:8078/mapinfo`
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 2500)
        const res = await fetch(url, { signal: ctl.signal })
        clearTimeout(t)
        if (res.ok) mapId = (await res.json()).mapId || null
    } catch { /* server predates the endpoint or is unreachable — use default */ }
    if (mapId) window.__SERVER_MAP_ID__ = mapId
    console.log('[map] handshake:', mapId || '(default)')

    const gameClient = new GameClient()
    // dev/testing hook: lets headless harnesses & the console inspect/drive the client
    window.gameClient = gameClient
    let tick = 0
    let previous = performance.now()
    const loop = function() {
        window.requestAnimationFrame(loop)
        const now = performance.now()
        const delta = (now - previous) / 1000
        previous = now
        tick++

        gameClient.update(delta, tick, now)
    }

    loop()
}
