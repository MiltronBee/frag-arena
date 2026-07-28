// ROUND ROBIN of designer personas on the Degen Tournament HUD, via real Gemini.
//
// Not a panel of independent opinions — a RELAY. Each persona receives the brief plus
// every previous turn and is required to build on what is already on the table: keep what
// works, name what they are overruling and why. A panel of four parallel critiques
// produces four incompatible HUDs; a relay produces one.
//
// The order is deliberate and ends where it has to:
//   1. GOTHIC     — sets the aggressive, arcane register (the Warhammer note)
//   2. MACHINIST  — makes it physical: brass, rivets, gauges, analog instrumentation
//   3. CURATOR    — guards the EXISTING retro look; the brief is improve, never replace
//   4. RETICLE    — readability last, with a veto, because a HUD that looks incredible
//                   and cannot be read mid-fight is a failed HUD
//
// Usage: node scripts/gemini-hud-roundrobin.mjs <brief.txt> [shot.png ...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in ~/solSoccer/.env')

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
const OUT_DIR = '_work/hud-roundrobin'

if (!process.argv[2]) {
  console.error('Usage: node scripts/gemini-hud-roundrobin.mjs <brief.txt> [img.png ...]')
  process.exit(1)
}
const brief = readFileSync(process.argv[2], 'utf8')
const images = process.argv.slice(3).map((p) => ({
  inlineData: { mimeType: 'image/png', data: readFileSync(p).toString('base64') },
}))

const PANEL = [
  {
    id: 'gothic',
    name: 'MAGISTER VOSS',
    persona: `You are MAGISTER ELIAS VOSS — twenty years an art director in the Warhammer 40,000
studio system. You own the visual grammar of the Imperium: gothic arches rendered in
sheet steel, purity seals and wax, aquila motifs stamped into armour plate, brass
cog-teeth, rivets as ornament, hazard chevrons, and text that reads like liturgy carved
into a machine. Your rule is that technology in this world is not understood, it is
PLACATED — every readout is a shrine, every gauge an altar, and every number a
pronouncement rather than a measurement. You despise clean flat minimalism and you
despise steampunk cosplay equally; the register you defend is INDUSTRIAL SACRED.

Set the register for this HUD. Be specific about form language, ornament, iconography,
and typographic voice — not adjectives.`,
  },
  {
    id: 'machinist',
    name: 'GRETA HALVORSEN',
    persona: `You are GRETA HALVORSEN — an industrial designer who spent fifteen years restoring
Victorian scientific instruments and pressure-vessel gauges before moving into game UI.
You know what real analog instrumentation looks like: the bezel, the glass, the parallax
of a needle above a printed dial, engine-turned guilloché on a face plate, knurling on a
brass collar, the specific way lacquer ages and the specific way soot collects in a
recess. You have zero patience for "steampunk" as gears-glued-to-things — a gear that
does not transmit force is a lie, and the eye knows.

Take the register you have been handed and make it PHYSICAL. What is the housing? What
is lit, what is engraved, what is stamped? Where does a needle live and where does a
seven-segment tube live? Be concrete enough that a CSS author can build it.`,
  },
  {
    id: 'curator',
    name: 'RIO OKONKWO',
    persona: `You are RIO OKONKWO — a design-systems lead whose whole job is stopping redesigns from
destroying what already works. You have shipped visual refreshes on live products with
existing users and you have killed more "bold new direction" decks than you have
approved. Your instinct on any restyle is to find the load-bearing pieces of the CURRENT
look and make them louder, rather than to replace them.

THE CLIENT HAS BEEN EXPLICIT: do NOT get rid of the current retro look. IMPROVE on it.
That is a constraint, not a preference, and you are the person who enforces it.

You have the existing design system in the brief. Your turn: go through what your
colleagues proposed and separate it into (a) what extends the current system, (b) what
QUIETLY REPLACES it and must be cut or rescoped, and (c) what is missing because they
did not look at what is already there. Name specific existing tokens and components.`,
  },
  {
    id: 'reticle',
    name: 'DANIELLE ORTEGA',
    persona: `You are DANIELLE "RETICLE" ORTEGA — sixteen years at Blizzard, the last decade owning
the player-facing HUD on Overwatch and Overwatch 2. You keep a screen readable when six
abilities and a killfeed go off in the same second. You ran the readability and
colorblind-accessibility reviews and killed dozens of "looks incredible in a mockup,
unreadable in a teamfight" ideas.

You go last and you hold a VETO. This is a first-person shooter: every pixel of ornament
competes with an enemy silhouette, and a market ticker is NOT worth a death. Your turn:
take the accumulated design and make it survivable. What gets dimmed, shrunk, moved out
of the center, or shown only on change? What is the peripheral-vision behaviour? What
happens to all of it when the player is taking fire? Be willing to cut things you like.`,
  },
]

const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(systemText, userParts) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 8192 },
  }
  const MAX = 8
  let res, json
  for (let attempt = 1; attempt <= MAX; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    json = await res.json()
    if (res.ok) break
    // 503/429 are capacity, not a bad request — the long wait is deliberate, these
    // relays are worth restarting a turn for rather than losing the whole chain.
    if (res.status === 503 || res.status === 429) {
      if (attempt === MAX) break
      console.error(`# ${res.status} busy — waiting 30s (attempt ${attempt}/${MAX})`)
      await sleep(30000)
      continue
    }
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  }
  if (!res.ok) throw new Error(`gave up: ${res.status}`)
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '(empty)'
}

mkdirSync(OUT_DIR, { recursive: true })
const transcript = []

for (let i = 0; i < PANEL.length; i++) {
  const p = PANEL[i]
  const prior = transcript.length
    ? `\n\n=== WHAT IS ALREADY ON THE TABLE ===\n${transcript.map((t) => `--- ${t.name} (${t.id}) ---\n${t.text}`).join('\n\n')}`
    : '\n\n(You are first. Set the direction.)'

  const instruction = i === PANEL.length - 1
    ? `\n\nYou are LAST. End with a section titled "FINAL SPEC" containing the agreed HUD as a numbered, buildable list — concrete enough to implement in CSS without another meeting.`
    : `\n\nEnd with a short "HANDOFF" section: the two or three decisions the next designer must not undo.`

  console.error(`\n# ── ${i + 1}/${PANEL.length}  ${p.name} ────────────────────────────`)
  const parts = [{ text: `=== BRIEF ===\n${brief}${prior}${instruction}` }, ...(i === 0 ? images : [])]
  const text = await ask(p.persona, parts)
  transcript.push({ id: p.id, name: p.name, text })
  writeFileSync(`${OUT_DIR}/${i + 1}-${p.id}.md`, `# ${p.name}\n\n${text}\n`)
  console.log(`\n\n=========== ${p.name} ===========\n${text}`)
}

writeFileSync(`${OUT_DIR}/transcript.md`,
  transcript.map((t) => `# ${t.name} (${t.id})\n\n${t.text}\n`).join('\n\n---\n\n'))
console.error(`\n# wrote ${OUT_DIR}/transcript.md`)
