// Generate the WIF and BONK team mascot emblems for the CTF theme (task: reskin the
// CTF flags + in-map "Decor" team sigils with a Solana meme motif — WIF vs BONK).
//
// UNLIKE gemini-emblem.mjs (one NEUTRAL chrome emblem, tinted two ways for a matched
// pair), WIF and BONK are two DISTINCT mascots in their OWN brand colours, so this
// generates each separately, already in-palette. Same request shape + green-chroma
// keying convention as gemini-emblem.mjs so compose-memecoin-crest.py can key + composite
// each onto its team's flag banner + stone sigil substrate exactly like compose-crest.py.
//
// Each emblem is a bold, head-on, SYMMETRIC mascot medallion that reads from across the
// arena — this is a faction banner, not fan art. Pure chroma-green background so the
// compositor keys it out cleanly (nothing in the mascot is #00FF00).
//
//   node scripts/gemini-memecoin-emblem.mjs [--only bonk|wif]
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

// Shared framing rules — mirrors gemini-emblem.mjs's HARD RULES so the compositor's
// key + centre-with-margin layout works unchanged.
const RULES = `
HARD RULES:
- Head-on, front-facing, and SYMMETRIC about the vertical centre axis.
- Fill about 78% of the frame, centred, with clear empty margin all around (the emblem must
  NOT touch any edge).
- Background: completely FLAT, uniform, pure chroma GREEN (#00FF00) — no gradient, no texture,
  no shadow, no vignette. The emblem casts NO shadow onto the green.
- NO text, NO letters, NO numerals, NO wordmark, NO ticker symbol anywhere.
- NO plaque, frame, wall, coin rim or border. Just the emblem floating on green.
- Square image. Bold, simple, high-contrast silhouette readable from far away.
- Emblem style: a machined metal faction medallion with crisp raised bevels and deep cut
  recesses — a heraldic team crest, glossy and iconic, NOT a flat sticker or cartoon drawing.`

const VARIANTS = {
  // BONK — the orange Shiba Inu "doge" meme. Warm team. Its brand is high-vis orange.
  bonk: `Design a single heraldic faction crest for an arena tournament team, themed as the
"BONK" Solana meme dog.
CONCEPT: a bold head-on emblem of a Shiba Inu / doge head — perky triangular ears, wide cheeks,
confident grin — rendered as a polished metal medallion in vivid ORANGE and warm gold, with a
darker orange outline and bright amber highlights. Aggressive, fun, iconic. A small crossed
baseball-bat motif may sit behind the head as heraldic support. Dominant colour: bright orange
(#F7931A / #FF7A00). ${RULES}`,

  // WIF — "dogwifhat": a Shiba Inu wearing a pink knitted beanie. Cool/counter team.
  wif: `Design a single heraldic faction crest for an arena tournament team, themed as the
"dogwifhat" (WIF) Solana meme dog.
CONCEPT: a bold head-on emblem of a Shiba Inu head WEARING a chunky knitted PINK BEANIE HAT
pulled down to the eyes, calm knowing expression, rendered as a polished metal medallion. The
beanie is bright PINK with visible knit ribbing; the dog face is cream / tan metal. Bright pink
outline and highlights. Iconic, clean, banner-worthy. Dominant colour: bright pink / magenta
(#FF4FC3 / #F5A9D0). ${RULES}`,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gen(prompt, attempt = 0) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature: 0.9 },
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

const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null

let ok = 0
const names = Object.keys(VARIANTS).filter((n) => !only || n === only)
for (const name of names) {
  try {
    const buf = await gen(VARIANTS[name])
    fs.writeFileSync(path.join(OUTDIR, `mc_${name}.png`), buf)
    console.log(`  ok  mc_${name}.png  ${(buf.length / 1024).toFixed(0)}KB`)
    ok++
  } catch (e) {
    console.error(`  ERR ${name}: ${e.message}`)
  }
  await sleep(1200)
}
console.log(`\n${ok}/${names.length} memecoin emblems -> ${OUTDIR}`)
