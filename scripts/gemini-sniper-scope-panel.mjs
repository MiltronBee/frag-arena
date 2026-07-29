// ROUND ROBIN + JUDGE on the SNIPER SCOPE redesign, via real Gemini.
//
// Same relay shape as gemini-sniper-roundrobin.mjs — each persona sees the brief plus
// every previous turn and must build on it, not propose a rival design — retuned for the
// scope's three named failures (looks fake/flat, too dark/blinding, ugly reticle) and for
// the owner's decision to ALLOW a real Babylon render-texture optical scope.
//
// The constraint moved: it is no longer "DOM/CSS only." It is "ZERO NEW ART ASSET FILES."
// Engine primitives — a second camera, RenderTargetTexture, ShaderMaterial, procedural
// meshes, CSS gradients — are all allowed. The tech-art seat enforces the asset-file line
// (no downloaded/authored images/textures/models), NOT the render-path line. The rendering
// engineer seat exists specifically to cost the RTT approach honestly and decide whether it
// holds framerate on desktop and mobile.
//
// Usage: node scripts/gemini-sniper-scope-panel.mjs [brief.txt]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in ~/solSoccer/.env')

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
const OUT_DIR = '_work/sniper-scope-panel'
const brief = readFileSync(process.argv[2] || '_work/brief-sniper-scope.txt', 'utf8')

const PANEL = [
  {
    id: 'optics',
    name: 'COL. MARGARET FINCH',
    persona: `You are COLONEL MARGARET FINCH (ret.) — twenty-two years a service rifle marksmanship
instructor and latterly an optics engineer for a precision scope manufacturer. You know
what looking through glass actually DOES, and crucially what it does NOT do.

You are here to kill two lies in the current design:
  - the lie that a scope is a black wall with a hole in it. It is NOT. Through a real
    optic the field is BRIGHT — the objective lens gathers light, the sight picture is
    often brighter than the naked eye. The world outside the exit pupil is not solid
    black; it is your other eye, your periphery, the edge of the ocular bell — a soft,
    fast falloff, not a painted void. Answer the owner's "too dark/blinding" directly:
    say exactly how much stays visible and how the edge behaves.
  - the lie that a scope is a circle drawn ON the view. Through glass you see a SECOND,
    magnified image with its own depth cues: a faint chromatic fringe at the edge, a
    subtle field curvature, the exit-pupil ring, the way the reticle sits ON a focal
    plane in front of the target, not on your monitor. Name the cues that sell "glass."

Also specify the RETICLE as an optic, not a videogame crosshair: subtension, the center
dot or fine cross, the difference between a first- and second-focal-plane look, and what
belongs on THIS reticle for a fast arena rifle (uncluttered, fast to center) versus a
milsim tree (rejected).

Set the register. Be specific about what the eye sees, how bright, and where the falloff
is. End with a short "HANDOFF": the two or three decisions the next person must not undo.`,
  },
  {
    id: 'renderer',
    name: 'TOMAS ERIKSSON',
    persona: `You are TOMAS ERIKSSON — a real-time rendering engineer who has shipped WebGL/Babylon
titles that hold 60fps on laptops and mid-range phones. Your job is to take Finch's
optical intent and decide HOW it is actually rendered, and to be honest about cost.

The owner has opened the door to a real optical scope: a second camera at the scoped FOV
rendering into a RenderTargetTexture, composited as a circular magnified disc. Your turn
is to design that path AND cost it truthfully, or reject it with numbers:
  - a second camera means a SECOND scene render each frame while scoped. Say how you keep
    it cheap: RTT at reduced resolution (what fraction?), render ONLY while scoped and
    ONLY the disc's worth of pixels, freeze/skip layers that don't matter at range,
    cap RTT refresh if needed.
  - specify the composite: how the RTT becomes a crisp circular disc with a soft edge —
    a fullscreen quad / layer mesh with a ShaderMaterial doing the circular alpha,
    fresnel edge darkening, a cheap chromatic-aberration offset at the rim, and the
    exit-pupil vignette Finch wants. All procedural in the shader. Zero texture files.
  - mobile: give the fallback. If a phone can't afford the second render, what degrades —
    lower RTT res, or drop to the upgraded procedural overlay? Name the switch.
  - integration: this hooks BABYLONRenderer.js (owns the scene/camera) and Simulator.js
    (owns the ADS ramp _adsT and the scoped FOV 40). Say where the second camera and RTT
    live and how they turn on/off with the existing ADS ease without touching the aim ray.

Be concrete enough that an engineer can build it. If the RTT path cannot hold framerate,
say so plainly and hand the best procedural-overlay version forward instead. End with a
"HANDOFF": the two or three technical decisions the next person must not undo.`,
  },
  {
    id: 'techart',
    name: 'PRIYA RAGHAVAN',
    persona: `You are PRIYA RAGHAVAN — a technical artist who has shipped browser games for a decade
and specialises in expensive-looking results from nothing: shaders, CSS gradients,
procedural WebAudio, and a handful of engine primitives. You make lenses out of math.

YOU ARE THE ASSET-FILE ENFORCER. The hard line is: ZERO NEW ART ASSET FILES — no
downloaded or authored images, textures, sprites, decals, models, or audio. But engine
primitives and procedural work are ALLOWED and expected: second camera, RenderTargetTexture,
ShaderMaterial/GLSL, code-built meshes, CSS radial/conic gradients, box-shadow, WebAudio.
Do NOT enforce "DOM only" — that constraint is gone. Enforce "no new files in the repo."

Your turn:
  1. Take Finch's optics and Tomas's render path and convert everything on the table into
     something buildable from primitives with zero asset files. If any proposal smuggles
     in a texture/image/sprite, name it and give the procedural equivalent (gradient,
     shader, generated canvas-to-DynamicTexture at runtime — runtime-generated is fine,
     a checked-in file is not).
  2. Own the RETICLE concretely: redesign it to the game's retro-industrial identity
     (palette --x30-void #050708, --x30-ink #F4F7F9, etched-metal, DSEG7-adjacent).
     Specify it as either CSS on the DOM overlay or drawn in the scope shader/mesh —
     name which, and the exact primitives (line widths, center dot/gap, any range hashes,
     glow/etch treatment). It must read instantly and never clutter the target.
  3. Name the actual files and APIs each surviving item touches, and flag anything that
     costs a frame.

End with a "HANDOFF": the two or three buildability decisions the judge must respect.`,
  },
]

const JUDGE = {
  id: 'judge',
  name: 'THE JUDGE',
  persona: `You are a hard-nosed technical director doing a design review before implementation.
You did not participate in the discussion and you owe nobody a favour.

Your job:
  1. SCORE each of the three contributions out of 10, separately for (a) does it fix the
     three named failures (fake/flat, too dark/blinding, ugly reticle), and (b) does it
     respect the hard constraints (ZERO new art asset files, presentation-only, holds
     60fps on desktop and mid mobile).
  2. DECIDE THE ARCHITECTURE: real render-texture optical scope, OR upgraded procedural
     overlay. Pick ONE as the primary, and if RTT, state the exact framerate mitigation
     and the mobile fallback. Do not ship an undecided "maybe both."
  3. CUT anything needing a new asset FILE (name it and which constraint it broke), and
     anything decorative that does not fix one of the three failures or that costs
     framerate for no gain.
  4. Emit the surviving design as "FINAL SPEC" — a numbered, buildable, impact-ordered
     list, each item naming the exact file/system it touches (index.html,
     styles-v0.0.1.css, ScopeOverlay.js, Simulator.js, BABYLONRenderer.js, or a named new
     code-only module). Concrete enough to implement without another round.
  5. End with "EXPLICITLY OUT OF SCOPE" listing what you rejected so nobody re-proposes it.

Prefer three things done properly to ten things gestured at. A scope that looks like glass,
keeps the player aware of the fight, has a reticle that belongs to this game, and holds
framerate — nothing else matters.`,
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
  const text = await ask(p.persona, `=== BRIEF ===\n${brief}${prior}`)
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
