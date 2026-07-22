// Ask gemini-3.1-flash-image to remaster map textures image-to-image: keep each
// texture's layout/palette/tileability but redraw it at modern fidelity. Writes
// variants to public/dev/tex-candidates/<material>/vN-<style>.png — the texture
// gallery (scripts/make-texture-gallery.py) picks them up automatically.
// Candidates are dev-only reference; nothing ships into the map until a human
// promotes one into the 512px WebP set.
//   node scripts/gemini-texture-remaster.mjs [material ...]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const ROOT = path.resolve(process.env.HOME, 'unreal')
const MAPDIR = path.join(ROOT, 'public/assets/maps/DM-W-Grove')
const OUTROOT = path.join(ROOT, 'public/dev/tex-candidates')

// default set = the highest face-coverage surfaces + the signature courtyard floor
const DEFAULT_MATS = [
  'UTtech1_Base_Rbase1a', 'Wall_03', 'UT_stoneb2',
  'UTtech1_Base_cbutbase_3', 'DecayedS_Base_Dterbas1', 'floor_01_center'
]
const mats = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MATS

// three distinct art directions per texture so the user can pick a lane
const STYLES = [
  ['faithful', 'a faithful remaster: same materials and wear, just sharper, higher detail, cleaner surface definition'],
  ['gritty', 'a gritty modern-realism pass: photoreal material response, grime, chipped edges, subtle height variation'],
  ['clean-scifi', 'a cleaner stylized sci-fi pass: crisp panel lines, restrained detail, slightly desaturated industrial palette']
]

const MODEL = 'gemini-3.1-flash-image'

function toPngB64(webpPath) {
  const tmp = '/tmp/_tex_in.png'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webpPath, tmp])
  return fs.readFileSync(tmp).toString('base64')
}

async function generate(matName, b64, styleKey, styleDesc) {
  const prompt = `This is a tiling texture from a 1999 first-person-shooter level (512x512, upscaled from 256px). Redraw it as ${styleDesc}.
HARD RULES: keep the exact same layout, structure, motif and color palette so it can drop into the same level geometry; the result MUST tile seamlessly (edges wrap); square image; no text, no watermark, no borders, no vignette; this is a flat albedo texture — no baked dramatic lighting or shadows from outside the surface.`
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/png', data: b64 } },
      { text: prompt }
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.85 }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  const img = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData
  if (!img) throw new Error('no image in response: ' + JSON.stringify(json).slice(0, 300))
  return Buffer.from(img.data, 'base64')
}

for (const mat of mats) {
  const src = path.join(MAPDIR, 'textures', mat + '.webp')
  if (!fs.existsSync(src)) { console.error(`SKIP ${mat}: no such texture`); continue }
  const outDir = path.join(OUTROOT, mat)
  fs.mkdirSync(outDir, { recursive: true })
  const b64 = toPngB64(src)
  for (const [k, desc] of STYLES) {
    const out = path.join(outDir, `${k}.png`)
    if (fs.existsSync(out)) { console.log(`skip ${mat}/${k} (exists)`); continue }
    try {
      const buf = await generate(mat, b64, k, desc)
      fs.writeFileSync(out, buf)
      console.log(`ok   ${mat}/${k} (${(buf.length / 1024).toFixed(0)}KB)`)
    } catch (e) {
      console.error(`FAIL ${mat}/${k}: ${e.message}`)
    }
  }
}
