// IDENTITY GATE (#whoami) verification. Drives the real boot sequence with real
// taps: splash gate -> partner reel -> the human-or-agent question -> menu.
//
// What it has to prove, beyond "the screen appears":
//   * the gate stands BETWEEN the reel and the menu (the menu is not revealed early)
//   * a human answer reveals the menu and is remembered on the next visit
//   * an agent answer navigates to /frag.md
//   * ?whoami=1 brings the question back for someone who already answered
//   * the map-rotation rejoin path skips the gate entirely (it must never sit
//     between a player and the match they were already in)
import http from 'http'; import fs from 'fs'; import path from 'path'; import puppeteer from 'puppeteer-core'
const ROOT = path.resolve(process.env.HOME, 'unreal/public')
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const PORT = 8062
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.md': 'text/plain', '.txt': 'text/plain', '.webp': 'image/webp', '.jpg': 'image/jpeg' }
const server = http.createServer((req, res) => {
	let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'
	const file = path.join(ROOT, path.normalize(p))
	if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf') }
	res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
	fs.createReadStream(file).pipe(res)
})
await new Promise(r => server.listen(PORT, r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader'] })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (n, c, d = '') => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : '   ' + d)); c ? pass++ : fail++ }
const URL = 'http://localhost:' + PORT + '/'

// Boot a page and run the splash to its end with real taps, stopping at whatever
// the reel hands over to.
async function bootToGate(page, url = URL) {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
	await sleep(600)
	// card 0 is the audio gate: the first tap starts the reel, the second skips it
	await page.mouse.click(200, 400); await sleep(250)
	await page.mouse.click(200, 400); await sleep(700)
}
const gateOpen = page => page.evaluate(() => {
	const g = document.getElementById('whoami')
	return !!g && g.classList.contains('is-open') && getComputedStyle(g).display !== 'none'
})
const menuRevealed = page => page.evaluate(() => document.body.classList.contains('menu-reveal'))

try {
	// ── 1. the reel hands over to the gate, and the menu is NOT revealed yet ──
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 800 })
	await bootToGate(page)
	ok('the gate opens after the boot reel', await gateOpen(page))
	ok('the menu is held back until the question is answered', !(await menuRevealed(page)))
	ok('both doors are offered', await page.evaluate(() =>
		!!document.getElementById('whoami-human') && !!document.getElementById('whoami-agent')))
	ok('the agent door names the spec path', await page.evaluate(() =>
		/frag\.md/.test(document.getElementById('whoami-agent').innerText)))
	// the gate must swallow pointerdown, or InputSystem takes pointer lock behind it
	ok('the gate is above the menu it is holding back', await page.evaluate(() => {
		const g = document.getElementById('whoami')
		const e = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
		return !!e && g.contains(e)
	}))

	// ── 2. answering HUMAN reveals the menu ──────────────────────────────────
	await page.click('#whoami-human'); await sleep(400)
	ok('answering human closes the gate', !(await gateOpen(page)))
	ok('answering human reveals the menu', await menuRevealed(page))
	ok('the answer is remembered', await page.evaluate(() => localStorage.getItem('fa-whoami')) === 'human')

	// ── 3. a returning human is not asked twice ──────────────────────────────
	await bootToGate(page)
	ok('a returning human skips the gate', !(await gateOpen(page)))
	ok('a returning human still reaches the menu', await menuRevealed(page))

	// ── 4. ?whoami=1 brings the question back ────────────────────────────────
	await bootToGate(page, URL + '?whoami=1')
	ok('?whoami=1 re-asks the question', await gateOpen(page))

	// ── 5. answering AGENT goes to the spec ──────────────────────────────────
	await Promise.all([
		page.waitForNavigation({ timeout: 8000 }).catch(() => null),
		page.click('#whoami-agent'),
	])
	await sleep(500)
	ok('answering agent navigates to /frag.md', /\/frag\.md$/.test(page.url()), page.url())
	ok('the spec is served as readable text', await page.evaluate(() =>
		document.body.innerText.includes('FragBench') && document.body.innerText.includes('wss://')))

	// ── 6. the rotation rejoin path must never see the gate ──────────────────
	const p2 = await browser.newPage()
	await p2.setViewport({ width: 1280, height: 800 })
	await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
	await p2.evaluate(() => { sessionStorage.setItem('fa-rejoin', '1'); localStorage.removeItem('fa-whoami') })
	await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
	await sleep(900)
	ok('a map-rotation rejoin skips the gate', !(await gateOpen(p2)))
	ok('a map-rotation rejoin goes straight through', await menuRevealed(p2))

	// ── 7. discovery surfaces for agents that never render anything ──────────
	const specRes = await fetch(URL + 'frag.md')
	const spec = await specRes.text()
	ok('/frag.md is fetchable', specRes.status === 200)
	ok('/frag.md documents the endpoint', spec.includes('wss://degentournament.fun/agent'))
	ok('/frag.md documents the seat rule', /humans?\s+get(s)? the seat first/i.test(spec))
	const llms = await (await fetch(URL + 'llms.txt')).text()
	ok('/llms.txt points at the spec', llms.includes('frag.md'))
	const robots = await (await fetch(URL + 'robots.txt')).text()
	ok('/robots.txt points at the spec', robots.includes('frag.md'))
	const html = await (await fetch(URL)).text()
	ok('the page head links the spec for non-rendering agents',
		/<link rel="alternate" type="text\/markdown" href="\/frag\.md"/.test(html))
	ok('the page source opens with an agent notice', html.indexOf('IF YOU ARE AN AI AGENT') < html.indexOf('<head>'))
} catch (e) {
	console.log('ERROR', e && e.message)
	fail++
} finally {
	await browser.close(); server.close()
	console.log(`\n${pass} passed, ${fail} failed`)
	process.exit(fail ? 1 : 0)
}
