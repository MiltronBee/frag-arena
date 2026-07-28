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

	// ARMORY: catalogue renders, filters actually narrow it, marketplace links are real.
	await page.evaluate(() => { location.hash = '#/armory' })
	await sleep(1200)
	const armAll = await page.evaluate(() => ({
		open: !document.querySelector('[data-screen="armory"]').classList.contains('screen-closed'),
		cards: document.querySelectorAll('#armory-grid .armory-card').length,
		count: (document.getElementById('armory-count') || {}).textContent || '',
		tensor: document.querySelectorAll('#armory-grid a[href*="tensor.trade"]').length,
		me: document.querySelectorAll('#armory-grid a[href*="magiceden.io"]').length,
		blank: Array.from(document.querySelectorAll('#armory-grid a')).every((a) => a.target === '_blank' && /noopener/.test(a.rel)),
	}))
	check('armory opens with the full catalogue', armAll.open && armAll.cards === 24, JSON.stringify({ open: armAll.open, cards: armAll.cards, count: armAll.count }))
	check('every card links to BOTH marketplaces', armAll.tensor === 24 && armAll.me === 24, `tensor=${armAll.tensor} me=${armAll.me}`)
	check('marketplace links open safely (_blank + noopener)', armAll.blank, 'blank+noopener=' + armAll.blank)

	// Filter to weapons — 4 types, and the finish row must hide (weapons have no finish).
	await page.evaluate(() => document.querySelector('[data-filter="kind:weapon"]').click())
	await sleep(600)
	const armW = await page.evaluate(() => ({
		cards: document.querySelectorAll('#armory-grid .armory-card').length,
		finishHidden: document.getElementById('armory-finishes').hidden,
		names: Array.from(document.querySelectorAll('#armory-grid h4')).map((h) => h.textContent),
	}))
	check('WEAPONS filter narrows to the four weapons', armW.cards === 4, `cards=${armW.cards} ${armW.names.join('/')}`)
	check('finish filter hides for weapons', armW.finishHidden, 'hidden=' + armW.finishHidden)

	// Armour + a single finish — five slots make one set.
	await page.evaluate(() => document.querySelector('[data-filter="kind:armor"]').click())
	await sleep(500)
	await page.evaluate(() => document.querySelector('[data-filter="finish:Solana"]').click())
	await sleep(600)
	const armS = await page.evaluate(() => ({
		cards: document.querySelectorAll('#armory-grid .armory-card').length,
		allSolana: Array.from(document.querySelectorAll('#armory-grid .armory-meta')).every((m) => /SOLANA/.test(m.textContent)),
	}))
	check('ARMOUR + SOLANA gives exactly one five-piece set', armS.cards === 5 && armS.allSolana, `cards=${armS.cards} allSolana=${armS.allSolana}`)

	// FRAGBENCH: the escape hatch. This is the regression that matters — answering the
	// identity gate as "human" used to be a permanent one-way latch on the agent path.
	await page.evaluate(() => { location.hash = '#/fragbench' })
	for (let i = 0; i < 20; i++) {
		const st = await page.evaluate(() => (document.getElementById('bench-state') || {}).textContent || '')
		if (st && st !== 'CONNECTING…') break
		await sleep(1000)
	}
	const bench = await page.evaluate(() => {
		const t = (id) => (document.getElementById(id) || {}).textContent || ''
		return {
			open: !document.querySelector('[data-screen="fragbench"]').classList.contains('screen-closed'),
			state: t('bench-state'), seats: t('bench-seats'),
			spec: !!document.querySelector('[data-screen="fragbench"] a[href="/frag.md"]'),
			endpoint: (document.querySelector('.bench-endpoint code') || {}).textContent || '',
			whoami: localStorage.getItem('fa-whoami'),
		}
	})
	check('fragbench screen reachable while remembered as HUMAN', bench.open && bench.whoami === 'human', JSON.stringify({ open: bench.open, whoami: bench.whoami }))
	check('live seat census renders', /\d/.test(bench.seats) && bench.state !== 'CONNECTING…', `state=${bench.state} seats=${bench.seats}`)
	check('entrant spec + endpoint are in the document', bench.spec && /wss:\/\//.test(bench.endpoint), `spec=${bench.spec} endpoint=${bench.endpoint}`)

	// The latch actually opens.
	await page.evaluate(() => document.getElementById('bench-reset').click())
	await sleep(400)
	const reset = await page.evaluate(() => ({
		whoami: localStorage.getItem('fa-whoami'),
		note: (document.getElementById('bench-reset-note') || {}).textContent || '',
	}))
	check('ASK ME AGAIN clears the remembered identity', reset.whoami === null, JSON.stringify(reset))

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
