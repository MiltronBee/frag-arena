// Full-replacement imagery for CTF-Visage: Solana-themed team crests + map deco.
// Unlike gemini-texture-remaster.mjs (which preserves the motif and only raises
// fidelity), these REPLACE the motif outright — the four targets were triaged
// "replace" because their UT99 iconography carries no meaning for this game.
//
// Still image-to-image, not text-to-image: the reference pins the physical
// format (carved into the same stone, same border profile, same light
// direction) so a new emblem reads as part of the level instead of a decal
// pasted on it. Only the emblem inside the frame changes.
//
// Writes public/textures/candidates/<material>/<variant>.png at whatever
// resolution the model returns (>=1024), so a promoted pick can be downsampled
// to the shipping 512 WebP rather than upscaled. Nothing ships automatically.
//   node scripts/gemini-solana-imagery.mjs [material ...]
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
const OUTROOT = path.join(ROOT, 'public/textures/candidates')
const MODEL = 'gemini-3.1-flash-image'

// Shared constraints. The inscription on the ORIGINAL runeSgn2 is upscale
// gibberish ("ZOMSEND DEEDEP") — generated lettering would be worse, so text is
// banned outright and the emblems have to carry meaning through shape alone.
const RULES = `
HARD RULES:
- Square image, centered composition, filling the frame edge to edge.
- Absolutely NO text, letters, numerals, runes, glyphs or inscriptions of any kind.
- No watermark, no signature, no logo of any real company, no border padding, no vignette.
- Match the reference image's surface material, weathering, border profile and light
  direction so it reads as part of the same level, carved by the same hands.
- Flat albedo suitable for a game texture: no dramatic cast shadows from off-surface
  objects, no depth-of-field, no lens effects.
- Clean, readable silhouette that stays legible when viewed from 20+ metres away.`

const SOLANA = `The visual language is Solana: three bold parallel bars sheared into
strong diagonals, suggesting speed and forward motion. Treat that as a motif to build an
original emblem around — angular, geometric, confident — not as a corporate logo to copy.`

// Team crests come in two colour schemes because the choice is unresolved:
// conventional red/blue reads instantly, Solana violet/green is on-brand and
// colourblind-safer. Generate both, decide from the gallery.
const TEAM_SCHEMES = {
  'CTF_Crypt_C-st-128-R': [
    ['classic-red', 'a deep crimson red (#D63232) with hot orange-red inner glow on the bevel edges'],
    ['solana-violet', 'a saturated Solana violet (#9945FF) with a luminous magenta-violet bloom on the bevel edges'],
  ],
  'CTF_Crypt_C-rst-128-B': [
    ['classic-blue', 'a strong cobalt blue (#2E6BD6) with a cyan inner glow on the bevel edges'],
    ['solana-green', 'a luminous Solana green (#14F195) with a soft aqua glow on the bevel edges'],
  ],
}

const TEAM_PROMPT = (colorDesc) => `This is a team faction crest plaque set into the stone wall of a
futuristic tournament arena. Redraw it completely: discard the existing emblem entirely and design a
NEW original faction crest in its place.

${SOLANA}

The crest is inlaid metal in ${colorDesc}, set into the weathered stone plaque. Keep the plaque's
square recessed frame and the surrounding stone exactly as in the reference — only the emblem inside
the frame changes. The emblem must be strongly symmetrical about the vertical axis and read as a
heraldic team banner: bold, simple, aggressive, unmistakable at a glance across a large arena.
${RULES}`

const DECO = {
  SkyCity_Deco_sKantis2: {
    n: 3,
    prompt: `This is a circular cast-metal medallion mounted on a brick wall in a futuristic tournament
arena. The existing face motif is meaningless here — replace it with a NEW original emblem.

${SOLANA}

Keep the circular medallion format, its raised outer ring, the aged-gold metal, and the brick wall
behind it exactly as in the reference. Inside the ring, render an original angular emblem in polished
gold relief against a dark patinated recess, with a faint violet-to-green iridescence in the patina.
It should look like a guild seal or tournament sigil cast in metal generations ago.
${RULES}`,
  },
  SkyCity_Deco_runeSgn2: {
    n: 3,
    prompt: `This is a square carved stone signage panel with an ornate scalloped border, mounted in a
futuristic tournament arena. The existing carved inscription is illegible nonsense — replace the
entire centre panel with a NEW original carved emblem. NO TEXT WHATSOEVER.

${SOLANA}

Keep the ornate scalloped stone border and the weathered green-patina stone material from the
reference. In the centre, carve an original geometric sigil in deep relief, its recesses catching a
faint luminous violet-green glow as if lit from within the stone. Think a directional wayfinding
marker for a faction stronghold: purely graphic, purely symbolic.
${RULES}`,
  },
}

function toPngB64(webpPath) {
  const tmp = '/tmp/_solana_in.png'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webpPath, tmp])
  return fs.readFileSync(tmp).toString('base64')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function generate(b64, prompt, attempt = 0) {
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }, { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.9 },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // 429/503 are routine on this endpoint; back off and retry rather than
    // losing the whole batch to one throttle.
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = 4000 * (attempt + 1)
      console.warn(`  HTTP ${res.status}, retrying in ${wait / 1000}s`)
      await sleep(wait)
      return generate(b64, prompt, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const json = await res.json()
  const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
  if (!img) throw new Error('no image in response: ' + JSON.stringify(json).slice(0, 300))
  return Buffer.from(img.data, 'base64')
}

// (material, variantName, prompt) work list
const jobs = []
for (const [mat, schemes] of Object.entries(TEAM_SCHEMES)) {
  for (const [name, colorDesc] of schemes) {
    jobs.push([mat, name, TEAM_PROMPT(colorDesc)])
    jobs.push([mat, name + '-b', TEAM_PROMPT(colorDesc)]) // 2nd roll, temp 0.9
  }
}
for (const [mat, spec] of Object.entries(DECO)) {
  for (let i = 1; i <= spec.n; i++) jobs.push([mat, `v${i}`, spec.prompt])
}

const only = process.argv.slice(2)
const todo = only.length ? jobs.filter((j) => only.includes(j[0])) : jobs
console.log(`${todo.length} generations across ${new Set(todo.map((j) => j[0])).size} materials\n`)

let ok = 0
for (const [mat, variant, prompt] of todo) {
  const src = path.join(MAPDIR, 'textures', mat + '.webp')
  if (!fs.existsSync(src)) {
    console.error(`SKIP ${mat}: no such texture`)
    continue
  }
  const outDir = path.join(OUTROOT, mat)
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `${variant}.png`)
  try {
    const buf = await generate(toPngB64(src), prompt)
    fs.writeFileSync(out, buf)
    console.log(`  ok  ${mat}/${variant}.png  ${(buf.length / 1024).toFixed(0)}KB`)
    ok++
  } catch (e) {
    console.error(`  ERR ${mat}/${variant}: ${e.message}`)
  }
  await sleep(1200) // stay under the per-minute image quota
}
console.log(`\n${ok}/${todo.length} generated -> ${OUTROOT}`)
