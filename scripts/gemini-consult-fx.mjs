// Consult gemini-3.5-flash as a game AUDIO + real-time VFX advisor, focused on
// improving Frag Arena's weapon SFX (ElevenLabs-generated) and blood VFX (Babylon
// pooled sprites). Mirrors scripts/gemini-consult.mjs; different persona + brief.
import fs from 'node:fs'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const PERSONA = `You are a veteran game AUDIO DIRECTOR and real-time VFX artist with 25+ years shipping arena shooters (Quake/Unreal Tournament era) and modern browser/WebGL games. You know weapon sound design (layering: transient/crack + body/thump + mechanical + tail, sub-bass, transient shaping, compression, pitch variation) and how to prompt AI sound-effect generators (ElevenLabs) to get punchy, arcade, UT99-flavored results — not thin milsim. You also know real-time blood/impact VFX under tight constraints (billboard sprites, texture atlases, additive vs alpha blending, flipbooks, pooling, mobile fill-rate). You are blunt, specific, and give concrete, implementable recommendations — exact prompts, exact numbers, exact techniques. North star: Unreal Tournament 99 in the browser — juicy, readable, satisfying combat feedback.`

const BRIEF = `
PROJECT: Frag Arena — browser arena FPS, UT99 feel. Babylon.js 4.0.3 client, live at sol-pkmn.fun.
I want to improve TWO things: (A) weapon SFX, (B) blood/impact VFX. The current versions are underwhelming. Give me concrete, specific upgrades.

=== (A) WEAPON SFX — CURRENT STATE ===
- Generated OFFLINE via ElevenLabs Sound Effects API (POST /v1/sound-generation; params: text, duration_seconds [0.5–30], prompt_influence [0–1, higher = more literal to prompt]). Output mp3, loaded into WebAudio buffers.
- Approach: ONE direct whole-gun clip per weapon fire (I first tried layering separate component clips — report + bolt + casing — but the layers came out weak, so I switched to single clips).
- Current prompts (all prompt_influence 0.4):
  * rifle_fire   (0.7s): "AR style assault rifle firing a single shot, punchy and aggressive"
  * smg_fire     (0.6s): "submachine gun firing a single fast shot, tight and snappy"
  * shotgun_fire (0.8s): "combat pump shotgun firing a single loud booming blast"
  * pistol_fire  (0.6s): "handgun pistol firing a single sharp shot"
  * reloads (per weapon, 1.0–2.2s), impact_flesh (0.5s "bullet impact hitting a body, wet heavy thud"), pain_grunt, kill_confirm
- Playback: single clip per shot, ±6% random pitch jitter (so rapid fire isn't cloned), distance-attenuated, through a WebAudio DynamicsCompressor/limiter master bus. Rifle + SMG are fast automatic; shotgun/pistol semi.
- Problem: the gun sounds feel thin / weak / not satisfying, not that arcade UT99 punch.
- I CAN in WebAudio: layer multiple buffers, pitch-shift, add a synthesized sub-bass/thump oscillator per shot, apply gain envelopes, run everything through the compressor.

QUESTIONS (A):
A1. Give me BETTER ElevenLabs prompts for all 4 gun fires (rifle/smg/shotgun/pistol) tuned for ARCADE PUNCH (UT99/Quake energy, not realistic milsim), plus recommended duration_seconds and prompt_influence for each. Explain what words/framing make ElevenLabs produce fuller, punchier gunshots.
A2. Is single-clip the right call, or should I layer? If layer, what's the winning recipe for a browser arena shooter (e.g. generate a "boom body" + a "crack transient" + a synthesized sub-thump, mixed at what ratios)? Concrete.
A3. Cheap WebAudio processing to make thin AI gunshots punchier (transient shaping, a sub-bass sine thump layered under each shot with a fast pitch drop — give me freq/decay numbers, saturation, the compressor settings for automatic fire so it slams without clipping).
A4. Anything on the impact_flesh, pain_grunt, kill_confirm to make hits feel meatier.

=== (B) BLOOD / IMPACT VFX — CURRENT STATE ===
- Babylon.js 4.0.3. HARD CONSTRAINT: pooled billboard sprite quads only. NO mesh decals (each is a new mesh + draw call → stutter). No per-frame allocation. Must stay mobile-safe (fill-rate bound). Pool of 192 impact sprites, shared texture atlas.
- On a flesh hit right now:
  * a base "wet splat" mark: the 'hit' sprite (a soft roundish blob texture), tinted red [0.82,0.06,0.06], oriented to the surface normal (decal-like), scale ~1.5× base, life 480ms, alpha-blended.
  * a BURST of 14 billboard droplets: same 'hit' sprite tinted deep red [0.75,0.02,0.02], sprayed outward along the surface normal + random lateral spread, with an upward bias, then gravity (9.8 m/s²). Speeds: outward 3.4, spread ±3.4, up 1.9 m/s. Droplet size 0.6–1.1× base impact scale. Life 650ms. Linear alpha fade over life.
- We only have a few sprite textures: a soft round "hit" blob, a "spark", a "scorch", a "glow". All grayscale, tinted per use.
- Problem: it reads as generic red dots, not visceral/juicy blood. Want it to look better and more satisfying, UT99-style, WITHIN the pooled-sprite/no-decal/mobile constraints.

QUESTIONS (B):
B1. How do I make pooled-sprite blood look genuinely visceral within these constraints? Concrete techniques: sprite texture design (should I author a proper blood-spray / droplet / splat atlas + a flipbook animation? cell layout?), additive vs alpha layering, a dark-red core + brighter red mist, an expanding "puff" of atomized blood at the hit instant, value/color grading.
B2. Motion/timing tuning: are my droplet counts/speeds/life good? What curves (ease, size-over-life, alpha-over-life, stretch along velocity for fast droplets) sell "blood" vs "red confetti"?
B3. Ground pooling without mesh decals — can I fake a lingering blood pool with a pooled flattened quad laid on the floor (short-lived, capped count), and is it worth it?
B4. Screen-space confirm: a brief blood fleck / red vignette on hit-confirm — worth adding? Keep it readable.
B5. Mobile tiering: what to cut first on low-end (droplet count, ground pools, screen-space) to protect fill-rate.

Be specific and concrete. Prefer exact numbers, exact prompt text, exact techniques I can implement today. If my current approach has a fundamental mistake, call it out.
`

const body = {
  systemInstruction: { parts: [{ text: PERSONA }] },
  contents: [{ role: 'user', parts: [{ text: BRIEF }] }],
  generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
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
