// Generate ISOLATED crest emblems only — no substrate, no frame, no lighting
// baked in. The Python compositor (compose-crest.py) owns substrate, tint, glow
// and tiling layout, so the two team banners are guaranteed to be the same
// emblem colour-swapped (a real matched pair) and to tile correctly on each
// surface's UVs.
//
// Emblem is rendered in NEUTRAL chrome/silver so the compositor can tint it to
// any team hue cleanly (a pre-coloured emblem fights re-tinting). Background is
// pure chroma green (#00FF00) — nothing in a silver emblem is that green, so it
// keys out perfectly, same trick as the brand pipeline's process_d_logo.py.
//   node scripts/gemini-emblem.mjs
import fs from 'node:fs'
import path from 'node:path'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const OUTDIR = path.resolve(process.env.HOME, 'unreal/public/textures/emblems')
fs.mkdirSync(OUTDIR, { recursive: true })
const MODEL = 'gemini-3.1-flash-image'

const BASE = `Design a single heraldic faction crest for a futuristic arena tournament team.

THE MOTIF (Solana visual language): three bold parallel bars sheared into strong parallel
diagonals, suggesting speed and forward motion. Build an original, aggressive emblem around
that motif — do not copy any real company logo.

RENDER IT AS: polished brushed CHROME / SILVER metal with crisp raised bevels and deep cut
recesses, as if machined. NEUTRAL metal only — silver/steel/gunmetal greys, NO coloured tint,
NO coloured glow (colour is added later).

HARD RULES:
- The emblem MUST be perfectly symmetrical about the vertical centre axis.
- Fill about 75% of the frame, centred, with clear empty margin around it (the emblem must NOT
  touch any edge).
- Background: a completely FLAT, uniform, pure chroma GREEN (#00FF00) — no gradient, no texture,
  no shadow on the background, no vignette. The emblem casts NO shadow onto the green.
- NO text, letters, numerals, runes or glyphs of any kind. NO frame, plaque, wall or border.
- Square image. Bold, simple silhouette readable from far away.`

const VARIANTS = {
  'chevron-wing': `${BASE}\nEMBLEM CONCEPT: a downward war-chevron / arrowhead with the three sheared
diagonal bars driving through its centre, and short swept wing-blades flaring out from the upper
shoulders. Menacing and fast.`,
  'shield-slash': `${BASE}\nEMBLEM CONCEPT: a sharp angular shield whose face is cut by the three sheared
diagonal bars, the bars overshooting the shield edges as blades. Tournament-heraldry, brutal.`,
  'raptor': `${BASE}\nEMBLEM CONCEPT: an abstract angular raptor/phoenix head-on, its spread wings formed
FROM the three sheared diagonal bars stepping outward. Aggressive, iconic, banner-worthy.`,
  'monogram-bolt': `${BASE}\nEMBLEM CONCEPT: an interlocked angular monogram built purely from the three
sheared diagonal bars crossed by a single hard lightning-cut, forming a compact diamond-shaped sigil.
Geometric and clean.`,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gen(prompt, attempt = 0) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.95 },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = 4000 * (attempt + 1)
      console.warn(`  HTTP ${res.status}, retry in ${wait / 1000}s`)
      await sleep(wait)
      return gen(prompt, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = await res.json()
  const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
  if (!img) throw new Error('no image: ' + JSON.stringify(json).slice(0, 200))
  return Buffer.from(img.data, 'base64')
}

let ok = 0
for (const [name, prompt] of Object.entries(VARIANTS)) {
  try {
    const buf = await gen(prompt)
    fs.writeFileSync(path.join(OUTDIR, `${name}.png`), buf)
    console.log(`  ok  ${name}.png  ${(buf.length / 1024).toFixed(0)}KB`)
    ok++
  } catch (e) {
    console.error(`  ERR ${name}: ${e.message}`)
  }
  await sleep(1200)
}
console.log(`\n${ok}/${Object.keys(VARIANTS).length} emblems -> ${OUTDIR}`)
