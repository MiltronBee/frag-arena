// ROUND-ROBIN panel on the Sniper Rifle scope, via Gemini flash.
//
// Unlike the single-persona consult scripts (gemini-bungie / gemini-shotcaller), this is a
// true round robin: for each topic every seat answers IN TURN and SEES the seats before
// it, so later voices argue with earlier ones instead of restating them. A synthesis pass
// closes each topic with one decision, and the seat order rotates per topic so nobody is
// permanently first (going first is a disadvantage — you get critiqued, you never critique).
//
// Usage: node gemini-sniper-panel.mjs [outdir]
import fs from 'node:fs'

const ENV = '/home/miltron/solSoccer/.env'
const KEY = (fs.readFileSync(ENV, 'utf8').match(/^ALT=(.+)$/m)
  || fs.readFileSync(ENV, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m))?.[1].trim().replace(/['"]/g, '')
if (!KEY) throw new Error(`no ALT or GEMINI_API_KEY in ${ENV}`)

// The user asked for "flash 3.6". Probe newest-first and fall back — an unavailable model
// 404s at request time and would otherwise look like an empty panel.
const MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-3.5-flash']
const OUT = process.argv[2] || '/home/miltron/unreal/scratch/sniper-scope'
fs.mkdirSync(OUT, { recursive: true })

const SEATS = [
  { key: 'sandbox', name: 'RANDALL "HITSCAN" VOSS', brief:
    `id Software / Quake-lineage sandbox engineer, 20 yrs. Owns TTK, spread, recoil and how a
     weapon RELATES to the rest of the rack. Believes a sniper must be a power weapon with a
     clean counterplay window, not a stat check. Allergic to "just add zoom".` },
  { key: 'netcode', name: 'PRIYA NARAYANAN', brief:
    `Distributed-systems / netcode lead who shipped lag compensation for two competitive
     shooters. Owns rewind, hit registration, and what a ONE-SHOT weapon does to a rewind
     budget. Cares about what the server can prove, not what the client claims.` },
  { key: 'ux', name: 'MARCUS OYELARAN', brief:
    `FPS UX/HUD designer. Owns the scope as a READABLE INTERFACE — overlay, FOV math,
     sensitivity scaling, peripheral awareness, and the fact that this game runs in a browser
     on desktop AND mobile with a touch viewmodel. Allergic to UI that lies about hitscan.` },
  { key: 'economy', name: 'JAX "RUGPROOF" MERCER', brief:
    `Web3 game-economy designer. Owns the fact that this weapon is OWNERSHIP-GATED: you hold
     the NFT or you do not carry it, and there are no free floor pickups. Owns how that feels
     to the player who does NOT own it, and whether the match stays fair.` },
]

const GAME = `
=== FRAG ARENA / DEGEN TOURNAMENT — GROUNDED BUILD STATE ===
Browser arena FPS (Babylon.js client, authoritative Node server, nengi netcode) at sol-pkmn.fun.

WEAPON RACK (common/weaponsConfig.js, live values):
  0 Rifle    hitscan  dmg 15  cooldown 0.14s (429rpm)  mag 30  reload 1.5s  range 75  ADS fov 75
  1 SMG      hitscan  dmg 10  750rpm  mag 40  range 60
  2 Shotgun  hitscan  dmg 10 x8 pellets  75rpm  mag 8  range 30  ADS fov 82
  3 Pistol   hitscan  dmg 34  133rpm  mag 6  range 50  head mult 2.5 (all others 2.0)
    ^ Pistol is the FREE SPAWN WEAPON (SPAWN_WEAPON_INDEX = 3). Everyone always has it.

ADS SYSTEM THAT ALREADY EXISTS (do not reinvent — extend it):
  withAds(fov, inTime, outTime, extra) adds six baked anim clips (aim_start/aim_pose/aim_end/
  fire_aiming/breathing_aiming/walk_aiming) plus an \`ads\` block. fov is the world-camera
  target in DEGREES composed onto the user FOV. out is deliberately FASTER than in. Look
  sensitivity while aimed is NOT a fixed multiplier — it is derived from live zoom
  (focal-length matched) in Simulator so hand->pixel travel stays consistent. \`extra\` carries
  ADS GAMEPLAY mults consumed in weapon.fire/firePattern/applyCommand and scaled by
  entity.aimFactor: spreadBaseMult, spreadHeatMult, heatMult, projSpeedMult.
  Existing FOV targets stay >= 75deg deliberately so you are never blind to flankers.

HIT REGISTRATION:
  Server-authoritative. 3-sphere pose model classifies each confirmed hitscan hit into
  head/torso/legs (server/lagCompensatedHitscanCheck.js) and applies zone multipliers in
  GameInstance.damagePlayer — OUTSIDE the reconciled applyCommand path, never on the
  predicted client path. DEFAULT_ZONE_MULTIPLIERS = { head 2.0, torso 1.0, legs 0.7 }.
  LEG_DAMAGE_MULT 0.7 is a house rule, not vanilla UT. Lag comp rewinds with a cap.
  Players have 100 HP, no regen. Armour exists as cosmetic Cloth pieces (no DR today).

CONSTRAINTS:
  - Runs in a browser. Desktop + MOBILE (touch controls, mobile viewmodel, perf-sensitive).
  - Standing constraint: optimise for speed and low latency; measure in us/bytes.
  - Maps are UT99-derived arena maps (DM-Hex][, CTF-Visage etc), mostly TIGHT indoor arenas
    with some long sightlines. Not a battle-royale scale map.
  - The client is bundled; common/ runs on BOTH client and server for prediction, so anything
    in common/ must be pure data / deterministic (no wall-clock, no randomness).

THE NEW WEAPON:
  A SNIPER RIFLE, ownership-gated. Season 1 rules: spawn with the Pistol, everything else is
  an NFT you own. NO FREE PICKUPS off the arena floor — if you do not own the sniper you
  never carry it. Kill its carrier and it DROPS IN COMBAT for you to take for that life.
=== END BUILD STATE ===`

const TOPICS = [
  { key: '1-scope', title: 'THE SCOPE ITSELF',
    q: `Design the scope mechanic concretely, extending the EXISTING withAds/ads system rather
    than inventing a parallel one. Decide and justify with numbers: (a) zoom — single or dual
    stage, and the exact fov degrees, given every current weapon stays >=75deg on purpose and a
    sniper is the first weapon that plausibly breaks that floor; (b) in/out transition seconds
    and whether out stays faster than in; (c) what happens to look sensitivity given the
    engine already focal-length matches it to live zoom; (d) scoped vs hip accuracy via the
    spreadBaseMult/spreadHeatMult/heatMult knobs — including whether hip-fire should be
    deliberately useless; (e) scope sway / breath hold, or explicitly NOT, and why; (f) whether
    firing unscopes, and re-scope timing. Give the literal \`withAds(...)\` argument list you
    would ship.` },
  { key: '2-balance', title: 'BALANCE, TTK AND COUNTERPLAY',
    q: `100 HP, no regen, head 2.0x / torso 1.0x / legs 0.7x, and the Pistol already lands a
    2.5x head finisher at 34 dmg. Decide: does the sniper bodyshot-kill, headshot-kill, or
    neither? Give exact damage, fire cooldown, magazine, reserve ammo, reload and range, and
    show the TTK maths against the existing rack. These are TIGHT UT99 arena maps, not open
    terrain — argue whether a one-shot weapon is even correct here, and if you gut it, say what
    the weapon is FOR instead. Define the counterplay window explicitly: what does a Pistol-only
    player do when they hear the scope, and how long do they have. Address the flinch question
    (does taking damage while scoped disturb aim, and is that client- or server-side).` },
  { key: '3-netcode', title: 'NETCODE, LAG COMP AND WHAT THE SERVER CAN PROVE',
    q: `A one-shot weapon is the worst case for lag compensation — a rewind error is not a
    chip of damage, it is a death. Given hit classification runs server-side in
    lagCompensatedHitscanCheck.js with a 3-sphere pose model and a capped rewind, and damage is
    applied outside the reconciled path: (a) what must be validated server-side about the SCOPE
    STATE itself so a client cannot claim scoped accuracy while hip-firing; (b) how zoom state
    should travel (nengi channel, prediction, or server-only) and what happens on
    misprediction; (c) whether the rewind cap needs to change for this weapon and the risk if it
    does; (d) how the 3-sphere model behaves at long range where sphere size vs pixel size gets
    ugly, and whether headshots at range are provable at all; (e) the specific cheat vectors a
    scoped hitscan one-shot opens in a BROWSER client and which are actually mitigable
    server-side. Name the files that change.` },
  { key: '4-ux', title: 'SCOPE UX ON DESKTOP AND MOBILE',
    q: `Specify the scope as an interface. (a) Overlay treatment — true scope mask, PiP, or
    lens-less FOV pinch — and which is honest about a HITSCAN weapon (a scope overlay that
    implies a projectile drop the engine does not simulate is a lie). (b) What the peripheral
    blackout costs in an arena built around flankers, and how to mitigate. (c) The exact HUD
    state: crosshair, ammo, hit markers, and whether the scope reticle differs from the hip
    crosshair. (d) MOBILE: this game ships touch controls and a mobile viewmodel — how does
    scoping even work on touch, is it a toggle or a hold, and does the mobile player get a
    different (or no) sniper. (e) Audio: the scope-in sound is the single most important
    counterplay signal in the whole design — spec it, including falloff and whether enemies
    hear it. (f) What the OWNER sees that a non-owner does not, without it becoming pay-to-win
    theatre.` },
  { key: '5-ownership', title: 'OWNERSHIP GATING WITHOUT BREAKING THE MATCH',
    q: `This weapon is gated on holding an NFT, read from a PASTED wallet address (read-only,
    never a connect/sign flow). No free pickups: non-owners never spawn with it. Decide: (a) is
    an ownership-gated power weapon in a competitive arena defensible at all, or does it have to
    be cosmetic-only to survive contact with players — argue both and pick; (b) if it stays
    functional, what keeps a lobby fair (matchmaking split, one-per-lobby cap, on-map
    contest/pickup, cooldown, ammo scarcity); (c) the DROP-ON-DEATH rule — how long does a
    looter keep it, does it persist across their deaths, what stops a non-owner farming it all
    match; (d) how the server verifies ownership at match join WITHOUT trusting the client, and
    what happens when the wallet read fails or is stale (a paste is unauthenticated — anyone can
    paste a whale's address, so what does that let them do and how do you stop it); (e) the
    honest failure mode: what does this look like to a new player who owns nothing.` },
]

async function callModel(model, system, user) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  const j = await r.json()
  if (!r.ok) return { err: `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}` }
  const txt = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
  return txt ? { txt } : { err: 'EMPTY ' + JSON.stringify(j).slice(0, 200) }
}

// resolve the model once
let MODEL = null
for (const m of MODEL_CANDIDATES) {
  const probe = await callModel(m, 'reply with OK', 'ping')
  if (!probe.err) { MODEL = m; break }
  console.log(`  ${m}: ${probe.err.slice(0, 90)}`)
}
if (!MODEL) throw new Error('no usable gemini model')
console.log(`model: ${MODEL}\nseats: ${SEATS.map((s) => s.name).join(' | ')}\n`)

const transcript = []
for (const [ti, topic] of TOPICS.entries()) {
  console.log(`\n=== ${topic.title}`)
  // rotate the seat order each topic so going first is not always the same voice
  const order = SEATS.map((_, i) => SEATS[(i + ti) % SEATS.length])
  const said = []

  for (const seat of order) {
    const prior = said.length
      ? `\n\n=== WHAT THE PANEL HAS SAID ON THIS TOPIC SO FAR ===\n${said.map((s) => `--- ${s.name}\n${s.txt}`).join('\n\n')}\n=== END ===\n\nYou go next. Do NOT restate them. Where you disagree, say so by name and say why. Where they are right, build on it and add what only your seat can see.`
      : `\n\nYou are first on this topic. Stake out a concrete position with numbers so the others have something to argue with.`

    const sys = `You are ${seat.name}. ${seat.brief}\n\nYou sit on a five-seat design panel for a shipped browser arena FPS. Be concrete and numeric. Cite the real config values you were given. Never hedge with "it depends" — pick, and say what you are trading away. 500 words max.`
    const res = await callModel(MODEL, sys, `${GAME}\n\n=== TOPIC: ${topic.title} ===\n${topic.q}${prior}`)
    if (res.err) { console.log(`  x ${seat.key}: ${res.err.slice(0, 100)}`); continue }
    said.push({ name: seat.name, key: seat.key, txt: res.txt })
    console.log(`  ok ${seat.key.padEnd(8)} ${res.txt.length} chars`)
  }

  const synth = await callModel(MODEL,
    `You are the panel chair. You do not have a seat and you do not add new opinions. You RESOLVE.`,
    `${GAME}\n\n=== TOPIC: ${topic.title} ===\n${topic.q}\n\n=== THE PANEL ===\n${said.map((s) => `--- ${s.name}\n${s.txt}`).join('\n\n')}\n\n=== YOUR JOB ===\nProduce: (1) DECISIONS — a numbered list of the specific, final calls with concrete values, each marked [unanimous] or [chair ruling] with a one-line reason if the panel split; (2) DISAGREEMENTS — where they genuinely conflicted and which way you ruled; (3) SHIP LIST — the exact code changes, file by file, in order. No hedging.`)

  const md = `# ${topic.title}\n\n${said.map((s) => `## ${s.name}\n\n${s.txt}`).join('\n\n---\n\n')}\n\n---\n\n# CHAIR SYNTHESIS\n\n${synth.txt || synth.err}`
  fs.writeFileSync(`${OUT}/${topic.key}.md`, md)
  transcript.push({ topic: topic.title, synthesis: synth.txt || '' })
  console.log(`  -> ${topic.key}.md`)
}

fs.writeFileSync(`${OUT}/00-SUMMARY.md`,
  `# Sniper scope — panel summary\n\nmodel: ${MODEL}\nseats: ${SEATS.map((s) => s.name).join(', ')}\n\n`
  + transcript.map((t) => `## ${t.topic}\n\n${t.synthesis}`).join('\n\n---\n\n'))
console.log(`\ndone -> ${OUT}/`)
