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
