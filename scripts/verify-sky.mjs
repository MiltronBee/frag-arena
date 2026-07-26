// VERIFY THE PER-MAP SKY — one map at a time, from the player's own eye.
//
// For each map id in MAPS (default: every map in ROTATION) this boots the real server on
// that map, joins with the real client, deploys, then reads the sky bodies BACK OUT of the
// live scene (renderer.skyVariant + renderer.skyBodies) and, from the player's actual eye
// position, shoots:
//   <map>-framed.png  aim computed to fit every declared body in one frame
//   <map>-eye.png     the same yaw at pitch 0 — what a player sees looking at the horizon
//   <map>-up.png      the same yaw pitched +25deg — catches bodies high in the sky
// and prints, per body: apparent radius, centre separation from every other body, the
// limb-to-limb gap, the far-limb distance against the camera's maxZ, and whether the
// centre lands inside the frame. Geometry claims in SKY_VARIANTS' comments are checked
// against these numbers, not against a hope.
//
//   node scripts/verify-sky.mjs                          # all of ROTATION
//   MAPS=visage,dm_hex2 node scripts/verify-sky.mjs       # a subset
//   SKY=luna MAPS=visage node scripts/verify-sky.mjs      # force a variant (?sky=)
//
// Reuses an already-running vite on PROBE_VITE_PORT (default 8080) instead of starting a
// second one; boots/kills ONLY the game server (:8079 nengi, :8078 /mapinfo).
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import puppeteer from 'puppeteer-core'
import { ROTATION } from '../common/mapRegistry.js'

const OUT = process.env.HOME + '/unreal/_work/sky-shots'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const VITE = process.env.PROBE_VITE_PORT || '8080'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const MAPS = (process.env.MAPS || ROTATION.map(r => r.mapId).join(',')).split(',').filter(Boolean)
const DEG = 180 / Math.PI

const portBusy = port => new Promise(res => {
	const s = net.createConnection({ port: +port, host: '127.0.0.1' })
	s.once('connect', () => { s.destroy(); res(true) })
	s.once('error', () => res(false))
})
// Only ever the game server's own two ports — never vite's.
const freeServerPorts = async () => {
	spawn('bash', ['-c', 'fuser -k 8079/tcp 8078/tcp 2>/dev/null; true'], { stdio: 'ignore' })
	await sleep(800)
}

if (!await portBusy(VITE)) { console.error(`no vite on :${VITE} — start one: npx vite --port ${VITE} --strictPort`); process.exit(1) }

const browser = await puppeteer.launch({
	executablePath: CHROME, headless: 'new',
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1280,720'],
})

const report = []
for (const mapId of MAPS) {
	await freeServerPorts()
	const srv = spawn('npx', ['tsx', 'server/serverMain.js'],
		{ env: { ...process.env, MAP: mapId, BOT_FILL: '0' }, cwd: process.env.HOME + '/unreal', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
	srv.stdout.on('data', d => { const s = d.toString(); if (/error|throw/i.test(s)) process.stdout.write(`[srv] ${s}`) })
	srv.stderr.on('data', d => process.stderr.write(`[srv!] ${d}`))
	let page = null
	try {
		for (let i = 0; i < 40 && !await portBusy(8079); i++) await sleep(500)
		page = await browser.newPage()
		await page.setViewport({ width: 1280, height: 720 })
		const errs = []
		page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
		page.on('console', m => { const t = m.text(); if (/\[sky\]/.test(t)) console.log(`  ${t}`) })
		const url = `http://localhost:${VITE}/${process.env.SKY ? '?sky=' + process.env.SKY : ''}`
		await page.goto(url, { waitUntil: 'domcontentloaded' })
		await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator._connectionState === "connected"', { timeout: 60000 })
		await page.evaluate(() => window.gameClient.simulator.requestDeploy())
		await page.waitForFunction('window.gameClient.simulator.myRawEntity', { timeout: 60000 })
		await sleep(2500)
		// Clear the frame down to the 3D canvas: every DOM overlay off, and the VIEWMODEL
		// camera dropped from activeCameras — the gun + hands own the lower-right third of
		// the frame and a sky shot has to be able to see through it.
		await page.evaluate(() => {
			const st = document.createElement('style')
			st.textContent = '#arena-hud,#entry-overlay,#bg-menu,#crosshair,#hack-feed,#damage-flash,' +
				'#dev-inspector,#splash,#game-menu,#settings-panel,[id*="menu"],[id*="splash"],' +
				'[id*="feed"],[id*="overlay"],[id*="toast"]{display:none !important}'
			document.head.appendChild(st)
			const r = window.gameClient.simulator.renderer
			r.scene.activeCameras = [r.camera]
		})

		// --- read the sky back out of the live scene, plus the real eye position
		const scene = await page.evaluate(() => {
			const s = window.gameClient.simulator, r = s.renderer
			const bodies = (r.skyBodies || []).map(m => {
				m.computeWorldMatrix(true)
				// LOCAL extendSize * scaling, NOT boundingSphere.radiusWorld: these bodies are
				// rotated (yaw + axial tilt), and radiusWorld is the half-diagonal of the
				// world-space AABB of that rotated box — it overstated a 600-radius Earth as
				// 1367 and made every apparent-size and far-limb number nonsense.
				const bb = m.getBoundingInfo().boundingBox
				return { name: m.name, pos: [m.position.x, m.position.y, m.position.z],
					radius: bb.extendSize.x * m.scaling.x, tris: m.getTotalIndices() / 3 }
			})
			return {
				variant: r.skyVariant, mapId: s.map && s.map.id, bodies,
				cam: [r.camera.position.x, r.camera.position.y, r.camera.position.z],
				fov: r.camera.fov, maxZ: r.camera.maxZ,
				aspect: r.engine.getRenderWidth() / r.engine.getRenderHeight(),
				drawCalls: r.scene.getActiveMeshes().length,
			}
		})

		// --- geometry: apparent size, separations, frame fit (all from the LIVE numbers)
		// All measured from the PLAYER'S EYE — the only vantage that matters. The 'framed'
		// shot below hides the level's own geometry rather than flying the camera out of the
		// map: several maps (Hex][, Baroque) are enclosed, so any fixed "above the arena"
		// vantage ends up inside a ceiling and shoots a wall.
		const cam = scene.cam
		// LIVE fov (Simulator overrides the renderer's 1.0 rad with the player's FOV
		// setting: index.html's slider, 70-120 deg VERTICAL, default 95) and, alongside it,
		// the NARROWEST setting a player can choose — that is the frame a sky must fit in.
		const half = { v: scene.fov / 2 * DEG, h: Math.atan(Math.tan(scene.fov / 2) * scene.aspect) * DEG }
		const tight = { v: 35, h: Math.atan(Math.tan(35 / DEG) * scene.aspect) * DEG }
		const B = scene.bodies.map(b => {
			const d = [b.pos[0] - cam[0], b.pos[1] - cam[1], b.pos[2] - cam[2]]
			const dist = Math.hypot(...d)
			return { ...b, dist, dir: d.map(v => v / dist),
				appR: Math.asin(Math.min(1, b.radius / dist)) * DEG,
				yaw: Math.atan2(d[0], d[2]) * DEG, pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) * DEG,
				farLimb: dist + b.radius }
		})
		// aim = midpoint of the yaw/pitch extremes, so every centre is as central as possible
		const mid = a => (Math.min(...a) + Math.max(...a)) / 2
		const aimYaw = mid(B.map(b => b.yaw)), aimPitch = mid(B.map(b => b.pitch))
		const lines = [`MAP ${scene.mapId}  sky='${scene.variant}'  ${B.length} bodies`,
			`  player eye [${scene.cam.map(v => v.toFixed(1))}]  fov=${(scene.fov * DEG).toFixed(0)}deg halfFOV h=${half.h.toFixed(1)} v=${half.v.toFixed(1)}` +
			`  (tightest player fov 70: h=${tight.h.toFixed(1)} v=${tight.v.toFixed(1)})  maxZ=${scene.maxZ}`]
		for (const b of B) {
			const dy = b.yaw - aimYaw, dp = b.pitch - aimPitch
			const inFrame = Math.abs(dy) <= tight.h && Math.abs(dp) <= tight.v
			lines.push(`  ${b.name.padEnd(8)} r=${b.radius.toFixed(0)} dist=${b.dist.toFixed(0)} appR=${b.appR.toFixed(1)}deg ` +
				`yaw=${b.yaw.toFixed(1)} pitch=${b.pitch.toFixed(1)} tris=${b.tris} ` +
				`farLimb=${b.farLimb.toFixed(0)}${b.farLimb > scene.maxZ ? ' *** CLIPPED BY maxZ ***' : ' (ok)'} ` +
				`framed=${inFrame ? 'yes' : 'NO (' + dy.toFixed(0) + ',' + dp.toFixed(0) + ')'}`)
		}
		for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
			const dot = B[i].dir.reduce((s, v, k) => s + v * B[j].dir[k], 0)
			const sep = Math.acos(Math.max(-1, Math.min(1, dot))) * DEG
			const gap = sep - B[i].appR - B[j].appR
			lines.push(`  pair ${B[i].name}/${B[j].name}: sep=${sep.toFixed(1)}deg limbGap=${gap.toFixed(1)}deg` +
				(gap < 3 ? '  *** LIMBS OVERLAP/TOUCH ***' : ''))
		}
		// --- IS THIS SKY EVER SEEN? A sky is only worth its texture bytes if the level lets
		// players look at it. Sample the map's floor on a grid (cast down from above and take
		// the DEEPEST hit — the first hit is a roof, and a point on a roof trivially sees
		// everything), stand at eye height on each sample, and count how many of them have a
		// clear line of sight straight up and to each declared body. Mesh-map geometry is
		// isPickable=false on purpose (server owns collision), so the pick predicate tests
		// checkCollisions instead — same trick _isSolidWorld uses.
		const los = await page.evaluate((bodies) => {
			const r = window.gameClient.simulator.renderer, sc = r.scene
			// The dev bundle is ESM with a curated barrel — there is no window.BABYLON to
			// reach for. Pull the two classes off live instances instead.
			const V3 = r.camera.position.constructor, RayC = r.camera.getForwardRay(1).constructor
			const B = { Vector3: V3, Ray: RayC }
			const solid = m => m.checkCollisions && m.isEnabled() && m.getTotalVertices() > 0
			let min = null, max = null
			for (const m of sc.meshes) {
				if (!solid(m)) continue
				const bb = m.getBoundingInfo().boundingBox
				const lo = bb.minimumWorld, hi = bb.maximumWorld
				min = min ? B.Vector3.Minimize(min, lo) : lo.clone()
				max = max ? B.Vector3.Maximize(max, hi) : hi.clone()
			}
			if (!min) return null
			const N = 12, eyeH = 1.7, hit = (o, d, len) => {
				const p = sc.pickWithRay(new B.Ray(o, d.normalize(), len), solid)
				return p && p.hit ? p : null
			}
			const eyes = []
			for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
				const x = min.x + (max.x - min.x) * (i + 0.5) / N, z = min.z + (max.z - min.z) * (j + 0.5) / N
				const picks = sc.multiPickWithRay(new B.Ray(new B.Vector3(x, max.y + 20, z), new B.Vector3(0, -1, 0), (max.y - min.y) + 60), solid)
				if (!picks || !picks.length) continue
				let deepest = picks[0]
				for (const p of picks) if (p.pickedPoint.y < deepest.pickedPoint.y) deepest = p
				eyes.push(new B.Vector3(deepest.pickedPoint.x, deepest.pickedPoint.y + eyeH, deepest.pickedPoint.z))
			}
			const clear = { up: 0, bodies: bodies.map(() => 0) }
			for (const e of eyes) {
				if (!hit(e, new B.Vector3(0, 1, 0), 3000)) clear.up++
				// Aim at the body's UPPER LIMB (centre + radius up), not its centre. Every
				// primary body here sits ~18deg BELOW the horizon, so a ray to its centre goes
				// into the floor and reports "invisible" for a planet whose limb is plainly
				// filling half the screen — which is exactly what the first version of this
				// check claimed about Earth on Visage.
				bodies.forEach((b, k) => {
					const d = new B.Vector3(b[0] - e.x, b[1] + b[3] - e.y, b[2] - e.z)
					if (!hit(e, d, d.length())) clear.bodies[k]++
				})
			}
			return { samples: eyes.length, clear }
		}, scene.bodies.map(b => [...b.pos, b.radius]))
		if (los) {
			const pct = n => (100 * n / los.samples).toFixed(0) + '%'
			lines.push(`  sky visibility (LOWER BOUND — samples the DEEPEST floor under each grid cell, so\n  basements count) over ${los.samples} samples: straight up ${pct(los.clear.up)}, ` +
				B.map((b, k) => `${b.name} limb ${pct(los.clear.bodies[k])}`).join(', '))
		}
		console.log(lines.join('\n'))
		report.push(lines.join('\n'))

		// --- shoot it. 'framed' judges the BODIES (clear vantage, both/all in one frame);
		// '-eye' and '-up' judge whether a player standing on the level can actually SEE
		// them — level geometry in the way, at eye height and looking up.
		const shots = [
			{ tag: 'eye', at: cam, yaw: aimYaw, pitch: 0 },
			{ tag: 'up', at: cam, yaw: aimYaw, pitch: 28 },
			{ tag: 'framed', at: cam, yaw: aimYaw, pitch: aimPitch, hideWorld: true },
		]
		for (const s of shots) {
			if (s.hideWorld) await page.evaluate(() => {
				const r = window.gameClient.simulator.renderer
				const keep = new Set([...(r.skyBodies || []), r.skydome && r.skydome.mesh].filter(Boolean))
				for (const m of r.scene.meshes) if (!keep.has(m) && m.parent !== (r.skydome && r.skydome.mesh)) m.isVisible = false
			})
			// freeze the sim's camera rebase, then re-stamp the pose every pumped frame
			for (let i = 0; i < 24; i++) {
				await page.evaluate((s) => {
					const sim = window.gameClient.simulator, c = sim.renderer.camera
					sim._camFreeze = true
					c.position.set(s.at[0], s.at[1], s.at[2])
					c.rotation.set(-s.pitch * Math.PI / 180, s.yaw * Math.PI / 180, 0)
					try { sim.renderer.scene.render() } catch (e) {}
				}, s)
				await sleep(16)
			}
			const f = `${OUT}/${mapId}-${s.tag}.png`
			await page.screenshot({ path: f })
			console.log(`  shot ${f}`)
		}
		if (errs.length) console.log('  pageErrors', errs.slice(0, 3))
	} catch (err) {
		console.error(`MAP ${mapId} FAILED:`, err.message)
		report.push(`MAP ${mapId} FAILED: ${err.message}`)
	} finally {
		if (page) await page.close().catch(() => {})
		try { process.kill(-srv.pid, 'SIGKILL') } catch { try { srv.kill('SIGKILL') } catch {} }
		await freeServerPorts()
	}
}
await browser.close().catch(() => {})
console.log('\n===== SUMMARY =====\n' + report.join('\n') + `\nOUT ${OUT}`)
process.exit(0)
