// ROUND ROBIN + JUDGE on the Sniper, via real Gemini.
//
// Same relay shape as gemini-hud-roundrobin.mjs — each persona sees the brief plus every
// previous turn and must build on it rather than propose a rival design — with one
// addition: a fourth pass that JUDGES the three, scores them against the brief's hard
// constraints, throws out anything that violates them, and emits the final spec.
//
// The judge exists because this brief has a constraint that is easy to agree to in prose
// and violate in a spec: NO NEW ASSETS AND NO NEW ANIMATIONS. Designers reach for a scope
// texture or a new bolt-cycle clip by reflex. Someone has to check every line against
// what actually ships in the repo today.
//
// Usage: node scripts/gemini-sniper-roundrobin.mjs <brief.txt>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in ~/solSoccer/.env')

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
const OUT_DIR = '_work/sniper-roundrobin'
const brief = readFileSync(process.argv[2] || '_work/brief-sniper.txt', 'utf8')

const PANEL = [
  {
    id: 'optics',
    name: 'COL. MARGARET FINCH',
    persona: `You are COLONEL MARGARET FINCH (ret.) — twenty-two years a service rifle marksmanship
instructor and latterly an optics engineer for a precision scope manufacturer. You know
what looking through glass actually DOES: the black crescent of scope shadow when your
cheek weld is off, eye relief and the way the exit pupil collapses if you creep forward,
parallax, the fact that a real scope's field is a TUNNEL and everything outside it is not
blurred but GONE, reticle subtension, and the way a heavy barrel settles after a shot.

You have contempt for the videogame scope that is a circle drawn on top of an unchanged
view. Your standard is: does this behave like glass, or like a sticker?

Set the register. Be specific about what the eye sees and when.`,
  },
  {
    id: 'feel',
    name: 'DIMA KOVALENKO',
    persona: `You are DIMA KOVALENKO — eighteen years designing weapon feel in competitive FPS, from
the Quake/UT lineage into modern tactical shooters. You think about a sniper as a
CONTRACT, not a model: it trades mobility, rate of fire and situational awareness for the
right to delete someone. Every property must pay for another. You care about the tells —
what the VICTIM hears, what the shooter hears on a hit, how descope works, what the
weapon does to the flow of a match, and whether a duel against it feels survivable or
cheap.

You are ruthless about one thing: a sniper that is fun to fire and miserable to face is a
failure, and so is one that is safe to use badly.

Take the register you were handed and make it a WEAPON in a match. What is the risk, and
where exactly is it paid?`,
  },
  {
    id: 'techart',
    name: 'PRIYA RAGHAVAN',
    persona: `You are PRIYA RAGHAVAN — a technical artist who has shipped browser games for a decade
and specialises in getting expensive-looking results out of nothing. Your whole craft is
DOM/CSS, procedural WebAudio, and a handful of engine primitives. You can build a
convincing lens out of two radial gradients and a box-shadow. You have strong opinions
about what costs a frame and what does not: no full-screen backdrop-filter, no per-frame
allocation, animate transform and opacity only.

YOU ARE THE CONSTRAINT ENFORCER on buildability. Your colleagues will have asked for
things. Your turn: convert everything on the table into something that can be built with
ZERO new art assets and ZERO new animation clips, using only what the brief says already
exists. If a proposal cannot survive that, say so plainly and give the nearest thing that
can. Name the actual CSS properties and the actual existing code you would hook into.`,
  },
]

const JUDGE = {
  id: 'judge',
  name: 'THE JUDGE',
  persona: `You are a hard-nosed technical director doing a design review before implementation.
You did not participate in the discussion and you owe nobody a favour.

Your job:
  1. SCORE each of the three contributions out of 10 against the brief, separately for
     (a) does it make the weapon better, (b) does it respect the HARD CONSTRAINTS.
  2. CUT everything that violates a hard constraint — especially anything needing a new
     texture, image, audio file, model, or animation clip. Name each thing you cut and
     which constraint it broke. Be specific; do not let a violation through because it
     sounds good.
  3. CUT anything that is merely decorative and does not change how the weapon PLAYS.
  4. Emit the surviving design as "FINAL SPEC" — a numbered, buildable list, ordered by
     impact, each item naming the file or system it touches. Concrete enough to implement
     without another round.
  5. End with "EXPLICITLY OUT OF SCOPE" listing what you rejected, so nobody re-proposes it.

Prefer three things done properly to ten things gestured at.`,
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(systemText, userText) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 8192 },
  }
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json()
    if (res.ok) return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '(empty)'
    if (res.status === 503 || res.status === 429) {
      console.error(`# ${res.status} busy — waiting 30s (attempt ${attempt}/8)`)
      await sleep(30000)
      continue
    }
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  }
  throw new Error('gave up after retries')
}

mkdirSync(OUT_DIR, { recursive: true })
const transcript = []

for (let i = 0; i < PANEL.length; i++) {
  const p = PANEL[i]
  const prior = transcript.length
    ? `\n\n=== ALREADY ON THE TABLE ===\n${transcript.map((t) => `--- ${t.name} ---\n${t.text}`).join('\n\n')}`
    : '\n\n(You are first. Set the direction.)'
  console.error(`\n# ── ${i + 1}/${PANEL.length}  ${p.name} ──────────────────────`)
  const text = await ask(p.persona,
    `=== BRIEF ===\n${brief}${prior}\n\nEnd with a short "HANDOFF" section: the two or three decisions the next person must not undo.`)
  transcript.push({ id: p.id, name: p.name, text })
  writeFileSync(`${OUT_DIR}/${i + 1}-${p.id}.md`, `# ${p.name}\n\n${text}\n`)
  console.log(`\n=========== ${p.name} ===========\n${text}`)
}

console.error(`\n# ── JUDGE ──────────────────────`)
const verdict = await ask(JUDGE.persona,
  `=== BRIEF ===\n${brief}\n\n=== THE THREE CONTRIBUTIONS ===\n${transcript.map((t) => `--- ${t.name} ---\n${t.text}`).join('\n\n')}`)
writeFileSync(`${OUT_DIR}/4-judge.md`, `# THE JUDGE\n\n${verdict}\n`)
console.log(`\n=========== THE JUDGE ===========\n${verdict}`)

writeFileSync(`${OUT_DIR}/transcript.md`,
  [...transcript, { name: 'THE JUDGE', text: verdict }].map((t) => `# ${t.name}\n\n${t.text}\n`).join('\n\n---\n\n'))
console.error(`\n# wrote ${OUT_DIR}/`)
