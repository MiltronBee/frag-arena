// Maximum-realism upscale of CTF-Visage's structural surfaces: ONE photoreal
// texture per material (no variants). Feeds the HD source, keeps each material's
// identity + dominant colour + large-scale layout so it drops onto the same
// geometry and the existing vertex-light bake / fog tuning stay valid, but
// renders the surface at photoreal material fidelity.
//
// CRITICAL: output is a FLAT ALBEDO. The engine bakes vertex light + draws
// coronas, so any baked shadow/highlight/AO in the texture would double-light.
// Realism lives in grain/wear/micro-relief under even lighting, not in lighting.
//
// Skips: the 4 materials being replaced (crests/sign/medallion), the skybox,
// the purple-fire FX, and the crucifix deco. Everything else gets upscaled.
//   node scripts/gemini-visage-realism.mjs [material ...]
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

const SKIP = new Set([
  'CTF_Crypt_C-st-128-R', 'CTF_Crypt_C-rst-128-B',   // crests (replaced)
  'SkyCity_Deco_runeSgn2', 'SkyCity_Deco_sKantis2',  // sign + medallion (replaced)
  'genfluid_Sky_NghSky3',                             // skybox
  'GreatFire_ancpurp',                                // purple-fire FX
  'SkyCity_Deco_sCrucfxn',                            // crucifix deco
])

// full material list from the MTL, minus SKIP
const allMats = fs.readFileSync(path.join(MAPDIR, 'CTF-Visage.mtl'), 'utf8')
  .split('\n').filter((l) => l.startsWith('newmtl ')).map((l) => l.slice(7).trim())
const argMats = process.argv.slice(2)
const mats = (argMats.length ? argMats : allMats).filter((m) => !SKIP.has(m))

const PROMPT = `This is a seamless tiling wall/floor/trim texture from a 1999 first-person-shooter arena.
Recreate it at MAXIMUM PHOTOREALISM for a modern 2026 game — as if scanned from the real material.

KEEP: the same material identity (stone stays that stone, metal that metal, wood that wood), the same
dominant colours and palette, and the same large-scale layout/motif, so it drops onto the same level
geometry and reads as the same surface — just real.

PUSH: photoreal micro-detail — true surface grain, pores, hairline cracks, mineral flecks, edge wear,
grime in the crevices, subtle height/relief variation. Sharp, high-resolution, believable.

HARD RULES:
- This is a FLAT ALBEDO / diffuse map. Light it EVENLY and neutrally: NO cast shadows, NO directional
  highlights, NO hotspots, NO baked ambient occlusion or glow from off-surface objects. The relief must
  come from the material itself, not from a raking light.
- MUST tile seamlessly: left edge continues into right, top into bottom, NO seam/border/frame/vignette.
- Square image. NO text, letters, numerals, glyphs, logos or watermark.
- Keep value contrast moderate — a gameplay surface, not a hero macro shot; avoid noisy high-frequency
  clutter that would camouflage characters standing against it.`

function toPngB64(p) {
  const tmp = '/tmp/_real_in.png'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', p, tmp])
  return fs.readFileSync(tmp).toString('base64')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gen(b64, attempt = 0) {
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }, { text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.55 }, // low temp: fidelity, not invention
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

console.log(`${mats.length} materials, 1 realism roll each\n`)
let ok = 0
for (const mat of mats) {
  const hdp = path.join(HD, mat + '.png')
  const src = fs.existsSync(hdp) ? hdp : path.join(MAPDIR, 'textures', mat + '.webp')
  if (!fs.existsSync(src)) { console.error(`SKIP ${mat}: no source`); continue }
  const outDir = path.join(OUTROOT, mat)
  fs.mkdirSync(outDir, { recursive: true })
  try {
    const buf = await gen(toPngB64(src))
    fs.writeFileSync(path.join(outDir, 'remaster-real.png'), buf)
    console.log(`  ok  ${mat}/remaster-real.png  ${(buf.length / 1024).toFixed(0)}KB`)
    ok++
  } catch (e) {
    console.error(`  ERR ${mat}: ${e.message}`)
  }
  await sleep(1200)
}
console.log(`\n${ok}/${mats.length} -> ${OUTROOT}`)
