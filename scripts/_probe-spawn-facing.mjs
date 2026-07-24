// SPAWN-FACING probe. Boots its OWN server (MAP=dm_baroque — a formerly yaw-less
// map, now carrying UT PlayerStart rotations) with BOT_FILL=0 + a vite client on
// :8080, joins with puppeteer and asserts the networked spawn facing:
//   - the server hands the picked spawn's world yaw over in Identity
//   - the client snaps camera.rotation.y to it on spawn (it never rotated before)
//   - that yaw matches mapRegistry's NEAREST SPAWN_POINT converted with the SAME
//     θ_ut->world formula the teleporters use (utYawToWorldYaw)
// Reloads the page ~6 times (a fresh join = a fresh Identity spawn, the sanctioned
// per-cycle reset — background-tab throttling means ONE browser per client). Every
// cycle must match (nearest real yaw within an angle epsilon, or the KEEP sentinel
// path leaving the fresh camera at ~0), at least one cycle must land a non-zero
// authored yaw (proves the wire actually moved the camera), and zero page errors.
//
//   node scripts/_probe-spawn-facing.mjs
import { spawn } from 'child_process'
import net from 'net'
import puppeteer from 'puppeteer-core'
import { mapRecords } from '../common/mapRegistry.js'
import { utYawToWorldYaw } from '../common/teleporterData.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
const MAP = 'dm_baroque'
const CYCLES = 6
const ANGLE_EPS = 0.05          // rad (~2.9°); yaw carries no jitter, so match is near-exact
const KEEP = -999               // TELEPORT_KEEP_YAW: no authored rotation -> camera stays put

// normalized signed angle difference in (-π, π]
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

// mapRegistry spawn set in WORLD units (native * scale) + world yaw for the nearest-
// neighbour lookup. yaw null -> KEEP (the server sends the sentinel; camera unchanged).
const rec = mapRecords[MAP]
const SC = rec.scale || 1
const SPAWNS = rec.SPAWN_POINTS.map(p => ({
	wx: p.x * SC, wz: p.z * SC,
	utYaw: p.yaw,
	wYaw: (p.yaw === null || p.yaw === undefined) ? KEEP : utYawToWorldYaw(p.yaw),
}))

const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})

const procs = []
function boot(cmd, args, env, tag) {
	const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
	p.stdout.on('data', d => { const s = d.toString(); if (/error/i.test(s)) process.stdout.write(`[${tag}] ${s}`) })
	p.stderr.on('data', d => process.stderr.write(`[${tag}!] ${d}`))
	procs.push(p)
	return p
}

let failed = false
let browser = null
let reuseVite = false
const cycles = []
const errors = []
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP, BOT_FILL: '0' }, 'server')
	reuseVite = await portBusy(VITE_PORT)
	if (reuseVite) console.log(`[vite] reusing dev server already on :${VITE_PORT}`)
	else boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	await sleep(7000) // server mesh load + vite ready

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})
	const page = await browser.newPage()
	await page.setViewport({ width: 1280, height: 720 })
	page.on('pageerror', e => errors.push(e.message))

	for (let i = 0; i < CYCLES; i++) {
		// fresh join = fresh Identity spawn. First cycle navigates; the rest reload.
		if (i === 0) await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' })
		else await page.reload({ waitUntil: 'domcontentloaded' })
		await page.waitForFunction(
			'window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"',
			{ timeout: 45000 })
		await page.evaluate(() => window.gameClient.simulator.requestDeploy())
		await page.waitForFunction(
			'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity',
			{ timeout: 45000 })
		await sleep(1500) // let Identity settle (it applies camera.rotation.y before the entity exists)

		const snap = await page.evaluate(() => {
			const sim = window.gameClient.simulator
			const e = sim.myRawEntity
			return { x: e.x, z: e.z, camYaw: sim.renderer.camera.rotation.y, map: sim.map.id }
		})

		// nearest authored spawn by XZ (min pairwise spacing 4.0m >> ±0.6m jitter, so unambiguous)
		let near = null, best = Infinity
		for (const s of SPAWNS) {
			const d = Math.hypot(s.wx - snap.x, s.wz - snap.z)
			if (d < best) { best = d; near = s }
		}
		// KEEP path: no authored rotation -> the fresh page's camera should still read ~0
		const keep = near.wYaw === KEEP
		const target = keep ? 0 : near.wYaw
		const diff = angDiff(snap.camYaw, target)
		const ok = Math.abs(diff) < ANGLE_EPS
		cycles.push({
			map: snap.map, dropDist: +best.toFixed(2),
			camYaw: +snap.camYaw.toFixed(4),
			nearestUtYaw: near.utYaw, expectYaw: keep ? 'KEEP(0)' : +near.wYaw.toFixed(4),
			angleErr: +diff.toFixed(4), keep, ok,
		})
		if (!ok) failed = true
	}

	// prove the wire actually turned the camera at least once (not stuck at 0)
	const movedOnce = cycles.some(c => !c.keep && Math.abs(c.camYaw) > 0.1 && c.ok)
	const allMatch = cycles.every(c => c.ok)
	const noErr = errors.length === 0
	const verdictOk = allMatch && movedOnce && noErr && cycles.length === CYCLES
	console.log(JSON.stringify({
		map: MAP, cycles,
		allMatch, movedOnce, pageErrors: errors.slice(0, 3),
		verdict: verdictOk ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = failed || !verdictOk
} catch (err) {
	console.error('PROBE ERROR:', err.message)
	failed = true
} finally {
	if (browser) await browser.close().catch(() => {})
	for (const p of procs) { try { process.kill(-p.pid) } catch { p.kill('SIGKILL') } }
	await sleep(500)
	spawn('bash', ['-c', `fuser -k 8078/tcp 8079/tcp${reuseVite ? '' : ` ${VITE_PORT}/tcp`} 2>/dev/null; true`])
	await sleep(500)
}
process.exit(failed ? 1 : 0)
