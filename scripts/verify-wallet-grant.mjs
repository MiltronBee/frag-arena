// WALLET GRANT regression check. Proves the fix for the Season 1 bug where owning a
// weapon NFT granted nothing in-game.
//
// THE BUG: client/GameClient.js reads localStorage['degen.wallet'] ONCE, at page load,
// and rides it along in the nengi handshake. The menu saves the address AFTER the socket
// is connected — so a player linking for the FIRST time never sent an address at all,
// never got a grant, and deployed with the spawn pistol regardless of what they held.
// Only a page reload fixed it, and nothing in the UI said to reload.
//
// THE TEST MUST START WITH AN EMPTY localStorage. That is the entire point: if the
// address is pre-seeded, the handshake carries it and the test passes even with the fix
// reverted. Clearing it first is what forces the grant through the LinkWalletCommand path.
import puppeteer from 'puppeteer-core'

const URL = process.env.VERIFY_URL || 'http://localhost:8080/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
// A wallet that really holds Season 1 assets on mainnet (the DEGEN vanity wallet used for
// the mint). Overridable so this can be pointed at devnet or a test holder.
const WALLET = process.env.VERIFY_WALLET || 'DEGENZnU4NWTQSQsmdaDMrjTrUVuTUeVdYJPmw8x1994'
// The mainnet read is a getProgramAccounts scan over mpl-core and measured ~26s on the
// public RPC, so the wait has to clear that with margin or this fails for the wrong reason.
const GRANT_TIMEOUT_MS = Number(process.env.VERIFY_GRANT_MS || 75000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, p, d) => results.push({ n, p: !!p, d })
const errs = []

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: 'new',
	// protocolTimeout: software GL (swiftshader) renders this scene at single-digit fps,
	// and the render loop starves the main thread that CDP evaluate calls have to run on.
	// The default 180s protocol timeout fires long before anything is actually wrong —
	// which reads as a hang in the game rather than what it is, a slow test rig.
	protocolTimeout: 600000,
	args: [
		'--no-sandbox', '--disable-setuid-sandbox',
		'--use-gl=angle', '--use-angle=swiftshader', '--mute-audio',
		// Nothing here looks at pixels; a small window is far less software rasterising
		// per frame, which is the difference between usable and unusable evaluate latency.
		'--window-size=640,480',
	],
})

try {
	const page = await browser.newPage()
	page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)))
	page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)) })

	// Set up storage BEFORE any page script runs, on a single load. Doing it the obvious
	// way (load, write, reload) means paying the full asset load twice and racing the
	// second one; this runs in the fresh document before the app boots.
	//
	//   degen.wallet cleared  -> the handshake carries NO address, which is the whole point
	//   fa-whoami = human     -> skip the identity gate so the menu is reachable
	await page.evaluateOnNewDocument(() => {
		try {
			localStorage.removeItem('degen.wallet')
			localStorage.setItem('fa-whoami', 'human')
		} catch (e) { /* private mode — the gate handles it */ }
	})
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
	// Generous: a cold dev server compiles ~1400 modules on the first request.
	await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 90000 })

	let connected = false
	for (let i = 0; i < 40; i++) {
		if (await page.evaluate(() => window.gameClient.simulator._connectionState) === 'connected') { connected = true; break }
		await sleep(500)
	}
	check('client connects with NO wallet in the handshake', connected, 'connected=' + connected)

	// PRECONDITION. If this is false the test is meaningless — the handshake carried an
	// address and we are no longer exercising the broken path.
	const sentAtHandshake = await page.evaluate(() => (localStorage.getItem('degen.wallet') || '') !== '')
	check('precondition: nothing was saved at page load', !sentAtHandshake, 'saved=' + sentAtHandshake)

	// Link the wallet the way a player does: type it into the menu field, click LINK.
	const typed = await page.evaluate((addr) => {
		const input = document.getElementById('wallet-input')
		const btn = document.getElementById('wallet-link-btn')
		if (!input || !btn) return false
		input.value = addr
		btn.click()
		return true
	}, WALLET)
	check('wallet panel present and LINK clicked', typed, 'typed=' + typed)

	// Deploy immediately, without waiting for the read. This is the real-world ordering —
	// a player hits PLAY straight after linking — and it also proves the late-landing
	// grant is applied to a LIVE body rather than only at the next respawn.
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	let spawned = false
	for (let i = 0; i < 30; i++) {
		if (await page.evaluate(() => !!window.gameClient.simulator.myRawEntity)) { spawned = true; break }
		await sleep(500)
	}
	check('own entity deployed', spawned, 'spawned=' + spawned)

	// Now wait for the chain read to land and the grant to reach the body.
	let mask = 0
	let grantedAt = 0
	const t0 = Date.now()
	while (Date.now() - t0 < GRANT_TIMEOUT_MS) {
		mask = await page.evaluate(() => {
			const e = window.gameClient.simulator.myRawEntity
			return e ? (e.ownedWeapons | 0) : 0
		})
		// more than one bit set = something beyond the spawn pistol was granted
		if (mask && (mask & (mask - 1)) !== 0) { grantedAt = Date.now() - t0; break }
		await sleep(1000)
	}
	const bits = []
	for (let i = 0; i < 32; i++) if (mask & (1 << i)) bits.push(i)
	check(
		'GRANT APPLIED to a live body without a reload',
		grantedAt > 0,
		`ownedWeapons=0b${mask.toString(2)} bits=[${bits}] after ${grantedAt || GRANT_TIMEOUT_MS}ms`,
	)

	// The menu should also stop lying about it — the server's WalletLinked message
	// overwrites the status line with what was actually applied.
	const status = await page.evaluate(() => {
		const el = document.getElementById('wallet-status')
		return el ? el.textContent : ''
	})
	check('menu reports the applied grant', /READY|held/.test(status), JSON.stringify(status))

	check('no page/console errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean')
} finally {
	await browser.close()
}

let fail = 0
for (const r of results) {
	if (!r.p) fail++
	console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `  — ${r.d}` : ''}`)
}
console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed')
process.exit(fail ? 1 : 0)
