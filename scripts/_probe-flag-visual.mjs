// CTF FLAG-VISUAL probe. Boots its OWN server (MAP=visage — the CTF map — BOT_FILL=2)
// + vite on :8080, joins, and asserts the real UT99 flag model REPLACED the tinted
// placeholder box (createFactories.attachFlagModel), i.e.
//   - exactly 2 Flag entities in simulator._flags;
//   - each has entity._flagModel set + entity._flagAnim.isPlaying === true;
//   - the morph wave is LIVE: a morph-target influence changes across ~500ms;
//   - team-0 flag's material albedoTexture.url carries 'Prop_Flag_red', team-1's does NOT;
//   - the placeholder box is hidden (entity.mesh.material.alpha === 0);
//   - zero page errors.
// plus one close-up screenshot for the eyeball check (base/floor fit).
//
//   node scripts/_probe-flag-visual.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'

const OUT = process.env.HOME + '/unreal/_work/flag-visual'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE_PORT = process.env.PROBE_VITE_PORT || '8080'
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
try {
	boot('npx', ['tsx', 'server/serverMain.js'], { MAP: 'visage', BOT_FILL: '2' }, 'server')
	reuseVite = await portBusy(VITE_PORT)
	if (!reuseVite) boot('npx', ['vite', '--port', VITE_PORT, '--strictPort'], {}, 'vite')
	await sleep(7000)

	browser = await puppeteer.launch({
		executablePath: '/usr/bin/google-chrome',
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
	})
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
	await sleep(6000) // flag GLBs import async + red skin texture loads

	// wait until both flags have their imported model mounted
	await page.waitForFunction(`(() => {
		const flags = [...window.gameClient.simulator._flags.values()]
		return flags.length >= 2 && flags.every(f => f._flagModel && f._flagAnim)
	})()`, { timeout: 60000 })

	// helper: read the flag's cloth-wave state as the SUM of |influence| across ALL
	// morph targets (the pole+cloth mesh carries the morphTargetManager the flag_wave
	// group animates). Summing all 23 targets avoids a false-negative when a single
	// sampled target happens to sit at 0 at both instants.
	const sampleInfluence = () => page.evaluate(() => {
		const out = {}
		window.gameClient.simulator._flags.forEach((f) => {
			let sum = null
			const root = f._flagModel
			const meshes = root ? [root, ...root.getChildMeshes()] : []
			for (const m of meshes) {
				const mtm = m.morphTargetManager
				if (mtm && mtm.numTargets > 0) {
					sum = 0
					for (let i = 0; i < mtm.numTargets; i++) sum += Math.abs(mtm.getTarget(i).influence)
					break
				}
			}
			out[f.nid] = sum
		})
		return out
	})

	// the flag_wave is a morph pose-blend that passes through near-flat poses, so a pair
	// of point-samples can both land near 0. Instead sample the influence-sum repeatedly
	// across ~1.4s of driven renders and assert each flag's sum VARIES (max − min) — a
	// live wave sweeps a clear range; a frozen/unbound anim would read a constant.
	const series = {}
	for (let s = 0; s < 12; s++) {
		const snap = await sampleInfluence()
		for (const nid in snap) { (series[nid] = series[nid] || []).push(snap[nid]) }
		for (let i = 0; i < 7; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} }); await sleep(16) }
	}
	const influenceRange = {}
	for (const nid in series) {
		const vals = series[nid].filter((v) => v !== null && v !== undefined)
		influenceRange[nid] = vals.length ? (Math.max(...vals) - Math.min(...vals)) : null
	}

	const audit = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		const flags = [...sim._flags.values()]
		return {
			count: flags.length,
			flags: flags.map((f) => {
				let albedo = null
				const root = f._flagModel
				const meshes = root ? [root, ...root.getChildMeshes()] : []
				for (const m of meshes) {
					const mat = m.material
					if (mat && mat.albedoTexture) { albedo = mat.albedoTexture.url || mat.albedoTexture.name || ''; break }
				}
				return {
					nid: f.nid, team: f.team, state: f.state,
					hasModel: !!f._flagModel,
					animPlaying: !!(f._flagAnim && f._flagAnim.isPlaying),
					animName: f._flagAnim ? f._flagAnim.name : null,
					albedo,
					boxAlpha: f.mesh && f.mesh.material ? f.mesh.material.alpha : null,
				}
			}),
		}
	})

	// close-up screenshot of the nearest flag (freecam hack from _probe-ffa-uniforms)
	const flagPos = await page.evaluate(() => {
		const sim = window.gameClient.simulator
		let best = null, bd = Infinity
		sim._flags.forEach((f) => {
			const d = Math.hypot(f.x - sim.myRawEntity.x, f.z - sim.myRawEntity.z)
			if (d < bd) { bd = d; best = { x: f.x, y: f.y, z: f.z } }
		})
		return best
	})
	if (flagPos) {
		// Freecam hack (from _probe-ffa-uniforms): move the PLAYER ENTITY (the follow-cam
		// anchor) + set the camera, then render. Stand back ~4 units at the flag's CENTRE
		// height (safe — NOT below the base, which trips a void/fall death) and aim a touch
		// below centre so the base + the floor it plants on are both framed for the eyeball.
		await page.evaluate(({ flagPos }) => {
			const s = window.gameClient.simulator
			const e = s.myRawEntity
			const pos = { x: flagPos.x + 4.0, y: flagPos.y, z: flagPos.z + 4.0 }
			e.x = pos.x; e.y = pos.y; e.z = pos.z; e.velX = e.velY = e.velZ = 0
			const cam = s.camera || s.renderer?.camera || s.renderer?.scene?.activeCamera
			if (cam && cam.position) {
				cam.position.set(pos.x, pos.y + 0.4, pos.z)
				const aimY = flagPos.y - 0.4
				const dx = flagPos.x - pos.x, dz = flagPos.z - pos.z
				if ('rotation' in cam) {
					cam.rotation.y = Math.atan2(dx, dz)
					cam.rotation.x = -Math.atan2(aimY - (pos.y + 0.4), Math.hypot(dx, dz))
				}
			}
			;['entry-overlay', 'splash'].forEach(id => { const el = document.getElementById(id); if (el) el.remove() })
			document.body.classList.add('arena-entered')
		}, { flagPos })
		for (let i = 0; i < 40; i++) { await page.evaluate(() => { try { window.gameClient.simulator.renderer.scene.render() } catch (e) {} }); await sleep(16) }
		// re-assert the camera aim + render ONCE more in the SAME microtask as the capture,
		// so no game rAF frame (which re-bases camera.position off the entity) sneaks in and
		// resets the heading between the aim and the screenshot.
		await page.evaluate(({ flagPos }) => {
			const cam = window.gameClient.simulator.renderer.camera
			const pos = { x: flagPos.x + 4.0, y: flagPos.y + 0.4, z: flagPos.z + 4.0 }
			cam.position.set(pos.x, pos.y, pos.z)
			const aimY = flagPos.y - 0.4
			const dx = flagPos.x - pos.x, dz = flagPos.z - pos.z
			cam.rotation.y = Math.atan2(dx, dz)
			cam.rotation.x = -Math.atan2(aimY - pos.y, Math.hypot(dx, dz))
			window.gameClient.simulator.renderer.scene.render()
		}, { flagPos })
		await page.screenshot({ path: `${OUT}/flag-closeup.png` })
	}

	// objective base/floor-fit readout: the imported model's world-space bbox min-Y vs the
	// flag entity origin (the model base is parented at local y = −1.0, so world base ≈ entity.y − 1.0).
	const fit = await page.evaluate(() => {
		return [...window.gameClient.simulator._flags.values()].map((f) => {
			const root = f._flagModel
			const meshes = root ? [root, ...root.getChildMeshes()].filter((m) => m.getBoundingInfo) : []
			let minY = Infinity, maxY = -Infinity
			meshes.forEach((m) => {
				m.computeWorldMatrix(true)
				const bb = m.getBoundingInfo().boundingBox
				minY = Math.min(minY, bb.minimumWorld.y)
				maxY = Math.max(maxY, bb.maximumWorld.y)
			})
			return { nid: f.nid, team: f.team, entityY: +f.y.toFixed(3), baseWorldY: isFinite(minY) ? +minY.toFixed(3) : null, topWorldY: isFinite(maxY) ? +maxY.toFixed(3) : null }
		})
	})
	console.log('BASE/FLOOR FIT:', JSON.stringify(fit))

	// morph is LIVE if EACH flag's influence-sum swept a clear range over the sampling window
	const morphMoved = audit.flags.every((f) => (influenceRange[f.nid] || 0) > 0.1)
	const team0 = audit.flags.find((f) => f.team === 0)
	const team1 = audit.flags.find((f) => f.team === 1)
	const redOnTeam0 = !!(team0 && team0.albedo && /Prop_Flag_red/.test(team0.albedo))
	const noRedOnTeam1 = !!(team1 && team1.albedo && !/Prop_Flag_red/.test(team1.albedo))
	const twoFlags = audit.count === 2
	const allModels = audit.flags.every((f) => f.hasModel)
	const allPlaying = audit.flags.every((f) => f.animPlaying)
	const boxesHidden = audit.flags.every((f) => f.boxAlpha === 0)

	const ok = twoFlags && allModels && allPlaying && morphMoved && redOnTeam0 && noRedOnTeam1 && boxesHidden && errors.length === 0
	console.log(JSON.stringify({
		count: audit.count,
		flags: audit.flags,
		influenceRange,
		twoFlags, allModels, allPlaying, morphMoved, redOnTeam0, noRedOnTeam1, boxesHidden,
		pageErrors: errors.slice(0, 3),
		screenshot: flagPos ? OUT + '/flag-closeup.png' : null,
		verdict: ok ? 'PASS' : 'FAIL',
	}, null, 2))
	failed = !ok
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
