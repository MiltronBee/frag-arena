// Ask Kimi (moonshotai/kimi-k3 via OpenRouter) — reputed to be exceptional at 3D —
// to design a JAW-DROPPING space-arena vista for our Facing-Worlds-style CTF map,
// grounded in our actual Babylon.js renderer. Pattern mirrors kimi-gui-review.mjs.
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const ROOT = '/home/miltron/unreal'
const files = [
  'client/graphics/BABYLONRenderer.js',   // scene, camera, lights, sky, fog, post
  'client/graphics/arenaDressing.js',     // how box obstacles get skinned in the scifi kit
  'common/arenaConfig.js',                // the Facing-Worlds box geometry
]
const bundle = files.map(f => {
  const body = readFileSync(`${ROOT}/${f}`, 'utf8')
  return `\n===== FILE: ${f} =====\n\`\`\`js\n${body}\n\`\`\``
}).join('\n')

const PERSONA = `You are a world-class realtime-graphics technical artist and Babylon.js expert — the
kind who ships the "holy shit" hero shot for AAA arena shooters. You think in lighting
rigs, PBR/StandardMaterial tradeoffs, post-process (bloom/tonemap/vignette), custom
shaders (ShaderMaterial / node material), atmospheric scattering, skyboxes, LOD, draw-call
budgets, and mobile GPU limits. You reason about the ACTUAL engine code you're given and
give concrete, paste-ready Babylon.js 4.0.3 code — never generic "you could try" advice.`

const BRIEF = `
THE GOAL: make our CTF map a JAW-DROPPING space arena — the emotional target is the classic
"two towers on an asteroid, Earth hanging below you in orbit, the Moon in the distance,
stars everywhere" vista, but rendered BEAUTIFULLY and modern, better than a 1999 game. It's
an original tribute (our own geometry — twin towers, a long exposed central platform between
them, a flag deck on each tower, jump-pad lifts). It's live in a browser (Babylon.js 4.0.3),
must run on desktop AND mobile, and it's a fast competitive shooter so it must stay readable
and cheap.

WHAT WE HAVE (see files below):
- BABYLONRenderer.js: the scene. Currently a flat "dusk" PhotoDome skybox (skybox_dusk.png),
  HemisphericLight ambient + one warm DirectionalLight sun + shadow gen, StandardMaterial
  image-processing tonemap/contrast/vignette, EXP2 fog, a dark ground plane. camera minZ 0.05
  maxZ 2000, fov 1.0. Selective GlowLayer already exists (whitelisted to FX sprites only).
- We have these textures on the server already: /assets/space/stars.jpg, earth_day.jpg,
  earth_night.jpg (city lights), moon.jpg. NOT yet wired into a vista.
- arenaDressing.js skins the collision boxes with a small Quaternius sci-fi kit (8 pieces:
  metal/dark platforms, tall + short walls, hollow column, crate, small fan, floor light).
- arenaConfig.js is the Facing-Worlds box geometry (towers at x=+-48 height 8, long platform,
  jump-pads, perimeter walls). All within a +-64 unit box.

DELIVER concrete, paste-ready Babylon.js 4.0.3 for:

1. THE SPACE VISTA (the hero of the whole thing). Give me the exact code to build:
   - A convincing starfield backdrop (emissive, unaffected by fog/scene lights, correct scale
     inside maxZ 2000). Layered/parallax stars if worth it.
   - A big beautiful EARTH hanging below/beside the platform with a REAL day/night terminator:
     earth_day.jpg lit by the sun on the day side, earth_night.jpg city-lights glowing ONLY on
     the dark side. In StandardMaterial the emissive night map bleeds onto the day side — how
     do you solve that cleanly at 4.0.3 (custom ShaderMaterial? fresnel? emissiveFresnelParameters?
     a cheap terminator trick)? Give the shader/material code.
   - A subtle ATMOSPHERE RIM (blue fresnel glow) around Earth's limb — the detail that sells it.
   - A Moon in the distance, sunlit consistently with the Earth + arena.
   - Exact positions/scales so it composes behind the twin towers without clipping the +-64
     playfield or the maxZ 2000 far plane, and reads great from a ~1.8m-tall player camera.

2. LIGHTING/MOOD to match: the sun should be the same star lighting Earth, the towers, and the
   players — coherent direction. What ambient/ground-color + tonemap/exposure changes make a
   space scene read crisp (dark voids, bright rim-lit metal) instead of the current murky dusk?
   Should Earth cast a soft fill (bounce) light onto the underside of the platform? How, cheaply?

3. BLOOM: we only bloom FX sprites today. Should the star field / Earth limb / emissive kit
   trim bloom too? How to extend the GlowLayer or add a cheap threshold bloom without blowing
   the mobile budget or washing out the HUD?

4. THE TWIN TOWERS as a silhouette: with only that 8-piece kit, how would you make the towers
   read as iconic, imposing, team-colored (red vs blue) landmarks against the Earth? Concrete
   dressing/material/emissive ideas per piece.

5. Anything else that would make people go "holy shit" the first time they spawn in — and what
   to AVOID for perf on mobile. Rank your recommendations by impact-per-effort.

Be specific, give code, reason about our actual files.
${bundle}
`

const reqBody = {
  model: 'moonshotai/kimi-k3',
  messages: [
    { role: 'system', content: PERSONA },
    { role: 'user', content: BRIEF },
  ],
  temperature: 0.7,
  max_tokens: 16384,
}

let res, json
res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(reqBody),
})
json = await res.json()
if (!res.ok) {
  console.error('HTTP', res.status, JSON.stringify(json, null, 2))
  process.exit(1)
}
console.log(json.choices?.[0]?.message?.content ?? JSON.stringify(json, null, 2))
