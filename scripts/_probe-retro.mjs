// RETRO overhaul probe: screenshots + assertions for the segment-HUD re-skin,
// portrait de-clutter, instant-play splash skip, and map-rotation rejoin boot.
// Usage: node scripts/_probe-retro.mjs <step>
//   menu      — cold load, ONE click, assert menu visible + DSEG7 loaded + now-playing
//   game      — desktop in-game HUD screenshot (forced arena state, like _verify-map-cycle)
//   portrait  — 390x844 touch in-game HUD
//   landscape — 844x390 touch in-game HUD
//   rejoin    — sessionStorage fa-rejoin boot: splash+menu skipped, auto-entered
import puppeteer from 'puppeteer-core'
const step = process.argv[2] || 'menu'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const shot = (page, name) => page.screenshot({ path: `_work/retro-${name}.png` })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  const touch = step === 'portrait' || step === 'landscape'
  if (step === 'portrait') await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  else if (step === 'landscape') await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  else await page.setViewport({ width: 1440, height: 810 })

  if (step === 'rejoin') {
    await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('fa-rejoin', '1') } catch (e) {} })
  }

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })

  if (step === 'menu') {
    // ONE gesture from cold load to menu
    await new Promise(r => setTimeout(r, 800))
    await page.mouse.click(720, 400)
    await new Promise(r => setTimeout(r, 700))
    const st = await page.evaluate(async () => {
      const menuVisible = !!document.querySelector('#entry-overlay.is-visible')
      const splashGone = !document.getElementById('splash')
      const dsegLoaded = document.fonts.check('700 14px DSEG7')
      return { menuVisible, splashGone, dsegLoaded }
    })
    // let the now-playing poll land + fonts settle, then shoot
    await new Promise(r => setTimeout(r, 3500))
    const np = await page.evaluate(() => {
      const el = document.getElementById('now-playing')
      return { live: el && el.getAttribute('data-live'),
        now: (document.getElementById('np-now-text') || {}).textContent,
        next: (document.getElementById('np-next-text') || {}).textContent,
        dseg: document.fonts.check('700 14px DSEG7') }
    })
    await shot(page, 'menu')
    console.log(JSON.stringify({ step, ...st, np, pageErrors: errors.slice(0, 3) }))
  } else if (step === 'rejoin') {
    // splash must be gone instantly; interstitial covers boot; then auto-entered
    await new Promise(r => setTimeout(r, 500))
    const early = await page.evaluate(() => ({
      splashGone: !document.getElementById('splash'),
      mcVisible: !!document.querySelector('#map-change.mc-visible'),
    }))
    await page.waitForFunction('document.body.classList.contains("arena-entered")', { timeout: 40000 })
    await new Promise(r => setTimeout(r, 2500))
    const st = await page.evaluate(() => ({
      entered: document.body.classList.contains('arena-entered'),
      menuHidden: !document.querySelector('#entry-overlay.is-visible'),
      mcHidden: !document.querySelector('#map-change.mc-visible'),
      flagCleared: sessionStorage.getItem('fa-rejoin') === null,
    }))
    await shot(page, 'rejoin')
    console.log(JSON.stringify({ step, early, ...st, pageErrors: errors.slice(0, 3) }))
  } else {
    // in-game HUD (forced entry, _verify-map-cycle pattern)
    await page.waitForFunction(
      'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
      { timeout: 40000 })
    await new Promise(r => setTimeout(r, 5000))
    await page.evaluate(() => {
      ['entry-overlay','splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
      document.body.classList.add('arena-entered')
    })
    await new Promise(r => setTimeout(r, 2500))
    const st = await page.evaluate(() => {
      const r = (id) => { const el = document.getElementById(id); if (!el) return null
        const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
      return {
        dseg: document.fonts.check('700 14px DSEG7'),
        hp: r('health-panel'), ammo: r('weapon-panel'), nade: r('grenade-panel'),
        fire: r('touch-fire'), reload: r('touch-reload'), swtch: r('touch-switch'),
        throwB: r('touch-throw'), jump: r('touch-jump'), aim: r('touch-aim'),
        healthText: (document.getElementById('health-value') || {}).textContent,
        vh: innerHeight, vw: innerWidth,
      }
    })
    await shot(page, step)
    console.log(JSON.stringify({ step, ...st, pageErrors: errors.slice(0, 3) }))
  }
} finally { await browser.close() }
