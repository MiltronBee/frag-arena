import puppeteer from 'puppeteer-core'
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
const p = await b.newPage()
await p.setViewport({ width: 1280, height: 800 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))
await p.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 1500))
await p.keyboard.press('Enter') // dismiss splash
await p.waitForFunction(() => {
  const s = document.getElementById('entry-status'); return s && s.textContent === 'READY'
}, { timeout: 60000 })
await new Promise((r) => setTimeout(r, 900))

// 1) SETTINGS from the main menu: card must open, no arena warp
await p.click('[data-action="settings"]')
await new Promise((r) => setTimeout(r, 600))
console.log('menu-settings:', await p.evaluate(() => JSON.stringify({
  body: document.body.className,
  card: document.getElementById('settings-menu').className,
  kicker: document.getElementById('settings-kicker').textContent,
  lock: !!document.pointerLockElement,
})))
await p.screenshot({ path: '/tmp/probe-menu-settings.png' })

// 2) BACK, then PLAY → must enter arena
await p.click('#resume-game')
await new Promise((r) => setTimeout(r, 400))
await p.click('#enter-arena')
await new Promise((r) => setTimeout(r, 800))
console.log('after-play:', await p.evaluate(() => JSON.stringify({
  body: document.body.className, lock: !!document.pointerLockElement,
})))

// 3) exit pointer lock (pause) → settings should open over the arena, card on top
await p.evaluate(() => document.exitPointerLock())
await new Promise((r) => setTimeout(r, 600))
console.log('paused:', await p.evaluate(() => JSON.stringify({
  body: document.body.className,
  card: document.getElementById('settings-menu').className,
  kicker: document.getElementById('settings-kicker').textContent,
})))
await p.screenshot({ path: '/tmp/probe-pause-settings.png' })
console.log('errors:', errs.length ? errs : 'none')
await b.close()
