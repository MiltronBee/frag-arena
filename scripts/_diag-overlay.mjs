// Focused diagnostic for the post-match overlay: does the element exist, did the
// overlay bind to it, and does forcing show() actually paint? No game server needed —
// with no entities the ranking is empty, but the root/head/CSS all still exercise.
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.PROBE_VITE_PORT || '8080'
const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome', headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,720'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720 })
const errs = []
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)) })
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
await sleep(20000)

const before = await page.evaluate(`(() => {
  const sim = window.gameClient && window.gameClient.simulator
  const el = document.getElementById('match-end')
  return {
    elementInDom: !!el,
    simExists: !!sim,
    overlayExists: !!(sim && sim._matchEnd),
    overlayRootBound: !!(sim && sim._matchEnd && sim._matchEnd.root),
    subElements: el ? ['me-title','me-score','me-rows','me-stats','me-badges','me-clock']
      .map(id => id + '=' + !!document.getElementById(id)).join(' ') : null,
    computedDisplay: el ? getComputedStyle(el).display : null,
    lastPhase: sim ? sim._lastTdmPhase : null,
  }
})()`)
console.log('BEFORE:', JSON.stringify(before, null, 1))

// Force the overlay open exactly the way the phase flip would.
const after = await page.evaluate(`(() => {
  const sim = window.gameClient && window.gameClient.simulator
  if (!sim || !sim._matchEnd) return { error: 'no overlay' }
  try {
    sim._arenaEntered = true
    sim._matchEnd.resetLog()
    sim._matchEnd.show({ ffa: false, winner: 0, myTeam: 0, s0: 5, s1: 3, mode: 0 })
    sim._matchEnd.update()
    const el = document.getElementById('match-end')
    return {
      ok: true,
      classes: el.className,
      display: getComputedStyle(el).display,
      opacity: getComputedStyle(el).opacity,
      rowCount: document.getElementById('me-rows').children.length,
      title: document.getElementById('me-title').textContent,
      score: document.getElementById('me-score').textContent,
      bodyClass: document.body.className,
    }
  } catch (e) { return { error: String(e).slice(0, 400) } }
})()`)
console.log('AFTER show():', JSON.stringify(after, null, 1))

// let the staged reveal run
await sleep(11000)
await page.evaluate(`window.gameClient.simulator._matchEnd.update()`).catch(() => {})
await page.screenshot({ path: '/tmp/overlay-forced.png' })
console.log('ERRORS:', errs.slice(0, 10).join('\n') || '(none)')
await browser.close()
