// ============================================================================
// _variant-generate.mjs — per-cluster texture VARIANTS for the mesh-map rotation.
//
// For each of the 5 rotation maps, pick the TOP-4 eligible (diffuse-textured,
// not sky/additive) materials by OBJ face coverage (mirrors make-texture-gallery
// coverage math) and generate 3 FAITHFUL variants per texture with Gemini
// (gemini-3.1-flash-image, same image-to-image pattern as gemini-texture-
// remaster.mjs). "Faithful" = SAME material/palette/motif, only the fine surface
// detail is re-rolled — the goal is breaking tile-for-tile repetition, NOT
// restyling. Existing 'faithful' Grove candidates are reused verbatim where they
// cover a chosen material (one fewer API call). Identical textures shared across
// maps (md5) reuse the first generation.
//
// Output (live convention: 512px WebP q80 next to the base texture, v1 = base):
//   public/assets/maps/<Map>/textures/<TexName>.v2.webp / .v3.webp / .v4.webp
//   public/assets/maps/<Map>/textures/variants.json   { "<TexName>": <extraCount> }
//
// Budget guard: 1 attempt + 1 retry per variant; on repeated failure SKIP the
// texture and record it — never retry-storm the API.
//
//   node scripts/_variant-generate.mjs                 # all 5 maps
//   node scripts/_variant-generate.mjs grove           # one map
//   node scripts/_variant-generate.mjs --test          # 1 texture, 1 variant (API smoke)
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// -- API key: echostore is the LIVE path (~/solSoccer is dead) ----------------
const ENV_PATH = '/mnt/echostore/solSoccer/.env'
const envRaw = fs.readFileSync(ENV_PATH, 'utf8')
const key =
	envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
	envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`no ALT or GEMINI_API_KEY in ${ENV_PATH}`)

const MODEL = 'gemini-3.1-flash-image'
const ROOT = path.resolve(process.env.HOME, 'unreal')
const MAPS_DIR = path.join(ROOT, 'public/assets/maps')
const CAND_DIR = path.join(ROOT, 'public/dev/tex-candidates')

// map id -> { dir (folder name), base (obj/mtl basename) }
const MAP_FILES = {
	grove: { dir: 'DM-W-Grove', base: 'DM-W-Grove-2025' },
	dm_gantry162: { dir: 'DM-Gantry16][', base: 'DM-Gantry16][' },
	dm_somnus: { dir: 'DM-Somnus', base: 'DM-Somnus' },
	dm_baroque: { dir: 'DM-Baroque', base: 'DM-Baroque' },
	visage: { dir: 'CTF-Visage', base: 'CTF-Visage' },
}
// generation order: baroque before visage so the shared ShaneChurch textures are
// generated once and reused via the md5 cache.
const MAP_ORDER = ['grove', 'dm_gantry162', 'dm_somnus', 'dm_baroque', 'visage']

const TOP_N = 4          // materials per map
const VARIANTS = 3       // faithful variants per texture (v2, v3, v4)
// sky/additive/FX-glow materials never get variants (they are not opaque diffuse
// surfaces; the client re-checks real material props before it ever splits one).
const SKIP_RE = /\bsky\b|skybox|skydome|_fan|\bEFX\b|wfall|water|flame|fire\b|corona|lava|energy|glass|\blight\b|blitz|\bzap\b|scroll|panner|invisible|null|trigger|forcefield/i

// three faithful re-rolls — same look, different fine detail. Higher temperature
// on later variants so v2/v3/v4 diverge from each other, not just from the base.
const REROLLS = [
	{ tag: 'v2', temp: 0.9, hint: 'Re-roll the fine surface detail: shift where the grain, speckle, micro-scratches, dirt and small blemishes sit.' },
	{ tag: 'v3', temp: 1.0, hint: 'Re-roll the fine surface detail differently again: new grain direction, new scatter of wear, scuffs and stains in different places.' },
	{ tag: 'v4', temp: 1.05, hint: 'Re-roll the fine surface detail a third distinct way: fresh micro-noise, different placement of chips, smudges and discoloration.' },
]

function sh(cmd, args) { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }) }

function toPngB64(webpPath) {
	const tmp = `/tmp/_var_in_${process.pid}.png`
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', webpPath, tmp])
	const b = fs.readFileSync(tmp).toString('base64')
	fs.rmSync(tmp, { force: true })
	return b
}

// PNG/other bytes -> 512x512 WebP q80 (live convention) at dest
function toWebp512(buf, dest) {
	const tmpIn = `/tmp/_var_out_${process.pid}.png`
	fs.writeFileSync(tmpIn, buf)
	// cwebp: -q 80, -resize 512 512 (square). q80 matches the shipped set.
	sh('cwebp', ['-quiet', '-q', '80', '-resize', '512', '512', tmpIn, '-o', dest])
	fs.rmSync(tmpIn, { force: true })
}

async function geminiVariant(b64, styleHint, temp) {
	const prompt = `This is a tiling albedo texture from a 1999 first-person-shooter level (512x512). Produce a FAITHFUL variant: keep the EXACT same material, color palette, motif, structure and tiling scale so it is visually indistinguishable in kind from the original — this is NOT a restyle. ${styleHint}
The result must NOT match the original tile-for-tile so that placing several side by side breaks the repeated-texture look.
HARD RULES: must tile seamlessly (edges wrap); square image; flat albedo only — no baked lighting, no shadows, no highlights from outside the surface; no text, no watermark, no border, no vignette.`
	const body = {
		contents: [{ role: 'user', parts: [
			{ inlineData: { mimeType: 'image/png', data: b64 } },
			{ text: prompt },
		] }],
		generationConfig: { responseModalities: ['IMAGE'], temperature: temp },
	}
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
	const json = await res.json()
	const img = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData
	if (!img) throw new Error('no image in response: ' + JSON.stringify(json).slice(0, 200))
	return Buffer.from(img.data, 'base64')
}

// coverage: face count per material (mirror make-texture-gallery.py)
function analyzeMap(mid) {
	const { dir, base } = MAP_FILES[mid]
	const md = path.join(MAPS_DIR, dir)
	const mtl = fs.readFileSync(path.join(md, base + '.mtl'), 'utf8')
	const obj = fs.readFileSync(path.join(md, base + '.obj'), 'utf8')
	const tex = {}
	let cur = null
	for (const line of mtl.split('\n')) {
		if (line.startsWith('newmtl ')) cur = line.slice(7).trim()
		else if (line.startsWith('map_Kd ') && cur) tex[cur] = line.slice(7).trim()
	}
	const faces = {}
	cur = null
	for (const line of obj.split('\n')) {
		if (line.startsWith('usemtl ')) cur = line.slice(7).trim()
		else if (line.startsWith('f ') && cur) faces[cur] = (faces[cur] || 0) + 1
	}
	const total = Object.values(faces).reduce((a, b) => a + b, 0)
	const rows = Object.entries(tex).map(([mat, rel]) => ({
		mat, rel, texName: path.basename(rel).replace(/\.[^.]+$/, ''),
		faces: faces[mat] || 0, pct: total ? 100 * (faces[mat] || 0) / total : 0,
	})).filter(r => !SKIP_RE.test(r.mat) && !SKIP_RE.test(r.texName))
	rows.sort((a, b) => b.faces - a.faces)
	// dedupe by texture (materials can share a map_Kd), keep highest coverage
	const seen = new Set(), picks = []
	for (const r of rows) {
		if (seen.has(r.texName)) continue
		seen.add(r.texName); picks.push(r)
		if (picks.length >= TOP_N) break
	}
	return { md, picks }
}

const md5cache = new Map() // texture md5 -> { v2: <bytes>, v3, v4 } reuse across maps
const report = {}

async function processTexture(mid, md, r, testOnly) {
	const src = path.join(md, 'textures', r.texName + '.webp')
	if (!fs.existsSync(src)) { console.error(`  SKIP ${r.texName}: base texture missing`); return { skipped: true } }
	const hash = crypto.createHash('md5').update(fs.readFileSync(src)).digest('hex')
	const b64 = toPngB64(src)
	const cached = md5cache.get(hash) || {}
	const outcome = { texName: r.texName, pct: +r.pct.toFixed(1), generated: 0, reused: 0, skipped: 0, made: [] }

	const wanted = testOnly ? REROLLS.slice(0, 1) : REROLLS
	for (const rr of wanted) {
		const dest = path.join(md, 'textures', `${r.texName}.${rr.tag}.webp`)
		if (fs.existsSync(dest)) { outcome.reused++; outcome.made.push(rr.tag); continue }

		// 1) reuse identical-texture generation from an earlier map (md5)
		if (cached[rr.tag]) {
			toWebp512(cached[rr.tag], dest)
			outcome.reused++; outcome.made.push(rr.tag)
			console.log(`  reuse(md5) ${r.texName}.${rr.tag}`)
			continue
		}
		// 2) reuse an existing pilot 'faithful' Grove candidate for the FIRST variant
		if (rr.tag === 'v2') {
			const cand = path.join(CAND_DIR, r.mat, 'faithful.png')
			if (fs.existsSync(cand)) {
				const buf = fs.readFileSync(cand)
				toWebp512(buf, dest)
				cached.v2 = buf; md5cache.set(hash, cached)
				outcome.reused++; outcome.made.push(rr.tag)
				console.log(`  reuse(pilot) ${r.texName}.v2 <- tex-candidates/${r.mat}/faithful.png`)
				continue
			}
		}
		// 3) generate (1 attempt + 1 retry, then skip — no retry-storm)
		let buf = null
		for (let attempt = 1; attempt <= 2 && !buf; attempt++) {
			try {
				buf = await geminiVariant(b64, rr.hint, rr.temp)
			} catch (e) {
				console.error(`  ${attempt === 1 ? 'FAIL' : 'RETRY-FAIL'} ${r.texName}.${rr.tag}: ${e.message}`)
				if (attempt < 2) await new Promise(res => setTimeout(res, 1500))
			}
		}
		if (!buf) { outcome.skipped++; continue }
		toWebp512(buf, dest)
		cached[rr.tag] = buf; md5cache.set(hash, cached)
		outcome.generated++; outcome.made.push(rr.tag)
		console.log(`  gen ${r.texName}.${rr.tag} (${(buf.length / 1024).toFixed(0)}KB src)`)
	}
	return outcome
}

async function main() {
	const args = process.argv.slice(2)
	const testOnly = args.includes('--test')
	const mapArgs = args.filter(a => !a.startsWith('--'))
	const maps = mapArgs.length ? mapArgs : MAP_ORDER

	for (const mid of maps) {
		if (!MAP_FILES[mid]) { console.error(`unknown map ${mid}`); continue }
		const { md, picks } = analyzeMap(mid)
		console.log(`\n==== ${mid} — top ${picks.length}: ${picks.map(p => `${p.texName}(${p.pct.toFixed(1)}%)`).join(', ')}`)
		report[mid] = { picks: [] }
		const usePicks = testOnly ? picks.slice(0, 1) : picks
		for (const r of usePicks) {
			const o = await processTexture(mid, md, r, testOnly)
			report[mid].picks.push(o)
		}
		// emit manifest: TexName -> number of extra variants present on disk
		const manifest = {}
		for (const r of picks) {
			let n = 0
			for (const rr of REROLLS) if (fs.existsSync(path.join(md, 'textures', `${r.texName}.${rr.tag}.webp`))) n++
			if (n > 0) manifest[r.texName] = n
		}
		if (!testOnly) {
			fs.writeFileSync(path.join(md, 'textures', 'variants.json'), JSON.stringify(manifest, null, '\t') + '\n')
			console.log(`  wrote variants.json: ${Object.keys(manifest).length} textures`)
		}
	}
	console.log('\n===== SUMMARY =====')
	console.log(JSON.stringify(report, null, 2))
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
