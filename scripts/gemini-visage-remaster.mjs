// Upscale + tiling-variant candidates for CTF-Visage hero surfaces.
// Sibling of gemini-texture-remaster.mjs (hardcoded to DM-W-Grove) — this one
// targets Visage, feeds the HD SOURCE where one exists (a real upscale, not a
// re-detail of the already-downsampled 512), and writes into
// public/textures/candidates/<mat>/ so the /textures triage gallery shows them.
//
// Two goals in one batch: fidelity (modernise the 1999 look) and VARIANTS —
// N rolls of the same faithful lane at temperature, so a big tiling wall can
// spread 2-3 versions across its face and stop reading as one repeated PNG.
// The prompt hard-pins layout/palette/tileability so every roll drops into the
// same UVs.
//   node scripts/gemini-visage-remaster.mjs [N] [material ...]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const ROOT = path.resolve(process.env.HOME, 'unreal')
const MAPDIR = path.join(ROOT, 'public/assets/maps/CTF-Visage')
const HD = path.join(ROOT, 'maps/improved/textures_hd')
const OUTROOT = path.join(ROOT, 'public/textures/candidates')
const MODEL = 'gemini-3.1-flash-image'

// Hero set: the 8 highest face-coverage materials (~72% of the map). Small deco
// is excluded — it appears once, so tiling variation buys nothing there.
const HERO = [
  'UTtech1_Misc_rok2', 'ShaneChurch_archeBloks2', 'ShaneChurch_BrownBase',
  'UTtech1_Misc_UTdirt1', 'SkyCity_Base_sMarblbs', 'SkyCity_Base_sOrnSton',
  'ShaneChurch_BrownTrim2', 'SkyCity_Wall_sHiWal2b',
]

const argN = parseInt(process.argv[2], 10)
const N = Number.isFinite(argN) ? argN : 3
const mats = process.argv.slice(3).length ? process.argv.slice(3) : HERO

const PROMPT = `This is a seamless tiling wall/floor texture from a 1999 first-person-shooter arena
(Unreal Tournament). Remaster it to 2026 fidelity: same material, same motif, same colour palette,
same tile layout — just far sharper, with believable surface relief, fine grain, subtle wear and
crisp definition. A player should recognise it as the same surface, only modern.

HARD RULES:
- MUST tile seamlessly: the left edge continues into the right, the top into the bottom, with NO
  visible seam, border, frame or vignette.
- Keep the existing large-scale structure and colour so it drops onto the same level geometry.
- Flat ALBEDO only: even, diffuse lighting; NO baked cast shadows, hotspots, directional light or
  ambient occlusion from off-surface objects.
- Square image. NO text, letters, numerals, glyphs, logos or watermark of any kind.`

function toPngB64(p) {
  const tmp = '/tmp/_rem_in.png'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', p, tmp])
  return fs.readFileSync(tmp).toString('base64')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gen(b64, attempt = 0) {
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }, { text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.9 },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = 4000 * (attempt + 1)
      console.warn(`  HTTP ${res.status}, retry ${wait / 1000}s`); await sleep(wait)
      return gen(b64, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = await res.json()
  const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
  if (!img) throw new Error('no image: ' + JSON.stringify(json).slice(0, 200))
  return Buffer.from(img.data, 'base64')
}

console.log(`${mats.length} materials x ${N} rolls\n`)
let ok = 0
for (const mat of mats) {
  // prefer the HD source as input (true upscale); fall back to the shipped webp
  const hdp = path.join(HD, mat + '.png')
  const src = fs.existsSync(hdp) ? hdp : path.join(MAPDIR, 'textures', mat + '.webp')
  if (!fs.existsSync(src)) { console.error(`SKIP ${mat}: no source`); continue }
  const outDir = path.join(OUTROOT, mat)
  fs.mkdirSync(outDir, { recursive: true })
  const b64 = toPngB64(src)
  const usedHD = src.startsWith(HD)
  for (let i = 1; i <= N; i++) {
    try {
      const buf = await gen(b64)
      fs.writeFileSync(path.join(outDir, `remaster-v${i}.png`), buf)
      console.log(`  ok  ${mat}/remaster-v${i}.png  ${(buf.length / 1024).toFixed(0)}KB  ${usedHD ? '(HD in)' : '(512 in)'}`)
      ok++
    } catch (e) {
      console.error(`  ERR ${mat}/v${i}: ${e.message}`)
    }
    await sleep(1200)
  }
}
console.log(`\n${ok} generated -> ${OUTROOT}`)
