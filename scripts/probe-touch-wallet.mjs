// Does the wallet input actually RECEIVE a touch mid-match on a phone?
//
// Reported symptom: "on mobile I can't link my wallet mid game because the touch controls
// snag the intent". Rather than reason about z-index, this asks the browser directly —
// elementFromPoint at the centre of each control tells us exactly which element would
// swallow the tap.
import puppeteer from 'puppeteer-core'

const URL = process.env.VERIFY_URL || 'http://localhost:8099/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
	executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
})
try {
	const page = await browser.newPage()
	// A real phone viewport with touch — the media queries and the touch layer both
	// depend on it, and Chrome lays out at 980px without the viewport meta honoured.
	await page.emulate({
		viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
	})
	await page.evaluateOnNewDocument(() => {
		try { localStorage.setItem('fa-whoami', 'human') } catch (e) {}
	})
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 90000 })
	await sleep(2500)

	await page.evaluate(() => {
		// Dismiss the splash. It is a high-z-index overlay that auto-advances through its
		// cards and intercepts every tap; mid-match it is long gone, so leaving it up
		// makes the probe measure the splash instead of the thing under test.
		for (const sel of ['#splash', '#whoami', '#entry-overlay']) {
			const el = document.querySelector(sel)
			if (el) el.style.display = 'none'
		}
		// Simulate the mid-match state: the arena is entered and the touch layer is live.
		document.body.classList.add('arena-entered')
		// Open the wallet panel the way the pause menu does.
		const mc = window.gameClient.simulator._menuControls
		mc.openModal('wallet-modal')
		mc._initWalletLink()
	})
	// Let the open transition finish. Probing in the same tick reads the modal as still
	// hidden and reports a blockage that does not exist.
	await sleep(900)

	const report = await page.evaluate(() => {

		const probe = (sel) => {
			const el = document.querySelector(sel)
			if (!el) return { sel, missing: true }
			const r = el.getBoundingClientRect()
			if (!r.width || !r.height) return { sel, hidden: true }
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
			const inside = !!(hit && (hit === el || el.contains(hit) || hit.contains(el)))
			return {
				sel,
				rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
				hit: hit ? (hit.id ? '#' + hit.id : hit.tagName + '.' + (hit.className || '').toString().slice(0, 30)) : 'null',
				reachable: inside,
			}
		}
		const tc = document.getElementById('touch-controls')
		const cs = tc ? getComputedStyle(tc) : null
		return {
			bodyClass: document.body.className,
			touchControls: cs ? { zIndex: cs.zIndex, pointerEvents: cs.pointerEvents, opacity: cs.opacity } : null,
			modal: (() => { const m=document.getElementById('wallet-modal'); const c=getComputedStyle(m);
				return { cls: m.className, z: c.zIndex, vis: c.visibility, op: c.opacity, pe: c.pointerEvents, disp: c.display, pos: c.position } })(),
			probes: [probe('#wallet-input'), probe('#wallet-link-btn'), probe('#wallet-modal .panel-close')],
		}
	})

	console.log('body class      :', report.bodyClass)
	console.log('#touch-controls :', JSON.stringify(report.touchControls))
	console.log('wallet modal    :', JSON.stringify(report.modal))
	for (const p of report.probes) {
		console.log(`  ${String(p.sel).padEnd(28)} reachable=${p.reachable}  hitBy=${p.hit}  rect=${p.rect}`)
	}
	const blocked = report.probes.filter((p) => p.reachable === false)
	console.log(blocked.length ? `\nBLOCKED: ${blocked.length} control(s) cannot be tapped` : '\nall wallet controls are tappable')

	// REGRESSION GUARD: the layer must come BACK. Standing the touch controls down while
	// a panel is open is only correct if closing it re-arms them — otherwise the fix
	// trades an untappable wallet for an unplayable game.
	await page.evaluate(() => {
		const mc = window.gameClient.simulator._menuControls
		mc.closeModal(document.getElementById('wallet-modal'))
	})
	await sleep(700)
	const after = await page.evaluate(() => {
		const tc = getComputedStyle(document.getElementById('touch-controls'))
		const z = document.getElementById('touch-move-zone')
		const r = z.getBoundingClientRect()
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
		return {
			bodyClass: document.body.className,
			pe: tc.pointerEvents,
			joystickHit: hit ? (hit.id || hit.tagName) : 'null',
		}
	})
	const restored = after.pe === 'auto' && /touch-(move|look)-zone/.test(after.joystickHit)
	console.log(`\nafter close  : pointerEvents=${after.pe} joystickHitBy=${after.joystickHit} bodyClass="${after.bodyClass}"`)
	console.log(restored ? 'touch controls RESTORED on close' : 'FAIL: touch controls did not come back')
	if (blocked.length || !restored) process.exitCode = 1
} finally { await browser.close() }
