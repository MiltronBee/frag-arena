// Hand Frag Arena's GUI (index.html + the HUD/menu CSS) to Kimi3
// (moonshotai/kimi-k3 via OpenRouter) and get concrete UI/UX recommendations.
//
// Kimi K3 is reputed to be exceptional at frontend, so we give it the raw
// markup + stylesheet — not screenshots — so it can reason about the actual
// DOM structure, CSS architecture, and design tokens, not just pixels.
//
// Usage:
//   node scripts/kimi-gui-review.mjs [extraFile1 extraFile2 ...]
// Extra files (e.g. a client/graphics/*.js UI layer) are appended verbatim.
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const ROOT = '/home/miltron/unreal'
const files = [
  'public/index.html',
  'public/css/styles-v0.0.1.css',
  // Babylon rendering layer — scene/camera/lights, particle/muzzle FX, kill feedback.
  'client/graphics/BABYLONRenderer.js',
  'client/graphics/firingFx.js',
  'client/graphics/FragLayer.js',
  ...process.argv.slice(2).map((p) => p.replace(`${ROOT}/`, '')),
]

const bundle = files
  .map((f) => {
    const body = readFileSync(`${ROOT}/${f}`, 'utf8')
    const lang = f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'js'
    return `\n===== FILE: ${f} =====\n\`\`\`${lang}\n${body}\n\`\`\``
  })
  .join('\n')

const PERSONA = `You are a world-class frontend, game-UI, AND realtime-graphics engineer. Your taste
is the intersection of a shipped AAA shooter HUD lead (Halo, UT, Apex), a modern
web design-systems engineer, and a Babylon.js/WebGL technical artist. You read raw
HTML + CSS + Babylon.js fluently and reason about DOM structure, CSS architecture,
design tokens, responsive/mobile behavior, motion, readability under pressure, and
accessibility — AND about scene rendering: lighting rig, materials/PBR, post
process, particle systems, muzzle/impact FX, camera, and the game-feel "juice" that
sells every shot. Not just how it looks — how it's built.

THE PROJECT:
Frag Arena — a fast browser arena FPS (Babylon.js, UT99-meets-Halo feel), live at
sol-pkmn.fun. Solo dev. The UI you're reviewing is the ENTIRE presentation layer:
- The in-game HUD (top match strip, dynamic per-weapon crosshair, health panel,
  weapon/ammo panel, hit marker, damage flash, YOU DIED state).
- The entry/main menu which doubles as the loading screen (PLAY button fills with
  load progress), a HOW TO PLAY modal, a SETTINGS pause menu, a splash screen.
- It must work on desktop AND mobile (touch controls exist separately). Dark,
  tactical, competitive-shooter aesthetic. Fonts: Chakra Petch, Teko, Inter.

You are NOT redesigning from scratch. You are elevating what's there.

HOW TO REVIEW:
Read the actual markup and CSS. Ground every point in a specific selector, element
id, custom property, or line of code — never generic advice. When you propose a
change, give the concrete CSS/HTML to change it to, tight enough to paste.

STRUCTURE YOUR RESPONSE:

1. FIRST IMPRESSION — 2-3 blunt sentences. Does this read as a premium competitive
   shooter, or as a hobby project? Where does it land on that spectrum and why?

2. HUD (in-game) — the stuff a player stares at for hours. Crosshair, health,
   ammo, hit feedback, death state. What's hurting readability / game-feel / the
   "juice"? Priority-ordered, each with the exact selector and a concrete fix.

3. MENU & ONBOARDING — entry/loading screen, HOW TO PLAY, settings, splash. First
   impression for a new player landing from a link. What's weak, what to change.

4. CSS ARCHITECTURE — tokens, naming, duplication, responsive strategy, motion.
   Is this maintainable? Call out specific smells with line-level fixes.

5. RENDERING & FX — the Babylon layer (BABYLONRenderer.js, firingFx.js,
   FragLayer.js). Lighting rig, materials, post-processing, particle/muzzle/impact
   FX, camera feel, and the "juice" (recoil kick, hit flashes, screen shake, damage
   feedback). What would make this LOOK and FEEL like a premium shooter? Concrete
   Babylon changes — specific lights, materials, particle params, post-process
   passes (glow/bloom/vignette/chromatic), camera shake. Cheap wins vs. big swings.

6. THE TOP 5 — if the dev only does five things this week, ranked, each with the
   exact code change and the payoff. This is the section that matters most.

7. ONE THING THEY GOT RIGHT — something specific and real to protect. No filler.

Be opinionated, specific, and paste-ready. Short tight paragraphs or bullets.
No generic platitudes, no "consider maybe possibly." If something is amateur-hour,
say so and show the fix.`

const body = {
  model: 'moonshotai/kimi-k3',
  messages: [
    { role: 'system', content: PERSONA },
    {
      role: 'user',
      content: `Here is the complete GUI for Frag Arena. Review it per your structure.\n${bundle}`,
    },
  ],
  temperature: 0.7,
  max_tokens: 16384,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX = 30
let res, json
for (let attempt = 1; attempt <= MAX; attempt++) {
  res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://sol-pkmn.fun',
      'X-Title': 'Frag Arena GUI review',
    },
    body: JSON.stringify(body),
  })
  json = await res.json()
  if (res.ok) break
  if (res.status === 503 || res.status === 429) {
    if (attempt === MAX) break
    const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
    const wait = Math.min(15000, Math.max(3000, ra * 1000)) // 3–15s, honor upstream hint
    console.error(`# ${res.status} upstream-busy — waiting ${wait / 1000}s (attempt ${attempt}/${MAX})`)
    await sleep(wait)
    continue
  }
  console.error('HTTP', res.status, JSON.stringify(json, null, 2))
  process.exit(1)
}
if (!res.ok) {
  console.error('gave up:', res.status, JSON.stringify(json, null, 2))
  process.exit(1)
}
console.log(json.choices?.[0]?.message?.content ?? JSON.stringify(json, null, 2))
