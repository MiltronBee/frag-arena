// SCREENS check — the loadout/issuance/whitepaper modals became routed screens.
//
// Never deploys into the arena on purpose: the menu backdrop is far cheaper to render
// than a live match, and on software GL a deployed arena starves the main thread badly
// enough that CDP evaluate calls time out (see verify-wallet-grant.mjs).
import puppeteer from 'puppeteer-core'

const URL = process.env.VERIFY_URL || 'http://localhost:8099/'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, p, d) => results.push({ n, p: !!p, d })
const errs = []

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: 'new',
	protocolTimeout: 300000,
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--mute-audio', '--window-size=900,700'],
})

try {
	const page = await browser.newPage()
	page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)))
	page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)) })
	await page.evaluateOnNewDocument(() => {
		try { localStorage.setItem('fa-whoami', 'human') } catch (e) {}
	})
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction('window.gameClient && window.gameClient.simulator', { timeout: 90000 })
	await sleep(2500)

	// The three screens exist and all start closed.
	const present = await page.evaluate(() => {
		const els = Array.from(document.querySelectorAll('[data-screen]'))
		return {
			names: els.map((e) => e.getAttribute('data-screen')),
			allClosed: els.every((e) => e.classList.contains('screen-closed')),
		}
	})
	check('all three screens present', ['character', 'issuance', 'codex'].every((n) => present.names.includes(n)), present.names.join(','))
	check('screens start closed', present.allClosed, 'allClosed=' + present.allClosed)

	// The old modals are gone — otherwise both would exist and the plate could open either.
	const stale = await page.evaluate(() => ['loadout-modal', 'issuance-modal', 'whitepaper-modal']
		.filter((id) => !!document.getElementById(id)))
	check('old modals removed', stale.length === 0, stale.join(',') || 'none left')

	// CODEX: entry list built from the data module, reader paints, routing works.
	await page.evaluate(() => { location.hash = '#/codex' })
	await sleep(900)
	const codex = await page.evaluate(() => ({
		open: !document.querySelector('[data-screen="codex"]').classList.contains('screen-closed'),
		bodyOpen: document.body.classList.contains('screen-open'),
		items: document.querySelectorAll('#codex-list .codex-item').length,
		cats: document.querySelectorAll('#codex-list .codex-cat').length,
		title: (document.getElementById('codex-title') || {}).textContent || '',
		paras: document.querySelectorAll('#codex-body p').length,
	}))
	check('codex screen opens on #/codex', codex.open && codex.bodyOpen, JSON.stringify(codex))
	check('codex entry list built', codex.items >= 8 && codex.cats === 3, `items=${codex.items} cats=${codex.cats}`)
	check('codex reader auto-selects first entry', !!codex.title && codex.paras > 0, `title=${codex.title} paras=${codex.paras}`)

	// Deep link straight to an entry — the reason routing exists at all.
	await page.evaluate(() => { location.hash = '#/codex/proof-of-blood' })
	await sleep(700)
	const deep = await page.evaluate(() => ({
		title: (document.getElementById('codex-title') || {}).textContent || '',
		active: (document.querySelector('.codex-item.is-active') || {}).textContent || '',
	}))
	check('deep link selects the entry', /proof of blood/i.test(deep.title), JSON.stringify(deep))

	// ISSUANCE: live numbers off /blood, not hardcoded text.
	await page.evaluate(() => { location.hash = '#/issuance' })
	// Wait for a POLL to land, not a fixed beat. On a cold cache the page is still
	// pulling hundreds of textures through one local static server, and Chrome starts
	// refusing new sockets (ERR_INSUFFICIENT_RESOURCES) — so the first /blood fetch can
	// lose. The screen re-polls every 5s precisely so a lost read is not a dead panel;
	// this waits for that to happen instead of asserting on the first attempt.
	for (let i = 0; i < 20; i++) {
		const h = await page.evaluate(() => (document.getElementById('blood-height') || {}).textContent || '')
		if (/^#\d/.test(h)) break
		await sleep(1500)
	}
	const blood = await page.evaluate(() => {
		const t = (id) => (document.getElementById(id) || {}).textContent || ''
		return {
			open: !document.querySelector('[data-screen="issuance"]').classList.contains('screen-closed'),
			codexClosed: document.querySelector('[data-screen="codex"]').classList.contains('screen-closed'),
			state: t('blood-state'), height: t('blood-height'), reward: t('blood-reward'),
			mined: t('blood-mined'), cap: t('blood-cap'), holders: t('blood-holders'),
			rows: document.querySelectorAll('#blood-holder-rows li').length,
		}
	})
	check('issuance opens and codex closed (one surface at a time)', blood.open && blood.codexClosed, JSON.stringify({ o: blood.open, c: blood.codexClosed }))
	check('issuance shows a LIVE block height', /^#\d/.test(blood.height), 'height=' + blood.height)
	check('issuance shows mined vs cap', /\d/.test(blood.mined) && /\d/.test(blood.cap), `mined=${blood.mined} cap=${blood.cap}`)
	check('holder table populated from the ledger', blood.rows > 0, `rows=${blood.rows} holders=${blood.holders}`)

	// Back out — the menu must come back, and no screen may be left open.
	await page.evaluate(() => { location.hash = '' })
	await sleep(800)
	const closed = await page.evaluate(() => ({
		anyOpen: Array.from(document.querySelectorAll('[data-screen]')).some((e) => !e.classList.contains('screen-closed')),
		bodyFlag: document.body.classList.contains('screen-open'),
	}))
	check('leaving a screen returns to the menu', !closed.anyOpen && !closed.bodyFlag, JSON.stringify(closed))

	// Two rig symptoms, not product bugs: ERR_INSUFFICIENT_RESOURCES (one thin static
	// server cannot keep up with a cold-cache asset storm, so Chrome stops granting
	// sockets) and ERR_BLOB_OUT_OF_MEMORY (software GL holds every decoded texture in
	// system memory). Both are exhaustion in the harness. Filtered NARROWLY by those two
	// codes so they cannot mask a real failure — pageerrors and every other console error
	// still fail this check.
	const real = errs.filter((e) => !/ERR_INSUFFICIENT_RESOURCES|ERR_BLOB_OUT_OF_MEMORY/.test(e))
	check('no page/console errors', real.length === 0, real.slice(0, 3).join(' | ') || `clean (${errs.length - real.length} rig-resource warnings ignored)`)
} finally {
	await browser.close()
}

let fail = 0
for (const r of results) {
	if (!r.p) fail++
	console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `  — ${r.d}` : ''}`)
}
console.log(fail ? `\n${fail} check(s) FAILED` : `\nall ${results.length} checks passed`)
process.exit(fail ? 1 : 0)
