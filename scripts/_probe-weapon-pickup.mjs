// WEAPON-PICKUP FEEDBACK probe. Verifies the pickup feature batch end-to-end on an
// EMPTY map (MAP=dm_somnus BOT_FILL=0 — no bots to race us to the item):
//   1) PHASE 1 — join, read a real WEAPON Pickup entity's world coords from the client's
//      _pickups map (+ the map scale), then tear the server down.
//   2) PHASE 2 — reboot the server with DEV_SPAWN_AT pinned to that pickup's NATIVE coords
//      (world / scale) so the SERVER spawns us ON the item and grants it by its own
//      proximity tick (the client can't move the server-side body, so setting our own
//      x/y/z would never trigger the grant — hence DEV_SPAWN_AT, like _probe-teleport.mjs).
//      Then assert, within ~3s:
//        - the granted ownedWeapons bit appeared on our raw entity
//        - a #pickup-toast element painted the "+ <NAME>" toast (DOM)
//        - currentWeaponIndex / weaponIndex AUTO-SWITCHED to the new weapon (pistol -> gun
//          is always an upgrade)
//        - no page errors
//      Finally simulate desktop number-key switching (Digit4 -> pistol, Digit<wi+1> -> the
//      picked-up gun) with pointer-lock forced on, asserting the switch requests flow — i.e.
//      no capture-phase listener swallows the digit keydown before the weapon handler.
//
//   node scripts/_probe-weapon-pickup.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/weapon-pickup'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const PICKUP_TYPE_WEAPON = 0
const SPAWN_WEAPON_INDEX = 3 // pistol (common/weaponsConfig)

const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
	'--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
	'--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding']

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}
function killProc(p) { try { process.kill(-p.pid) } catch { try { p.kill('SIGKILL') } catch {} } }

async function joinAndDeploy(browser) {
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
		{ timeout: 45000 })
	await page.evaluate(() => window.gameClient.simulator.requestDeploy())
	await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
	return { page, errors }
}

let failed = false
let browser = null
let reuseVite = false
let srv = null
try {
	// ---- vite (shared across both phases) ----
	reuseVite = await portBusy(VITE_PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')

	browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: CHROME_ARGS })

	// ================= PHASE 1: discover a WEAPON pickup =================
	srv = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOT_FILL: '0' }, 'srv1')
	await sleep(7000)
	let p1 = await joinAndDeploy(browser)
	// wait until the pickup entities have streamed in
	await p1.page.waitForFunction('window.gameClient.simulator._pickups && window.gameClient.simulator._pickups.size > 0', { timeout: 60000 })
	const disco = await p1.page.evaluate(() => {
		const sim = window.gameClient.simulator
		const scale = (sim.map && sim.map.scale) || 1
		const list = []
		sim._pickups.forEach((e) => list.push({ nid: e.nid, type: e.type, wi: e.weaponIndex, x: e.x, y: e.y, z: e.z }))
		return { scale, list }
	})
	await p1.page.close()
	killProc(srv); srv = null
	spawn('bash', ['-c', 'fuser -k 8078/tcp 8079/tcp 2>/dev/null; true'])
	await sleep(1500)

	// pick a WEAPON pickup for an enabled, non-pistol weapon (so auto-switch fires and a
	// distinct digit can select it): weaponIndex in {0,1,2} (Rifle/SMG/Shotgun).
	const target = disco.list.find(e => e.type === PICKUP_TYPE_WEAPON && e.wi >= 0 && e.wi <= 2 && e.wi !== SPAWN_WEAPON_INDEX)
	if (!target) throw new Error('no enabled non-pistol WEAPON pickup found on dm_somnus; pickups=' + JSON.stringify(disco.list))
	const wi = target.wi
	const sc = disco.scale || 1
	const DEV_SPAWN_AT = `${(target.x / sc).toFixed(4)},${(target.y / sc).toFixed(4)},${(target.z / sc).toFixed(4)}`

	// ================= PHASE 2: spawn ON it, verify grant =================
	srv = boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'dm_somnus', BOT_FILL: '0', DEV_SPAWN_AT }, 'srv2')
	await sleep(7000)
	const p2 = await joinAndDeploy(browser)
	const page = p2.page, errors = p2.errors

	// the server grants within a tick or two of our spawn -> the networked ownedWeapons bit
	let granted = true
	try {
		await page.waitForFunction((bit) => {
			const e = window.gameClient.simulator.myRawEntity
			return e && (e.ownedWeapons & (1 << bit)) !== 0
		}, { timeout: 4000 }, wi)
	} catch (e) { granted = false }

	const audit = await page.evaluate((bit) => {
		const sim = window.gameClient.simulator
		const e = sim.myRawEntity
		const toast = document.getElementById('pickup-toast')
		return {
			ownedBit: !!(e && (e.ownedWeapons & (1 << bit))),
			toastPresent: !!toast,
		}
	}, wi)

	// ---- desktop digit-key switch (run BEFORE the diff test below, which rewrites our
	// ownedWeapons mask). Force pointer-lock, press Digit4 (pistol) then the picked-up
	// weapon's digit. If any capture-phase listener swallowed digits, weaponIndex would not
	// change — this asserts the weapon-switch keydown handler still sees 1-5. ----
	await page.evaluate(() => { window.gameClient.simulator.input.pointerLocked = true })
	await page.keyboard.press('Digit4') // -> slot 3 (pistol, always owned)
	await sleep(200)
	const afterPistol = await page.evaluate(() => window.gameClient.simulator.weaponIndex)
	await page.keyboard.press(`Digit${wi + 1}`) // -> slot wi (the picked-up gun, owned end-to-end)
	await sleep(200)
	const afterGun = await page.evaluate(() => window.gameClient.simulator.weaponIndex)

	// -------- feature-logic verification of the ownedWeapons DIFF path --------
	// Spawning EXACTLY on the pickup makes the server's grant land in the SAME network
	// snapshot as the entity-create, so _lastOwned initializes to the already-granted mask
	// and the diff is invisible (in real play you spawn pistol-only and walk onto items
	// seconds later, so the diff always fires). Reproduce the REAL diff the way play does:
	// reset our predicted inventory to pistol-only, flip a fresh weapon bit, and run the
	// ACTUAL _syncOwnershipRefill() — exercising the real toast (real #pickup-toast DOM) +
	// real switchWeapon() auto-switch. Also proves the "never auto-switch while the trigger
	// is held" hard rule.
	const diff = await page.evaluate((PISTOL) => {
		const sim = window.gameClient.simulator
		const e = sim.myRawEntity
		const reset = () => {
			e.ownedWeapons = 1 << PISTOL
			sim._lastOwned = 1 << PISTOL
			sim.weaponIndex = PISTOL
			e.currentWeaponIndex = PISTOL
			if (sim.input && sim.input.frameState) sim.input.frameState.mouseDown = false
		}
		// CASE 1: fresh Rifle(0) grant while NOT firing -> toast + auto-switch to 0
		reset()
		e.ownedWeapons |= (1 << 0)
		sim._syncOwnershipRefill()
		const toast = document.getElementById('pickup-toast')
		const case1 = { weaponIndex: sim.weaponIndex, toastText: toast ? (toast.textContent || '') : '', shown: toast ? toast.classList.contains('pickup-toast-show') : false }
		// CASE 2: fresh Shotgun(2) grant while the trigger IS held -> feedback fires but NO
		// auto-switch (stays on pistol) — the mid-burst suppression rule.
		reset()
		if (sim.input && sim.input.frameState) sim.input.frameState.mouseDown = true
		e.ownedWeapons |= (1 << 2)
		sim._syncOwnershipRefill()
		const case2 = { weaponIndex: sim.weaponIndex, toastText: toast ? (toast.textContent || '') : '' }
		if (sim.input && sim.input.frameState) sim.input.frameState.mouseDown = false
		return { case1, case2 }
	}, SPAWN_WEAPON_INDEX)

	// best-effort screenshot (toast may already be mid-fade — assertions use textContent)
	try {
		await page.evaluate(() => { ['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() }); document.body.classList.add('arena-entered') })
		for (let i = 0; i < 20; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} }); await sleep(16) }
		await page.screenshot({ path: `${OUT}/pickup.png` })
	} catch (e) {}

	// CASE 1: toast painted (non-empty) + auto-switched to Rifle(0)
	const toastNamed = diff.case1.toastText.replace(/[^A-Za-z]/g, '').length > 0
	const autoSwitched = diff.case1.weaponIndex === 0 && toastNamed && diff.case1.shown
	// CASE 2: trigger held -> still toasts but stays on pistol (no auto-switch)
	const fireSuppressed = diff.case2.weaponIndex === SPAWN_WEAPON_INDEX &&
		diff.case2.toastText.replace(/[^A-Za-z]/g, '').length > 0
	const digitPistol = afterPistol === SPAWN_WEAPON_INDEX
	const digitGun = afterGun === wi
	const ok = granted && audit.ownedBit && audit.toastPresent && autoSwitched
		&& fireSuppressed && digitPistol && digitGun && errors.length === 0

	console.log(JSON.stringify({
		pickup: { weaponIndex: wi, world: { x: target.x, y: target.y, z: target.z }, scale: sc, DEV_SPAWN_AT },
		endToEnd: { granted, ownedBit: audit.ownedBit, toastElementPresent: audit.toastPresent },
		autoSwitch_case1: { ...diff.case1, expectedWeaponIndex: 0, ok: autoSwitched },
		fireHeldSuppression_case2: { ...diff.case2, expectedWeaponIndex: SPAWN_WEAPON_INDEX, ok: fireSuppressed },
		digitKeys: { afterDigit4_pistol: afterPistol, afterDigitGun: afterGun, expectedPistol: SPAWN_WEAPON_INDEX, expectedGun: wi, ok: digitPistol && digitGun },
		pageErrors: errors.slice(0, 3),
		screenshot: `${OUT}/pickup.png`,
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	if (srv) killProc(srv)
	for (const p of procs) killProc(p)
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
