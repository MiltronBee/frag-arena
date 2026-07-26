// Minimal boot diagnostic: load the client, dump console + page errors and the gate
// flags, so a failed probe can be told apart from a broken client.
import puppeteer from 'puppeteer-core'
const PORT = process.env.PROBE_VITE_PORT || '8080'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome', headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,720'],
})
const page = await browser.newPage()
const logs = []
page.on('console', m => logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`))
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 400)}`))
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url().slice(0, 160)} ${r.failure()?.errorText}`))
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
await sleep(25000)
const state = await page.evaluate(`(() => {
  const s = window.gameClient && window.gameClient.simulator
  const btn = document.getElementById('enter-arena')
  return {
    hasGameClient: !!window.gameClient,
    hasSim: !!s,
    conn: s ? s._connectionState : null,
    arenaReady: s ? !!s._arenaReady : null,
    assetsReady: s ? !!s._assetsReady : null,
    assetStage: s ? s._assetStage : null,
    btnExists: !!btn,
    btnDisabled: btn ? btn.disabled : null,
    splashVisible: (() => { const e = document.getElementById('splash'); return e ? getComputedStyle(e).display !== 'none' : null })(),
    body: document.body.className,
  }
})()`)
console.log(JSON.stringify(state, null, 1))
console.log('--- logs ---')
console.log(logs.slice(0, 40).join('\n'))
await browser.close()
