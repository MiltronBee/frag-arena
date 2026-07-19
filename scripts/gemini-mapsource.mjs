// Consult gemini-3.5-flash as an extremely resourceful young indie dev, to crack
// the "get real classic FPS maps into our web engine" problem. Mirrors the invocation
// pattern of scripts/gemini-consult.mjs.
import fs from 'node:fs'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const PERSONA = `You are an EXTREMELY resourceful young indie game developer. You're 24, self-taught, broke, and you ship polished games FAST on a zero-dollar budget because you know every corner of the free/open asset ecosystem, every file-format conversion trick, and every scrappy workaround that actually works. You live in the retro-FPS modding, speedrun, and homebrew scenes. You know how to rip/convert/remix legacy game data, where the CC0/CC-BY gold is buried (Quaternius, Kenney, Poly Haven, OpenGameArt, itch.io, Sketchfab, GitHub, archive.org), and how to fake AAA production values with clever tech instead of money.

You are pragmatic about legal/IP reality and ALWAYS give three tiers for any asset problem: Plan A (fastest thing that works today), Plan B (safest/most legal), Plan C (build-it-yourself/procedural). You are blunt, specific, and you name EXACT tools, repos, URLs, file formats, and commands — never hand-wave, never "you could look into...". If a path is a dead end on Linux or headless, say so and pivot. You optimize for shipping something great THIS WEEK.`

const BRIEF = `
THE PROJECT: a browser FPS (Babylon.js client + Node.js server, all JavaScript) that replicates the FEEL and MAPS of Unreal Tournament '99. It's live at https://sol-pkmn.fun. Netcode/movement/weapons already feel good. The maps are the problem.

WHAT WE WANT: the real classic arena maps, playable in-browser:
- CTF -> Facing Worlds (CTF-Face)   <- top priority, get this first
- Deathmatch -> a great DM map (Deck16][? Morpheus? something iconic)
- Domination -> a great DOM map
- Assault -> a great AS map

OUR ENGINE / CONSTRAINTS (important — these decide what's viable):
- Babylon.js loads .OBJ and .glTF/.glb DIRECTLY, both for client rendering AND in a headless NullEngine on the server (so the SAME mesh can drive server-authoritative collision).
- Server is Linux, headless. We CANNOT run Windows UnrealEd. No GUI.
- Current collision is authoritative on the server: axis-aligned box specs + Babylon moveWithCollisions (ellipsoid-vs-box). We can either (a) collide the capsule against the real map mesh every tick, or (b) auto/hand-generate a simplified collision proxy. Server tick 40Hz, needs to stay cheap.
- We have Node, npm, ffmpeg, Python, Pillow/numpy/scipy on the box. No Blender GUI (could do headless blender if installed). We have puppeteer + headless Chrome (could run Babylon/three.js in a real browser context to bake/convert things).
- Our hand-authored box maps play and look BAD. We want real, correct geometry fast.

THE WALL WE HIT: The one real export (deck_face.zip with CTF-Face + Deck16 OBJ) is gated behind a ut99.org forum login. UnrealEd export is Windows-only. We don't want to hand-rebuild maps from memory again.

QUESTIONS — be brutally specific, give Plan A/B/C with exact tools/commands/URLs:

Q1. FASTEST way to get the REAL CTF-Face geometry as OBJ/glTF onto a Linux headless box. Is there a Linux-native or scriptable path from a UT99 .unr / .t3d to OBJ (any open-source UE1 BSP extractor, python-unreal parser, ucc under wine, etc.)? Any ungated mirrors of already-exported map meshes? Is 'wine + UnrealEd/ucc.exe' actually viable headless?

Q2. SERVER-AUTHORITATIVE COLLISION from a real, messy map mesh in a JS engine at 40Hz: mesh-collide the capsule every tick vs auto-generate a convex/box proxy. What's the scrappy-but-solid move? Any JS/Node tools to auto-generate collision hulls or a navmesh from a visual mesh (recast/detour wasm, v-hacd, mesh voxelization)? Or is hand-placing a few boxes over the real visual mesh actually the pro move?

Q3. If ripping the exact UT maps is a dead end, what's the BEST source of great, loadable (glTF/OBJ), ideally CC0/CC-BY arena maps that feel UT/Quake-ish for DM/DOM/Assault? Consider: Quake .map + TrenchBroom + ericw-tools -> export, Sketchfab downloadables, itch.io kits, procedural blockout. Name specific packs/repos you'd actually use.

Q4. IP reality: we ship on a public site. How bad is it to serve ripped Epic/UT map geometry publicly, and what's the smartest legal-but-still-authentic alternative that gets us 90% of the nostalgia (e.g., faithful remakes under permissive licenses, or "inspired-by" blockouts dressed with CC0 kits)?

Q5. The shortcut we're not seeing. What would YOU do this week to make our four maps real and good?
`

const body = {
  systemInstruction: { parts: [{ text: PERSONA }] },
  contents: [{ role: 'user', parts: [{ text: BRIEF }] }],
  generationConfig: { temperature: 0.6, maxOutputTokens: 6000 },
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.error('Gemini HTTP', res.status, await res.text())
  process.exit(1)
}
const json = await res.json()
const text =
  json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ??
  JSON.stringify(json, null, 2)
console.log(text)
