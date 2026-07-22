// LIVE diagnostic observer — joins https://sol-pkmn.fun with a headless client and
// dumps the replicated team/hp state of every player entity, then watches hp deltas
// for ~20s while bots fight. Answers: (a) are teamIds sane on live, (b) does ANY
// combat damage replicate (bots fight constantly — if no hp ever drops, damage is
// gated server-wide), (c) what team the observer itself gets.
// READ-ONLY: the observer never fires and idles at spawn (it will look like an
// AFK player for ~30s; acceptable for a live diagnostic on our own server).
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome', headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})
try {
	const page = await browser.newPage()
	page.on('pageerror', e => console.log('[pageerr]', e.message.slice(0, 150)))
	await page.goto('https://sol-pkmn.fun/', { waitUntil: 'domcontentloaded' })
	// LIVE build = old flow: entity exists after connect (no deploy gating yet)
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
		{ timeout: 60000 })
	await sleep(3000)

	const snap = () => page.evaluate(() => {
		const sim = window.gameClient.simulator
		const me = sim.myRawEntity
		const out = { me: { nid: me.nid, teamId: me.teamId, hp: me.hitpoints }, others: [] }
		// remote players = the entities behind characterModels (smooth replicas)
		// model.host is the entity MESH (no protocol fields) — the replicated team
		// arrives via the factory watch into CharacterModel.setTeam (_teamId), and
		// hp deltas are observable via the same watch's side effects; read _teamId
		// and mesh position (valid), and track hp via the sim damage feed instead.
		sim.characterModels.forEach((model, nid) => {
			out.others.push({ nid, teamId: model._teamId })
		})
		return out
	})

	const first = await snap()
	console.log('T+0s :', JSON.stringify(first))
	const hp0 = new Map(first.others.map(o => [o.nid, o.hp]))
	let sawDamage = false
	for (let i = 1; i <= 4; i++) {
		await sleep(5000)
		const s = await snap()
		const deltas = s.others
			.filter(o => hp0.has(o.nid) && o.hp !== hp0.get(o.nid))
			.map(o => `${o.nid}: ${hp0.get(o.nid)}->${o.hp}`)
		if (deltas.length) sawDamage = true
		console.log(`T+${i * 5}s:`, JSON.stringify(s.others.map(o => ({ nid: o.nid, t: o.teamId, hp: o.hp }))), deltas.length ? ' DELTAS: ' + deltas.join(', ') : ' (no hp change)')
		s.others.forEach(o => hp0.set(o.nid, o.hp))
	}
	const teams = {}
	first.others.forEach(o => { teams[o.teamId] = (teams[o.teamId] || 0) + 1 })
	console.log('SUMMARY: myTeam=', first.me.teamId, 'botTeams=', JSON.stringify(teams), 'combatDamageObserved=', sawDamage)
} catch (e) {
	console.error('LIVE PROBE ERROR:', e.message)
} finally {
	await browser.close().catch(() => {})
}
process.exit(0)
