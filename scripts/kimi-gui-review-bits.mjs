// Bit-by-bit Frag Arena GUI review by Kimi K3 (moonshotai/kimi-k3 via OpenRouter).
//
// Why bit-by-bit: sending the whole GUI in one shot trips OpenRouter's per-request
// token-rate limit on this high-demand model (429 storm). So we ask 20 small,
// focused questions instead — each carries ONLY its own slice of code, so every
// request stays tiny (like the ping that always succeeds) and slips under the cap.
//
// Usage:  node scripts/kimi-gui-review-bits.mjs [startBit]
//   startBit (1-based, optional) resumes from that bit — combined output is APPENDED,
//   so a run interrupted at bit 12 can continue with `... 12`.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-20bit-review.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

// file shortcuts
const FILES = {
  H: 'public/index.html',
  C: 'public/css/styles-v0.0.1.css',
  R: 'client/graphics/BABYLONRenderer.js',
  F: 'client/graphics/firingFx.js',
  G: 'client/graphics/FragLayer.js',
}
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')])
)
const lang = (f) => (f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'js')

// slice: [fileKey, fromLine, toLine] (1-based, inclusive) -> fenced block w/ line numbers
function slice([k, a, b]) {
  const f = FILES[k]
  const body = SRC[k].slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')
  return `\n----- ${f}  (lines ${a}-${b}) -----\n\`\`\`${lang(f)}\n${body}\n\`\`\``
}

const PERSONA = `You are a world-class competitive-shooter UI/UX and realtime-graphics engineer —
the taste of a shipped AAA HUD lead (Halo/UT/Apex) crossed with a modern web
design-systems engineer and a Babylon.js/WebGL technical artist. You read raw
HTML/CSS/Babylon.js fluently and reason about DOM structure, CSS tokens, motion,
readability-under-pressure, mobile behavior — and about lighting, materials, post
process, particle/muzzle FX, camera feel, and the "juice" that sells every shot.

PROJECT: Frag Arena — a fast browser arena FPS (Babylon.js, UT99-meets-Halo), live
at sol-pkmn.fun, solo dev. Dark, tactical, competitive. Fonts: Chakra Petch, Teko,
Inter. Desktop + mobile. You are ELEVATING what's there, not redesigning.

You are reviewing ONE focused slice at a time. Stay tightly on the slice you're given.
Ground EVERY point in a specific selector / id / custom property / line number from
the code shown. Give concrete, paste-ready fixes (the exact CSS/HTML/JS to change it
to) — never generic advice, no "consider maybe possibly." Be blunt and specific.

Answer in this shape, tight:
- VERDICT: 1-2 blunt sentences — premium-shooter or hobby, for THIS element, and why.
- ISSUES: priority-ordered bullets, each = [selector/line] problem -> paste-ready fix.
- ONE WIN: the single highest-payoff change for this slice.
Keep it short. No preamble, no restating the task.`

const BITS = [
  { t: 'Crosshair (per-weapon, spread-reactive)', s: [['C', 179, 223], ['H', 45, 68]],
    q: 'The dynamic per-weapon crosshair (SVG). Is the reticle readable over bright + dark scenes, does the spread/bloom feedback read clearly, is the shotgun ring honest? Fixes to legibility, contrast outline, and spread animation feel.' },
  { t: 'Hit marker (bone on hit / blood on kill)', s: [['C', 224, 299], ['H', 69, 69]],
    q: 'The hit marker + kill/skull pop and its keyframes. Does the hit vs heavy-hit vs kill escalation read instantly in a firefight? Timing, scale, color, and "did I actually get the confirm" clarity.' },
  { t: 'Health panel', s: [['C', 300, 314], ['C', 382, 443], ['H', 71, 82]],
    q: 'Health readout + fill track + low-health/overheal states. Readability of the number under fire, threshold recolor, the low-HP pulse, overheal (>100) legibility.' },
  { t: 'Weapon / ammo panel (Halo-style counter)', s: [['C', 315, 532], ['H', 84, 95]],
    q: 'Weapon+ammo plate: mag/reserve counters, weapon-class icon mask, reload + low-ammo states, the corner brackets. Glanceability and the reload/low-ammo cues.' },
  { t: 'Grenade panel', s: [['C', 533, 568], ['H', 100, 103]],
    q: 'Frag-grenade charge indicator. Does it read as ammo-adjacent, is the empty state clear, does it fit the HUD language?' },
  { t: 'Death / respawn card', s: [['C', 569, 610], ['H', 105, 110]],
    q: 'The YOU DIED / RESPAWNING card. Impact vs melodrama, entry motion, does it own the screen without blocking the respawn read?' },
  { t: 'Damage flash + low-HP edge vignette', s: [['C', 611, 634], ['C', 437, 443]],
    q: 'Directional/none damage flash and the persistent low-HP edge vignette. Is getting-hurt feedback punchy and honest, or is it either invisible or nauseating?' },
  { t: 'Top match strip (connection / ping / frags)', s: [['C', 119, 178], ['H', 29, 43]],
    q: 'Top HUD strip: brand lockup, connection chip, ping/build, player count, frag/death tally. Hierarchy, does it distract from center-screen, does the connection state read at a glance?' },
  { t: 'Kill feed / frag banner (FragLayer)', s: [['C', 635, 740], ['G', 32, 120]],
    q: 'Kill-feed rows + the big frag banner. Does a kill feel EARNED and legible, is the banner timing right, does the feed clutter? Judge both the CSS and the FragLayer DOM it drives.' },
  { t: 'Entry menu + PLAY loading button', s: [['C', 741, 1024], ['H', 114, 160]],
    q: 'Entry/main menu that doubles as the loading screen (PLAY button fills with load progress, then unlocks). First impression from a cold link. Layout, the load->unlock motion, callsign input, wallet/how-to buttons.' },
  { t: 'HOW TO PLAY modal', s: [['C', 1025, 1074], ['H', 162, 183]],
    q: 'The HOW TO PLAY ghost modal + control list. Clarity for a brand-new player, desktop vs touch instructions, panel spec consistency.' },
  { t: 'Settings / pause menu', s: [['C', 1075, 1238], ['H', 185, 208]],
    q: 'Settings pause menu: FOV/sensitivity/touch sliders, invert toggle, resume. Range-input styling, layout, does it feel like a real settings panel or a raw form?' },
  { t: 'Splash screen', s: [['C', 1540, 1630], ['H', 249, 261]],
    q: 'The instant brand splash over boot (logo draw-in, auto-advance). Does it set a premium tone or delay the player? Motion + timing.' },
  { t: 'Fonts, color tokens & CSS design-system', s: [['C', 10, 72]],
    q: 'The :root design tokens (color + ammo-HUD palette + fonts). Is this a coherent, maintainable design system? Naming, gaps, duplication, contrast of the palette. Concrete token-level fixes.' },
  { t: 'Mobile: touch controls + responsive HUD', s: [['C', 1287, 1430], ['C', 1431, 1539]],
    q: 'Touch joystick/buttons + the mobile/coarse-pointer HUD reflow. Thumb reach, occlusion of the center, does the HUD survive small/short screens?' },
  { t: 'Lighting rig + camera setup', s: [['R', 66, 162]],
    q: 'Scene lighting (dusk ambient + sun + shadows), the separate viewmodel light rig, and dual-camera setup + image-processing vignette. What makes the arena look flat vs. premium? Cheap wins vs big swings on the lighting rig.' },
  { t: 'Materials / arena PBR look', s: [['R', 168, 231]],
    q: 'Ground + obstacle materials, emissive trim accents, PhotoDome sky. Do the materials read as a real arena or as gray boxes? Concrete material/emissive/fog changes for a competitive-shooter look.' },
  { t: 'FX pooling + post-processing + muzzle light', s: [['R', 73, 84], ['R', 232, 340]],
    q: 'The image-processing pass (tonemap/contrast/vignette), sprite/FX pooling, and the single scene muzzle-flash point light. What post-process passes (glow/bloom/chromatic) or muzzle-light tuning would add the most "juice" for the cost?' },
  { t: 'Per-weapon firing FX identity', s: [['F', 1, 140]],
    q: 'The per-weapon firing-FX config (tracers, muzzle flash, impacts, recoil kick, muzzle light). Does each weapon have a distinct, satisfying signature? Concrete param changes to sharpen per-weapon identity and recoil juice.' },
  { t: 'Recoil / camera-kick & viewmodel juice', s: [['F', 20, 140]],
    q: 'The recoil model: camera positional kick + shake + climb, and viewmodel procedural kick personality. Does firing FEEL weighty and aim-safe? What would make the kick read as impactful without hurting aim?' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const bundle = bit.s.map(slice).join('\n')
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `FOCUS (${n}/20): ${bit.t}\n\n${bit.q}\n\nHere is ONLY the relevant code:\n${bundle}` },
    ],
    temperature: 0.5,
    // kimi-k3 is a reasoning model: it spends completion tokens on a hidden
    // `reasoning` field FIRST. At a full bit's size that reasoning alone can eat
    // ~2k tokens, so a low cap truncates (finish=length) or returns content:null
    // entirely -> the "empty body" retry loops forever. 8000 leaves room for
    // reasoning (~1.3-1.9k) AND the full structured answer.
    max_tokens: 8000,
  }
  const MAX = 40
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res, json
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://sol-pkmn.fun',
          'X-Title': 'Frag Arena GUI review (bits)',
        },
        body: JSON.stringify(body),
      })
      json = await res.json()
    } catch (e) {
      console.error(`  net error (attempt ${attempt}): ${e.message}`)
      await sleep(5000)
      continue
    }
    if (res.ok) {
      const txt = json.choices?.[0]?.message?.content
      if (txt && txt.trim()) return txt
      console.error(`  empty body (attempt ${attempt}) — retrying`)
      await sleep(4000)
      continue
    }
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
      // escalate backoff: 5s -> 25s, honoring upstream hint when given
      const wait = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000))
      console.error(`  ${res.status} busy — wait ${(wait / 1000).toFixed(0)}s (attempt ${attempt}/${MAX})`)
      await sleep(wait)
      continue
    }
    return `**ERROR ${res.status}:** ${JSON.stringify(json?.error ?? json).slice(0, 400)}`
  }
  return `**GAVE UP after ${MAX} attempts (still 429/503).**`
}

const start = Math.max(1, Number(process.argv[2]) || 1)
if (start === 1) writeFileSync(OUT, `# Frag Arena — Kimi K3 bit-by-bit GUI review\n\n`)

for (let i = start - 1; i < BITS.length; i++) {
  const n = i + 1
  const bit = BITS[i]
  process.stderr.write(`\n[${n}/20] ${bit.t} …\n`)
  const ans = await ask(bit, n)
  const block = `\n## ${n}. ${bit.t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500) // gentle pacing between bits
}

process.stderr.write(`\nDONE -> ${OUT}\n`)
