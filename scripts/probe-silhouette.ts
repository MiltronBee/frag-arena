// TRUE BODY SILHOUETTE of the rendered character, in entity-local units.
//
// The GLB's BIND pose is a T/A-pose with the arms flung out — a silhouette no player
// ever presents in game. So this samples the actual LOCOMOTION clips, CPU-skinned,
// and takes the widest radius per 5cm height band across all of them. That envelope
// is what the server's hit volume has to cover.
//
//   npx tsx scripts/probe-silhouette.ts            # animated (default)
//   BINDPOSE=1 npx tsx scripts/probe-silhouette.ts # bind pose, for contrast
import * as BABYLON from '../common/babylon.node.js'
import '@babylonjs/loaders/glTF/index.js'
import http from 'http'
import fs from 'fs'
import path from 'path'
import XHR from 'xhr2'
global.XMLHttpRequest = XHR

const SCALE = 0.577      // assetManifest playerBody.scale
const FEET_Y = -0.50     // feet sit at entity centre - 0.50 (yOffsetMeshMap)
const ROOT = path.resolve(process.env.HOME, 'unreal/public')
const PORT = 8123

// the server hit volume (server/lagCompensatedHitscanCheck.js)
const CAP_A = Number(process.env.CAP_A || -0.30)
const CAP_B = Number(process.env.CAP_B || 0.30)
const CAP_R = Number(process.env.CAP_R || 0.36)
const ZONES = [
	{ name: 'head', cy: 0.47, r: 0.13 },
	{ name: 'torso', cy: 0.15, r: 0.28 },
	{ name: 'legs', cy: -0.28, r: 0.26 },
]
const volumeRadius = y => {
	let best = 0
	if (y >= CAP_A && y <= CAP_B) best = CAP_R
	else {
		const h = y < CAP_A ? CAP_A - y : y - CAP_B
		if (h < CAP_R) best = Math.sqrt(CAP_R * CAP_R - h * h)
	}
	for (const z of ZONES) {
		const dy = Math.abs(y - z.cy)
		if (dy < z.r) { const r = Math.sqrt(z.r * z.r - dy * dy); if (r > best) best = r }
	}
	return best
}

const main = async () => {
const server = http.createServer((req, res) => {
	const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
	if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf') }
	res.writeHead(200); fs.createReadStream(f).pipe(res)
})
await new Promise(r => server.listen(PORT, r))

// headless: never auto-start the GLB's animation groups (no render loop here, and
// AnimationGroup.start trips over the absent target under NullEngine)
BABYLON.SceneLoader.OnPluginActivatedObservable.add(loader => {
	if (loader.name === 'gltf') loader.animationStartMode = 0
})

const engine = new BABYLON.NullEngine()
const scene = new BABYLON.Scene(engine)
new BABYLON.FreeCamera('cam', new BABYLON.Vector3(0, 1, -5), scene) // scene.render() needs one, even headless
const res = await BABYLON.SceneLoader.ImportMeshAsync(
	'', 'http://localhost:' + PORT + '/assets/characters/', 'hero_male.glb', scene)

const skinned = res.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
skinned.forEach(m => { m.computeBonesUsingShaders = false })
const skeletons = (res.skeletons && res.skeletons.length) ? res.skeletons : scene.skeletons

const WANT = (process.env.CLIPS || 'Idle_Loop,Jog_Fwd_Loop,Jog_Bwd_Loop,Jog_Left_Loop,Jog_Right_Loop').split(',')
const groups = scene.animationGroups.filter(g => WANT.indexOf(g.name) !== -1)
console.log('clips in GLB : ' + scene.animationGroups.map(g => g.name).join(', '))

const FRAMES = 10
const poses = []
if (process.env.BINDPOSE === '1' || groups.length === 0) {
	poses.push(null)
	console.log('sampling     : BIND POSE only')
} else {
	groups.forEach(g => {
		for (let i = 0; i < FRAMES; i++) poses.push({ g: g, f: g.from + ((g.to - g.from) * i) / FRAMES })
	})
	console.log('sampling     : ' + groups.map(g => g.name).join(', ') + ' @ ' + FRAMES + ' frames each')
}

// AnimationGroup.start needs a live animatable pipeline that NullEngine + a paused
// scene don't provide (it dies setting weight on an undefined animatable). Evaluate
// the curves DIRECTLY instead: each targetedAnimation knows its target node and
// property; write the sampled value, then let render() rebuild matrices + skinning.
const applyPose = pose => {
	if (!pose) return
	pose.g.targetedAnimations.forEach(ta => {
		const v = ta.animation.evaluate(pose.f)
		const prop = ta.animation.targetProperty
		if (prop === 'rotationQuaternion') ta.target.rotationQuaternion = v.clone ? v.clone() : v
		else if (prop === 'position') ta.target.position = v.clone ? v.clone() : v
		else if (prop === 'scaling') ta.target.scaling = v.clone ? v.clone() : v
	})
	scene.meshes.forEach(m => m.computeWorldMatrix(true))
	if (skeletons) skeletons.forEach(sk => { if (sk.prepare) sk.prepare() })
	scene.render()
}
// computeBonesUsingShaders=false makes scene.render() CPU-skin the mesh IN PLACE
// (applySkeleton from cached source positions), so the plain vertex buffer is already
// the posed body. getPositionData(true,...) on top of that would skin it AGAIN —
// double-transforming every vertex (measured: it 'grew' the body to 1.28m tall with
// 0.7m arms). Read the buffer as-is.
const posOf = m => m.getVerticesData(BABYLON.VertexBuffer.PositionKind)

// pass 1 on the first pose: establish the model's own feet/head in model units
applyPose(poses[0])
let lo = 1e9, hi = -1e9
skinned.forEach(m => {
	const pos = posOf(m); if (!pos) return
	const wm = m.computeWorldMatrix(true)
	const v = new BABYLON.Vector3()
	for (let i = 0; i < pos.length; i += 3) {
		BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v)
		if (v.y < lo) lo = v.y
		if (v.y > hi) hi = v.y
	}
})
console.log('raw height   : ' + (hi - lo).toFixed(3) + ' units -> ' + ((hi - lo) * SCALE).toFixed(3) + ' after scale ' + SCALE)

// pass 2: widest radius per height band, across every sampled pose
const BAND = 0.05
const bands = new Map()
let maxR = 0, topY = -1e9, botY = 1e9
poses.forEach(pose => {
	applyPose(pose)
	skinned.forEach(m => {
		const pos = posOf(m); if (!pos) return
		const wm = m.computeWorldMatrix(true)
		const v = new BABYLON.Vector3()
		for (let i = 0; i < pos.length; i += 3) {
			BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(pos[i], pos[i + 1], pos[i + 2], wm, v)
			const y = (v.y - lo) * SCALE + FEET_Y
			const r = Math.hypot(v.x * SCALE, v.z * SCALE)
			const key = Math.round(Math.floor(y / BAND) * BAND * 1000) / 1000
			const cur = bands.get(key)
			if (cur === undefined || r > cur) bands.set(key, r)
			if (r > maxR) maxR = r
			if (y > topY) topY = y
			if (y < botY) botY = y
		}
	})
})
console.log('entity-local : body spans y ' + botY.toFixed(3) + ' .. ' + topY.toFixed(3) + ', max radius ' + maxR.toFixed(3))
console.log('hit volume   : capsule a=' + CAP_A + ' b=' + CAP_B + ' r=' + CAP_R + ' UNION the 3 zone spheres\n')

console.log('  height     body    hitvol   verdict')
let uncovered = 0, worst = null
const keys = Array.from(bands.keys()).sort((a, b) => b - a)
keys.forEach(k => {
	const yMid = k + BAND / 2
	const body = bands.get(k)
	const vol = volumeRadius(yMid)
	const ok = vol >= body - 1e-6
	if (!ok) {
		uncovered++
		const deficit = body - vol
		if (!worst || deficit > worst.deficit) worst = { y: yMid, body: body, vol: vol, deficit: deficit }
	}
	console.log('  y' + (yMid >= 0 ? '+' : '-') + Math.abs(yMid).toFixed(3) + '   ' + body.toFixed(3)
		+ '   ' + vol.toFixed(3) + '   ' + (ok ? 'covered' : 'EXPOSED by ' + (body - vol).toFixed(3) + 'm'))
})
console.log('\n' + (keys.length - uncovered) + '/' + keys.length + ' height bands fully covered')
if (worst) console.log('worst exposure: ' + worst.deficit.toFixed(3) + 'm of body outside the hit volume at y'
	+ worst.y.toFixed(2) + ' (body r=' + worst.body.toFixed(3) + ', volume r=' + worst.vol.toFixed(3) + ')')
else console.log('every part of the rendered body, in every sampled pose, is inside the server hit volume')
server.close()
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
