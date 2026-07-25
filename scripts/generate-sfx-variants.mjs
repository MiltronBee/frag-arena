// Generate SFX VARIANTS via the ElevenLabs Sound Effects API — the "sound variety"
// pass. Sibling of scripts/generate-sfx.mjs (same key, same endpoint, same mp3
// validation + rate-limit pacing); the difference is WHAT it authors.
//
// WHY: the shipping library has exactly ONE clip per event, so every rifle shot,
// every grunt and every melee-range flesh hit is the SAME waveform. WeaponAudio
// masks that with ±6% playbackRate jitter, but a repeated identical sample still
// reads as "machine-cloned" — the #1 tell of a cheap-sounding shooter, and it is
// worst exactly on the high-repetition events (fire, pain, impact).
//
// WHAT: for each high-repetition event this authors N EXTRA takes as
//   public/assets/sfx/<base>_v2.mp3, _v3.mp3, ...
// The EXISTING public/assets/sfx/<base>.mp3 stays untouched and remains take #1,
// so this script can never regress the audition-approved shipping sound. At
// runtime WeaponAudio picks uniformly among {base, _v2, _v3, ...} per trigger
// (see _pickVariant), so nothing breaks if a variant is missing or its fetch fails.
//
// Prompts are deliberately RE-WORDED per take (not the same string re-rolled) so
// the takes differ in character — a different mechanical emphasis, a different
// room, a different aggression — instead of being N samples of one distribution.
// They stay inside the established house style from generate-sfx.mjs: ballistic
// (not sci-fi), dry, close-up, punchy, arcade-shooter energy.
//
// Usage:
//   node scripts/generate-sfx-variants.mjs                # generate everything missing
//   node scripts/generate-sfx-variants.mjs --only pain_grunt
//   node scripts/generate-sfx-variants.mjs --force         # regenerate all
//   node scripts/generate-sfx-variants.mjs --list          # print manifest only
//
// AFTER running: `bash scripts/trim-sfx-variants.sh` (strips leading silence +
// caps the fire tails exactly like trim-sfx.sh does for the base clips) — an
// untrimmed leading pad reads as input lag because WeaponAudio starts clips at
// ctx.currentTime with no offset.
//
// Key: read from ~/solSoccer/.env as LABS=sk_... (never printed, never committed).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT_DIR = path.resolve('public/assets/sfx')
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation'
const ENV_FILE = path.join(os.homedir(), 'solSoccer', '.env')

// base event name -> array of EXTRA takes (index 0 of this array ships as _v2,
// index 1 as _v3, ...). duration/influence mirror the base clip's spec in
// generate-sfx.mjs so a variant drops in as a like-for-like substitute.
const VARIANTS = {
  // ---- FIRE: the highest-repetition event in the game -----------------------
  rifle_fire: [
    { text: 'heavy assault rifle single gunshot, brutal deep bolt slam, sharp cracking transient, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
    { text: 'battle rifle fires one round, hard snapping report with metallic receiver clank, aggressive, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
  ],
  smg_fire: [
    { text: 'compact submachine gun single gunshot, tight bright metallic snap, fast mechanical clatter, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
    { text: 'machine pistol fires one round, hard dry crack with quick bolt rattle, aggressive, close up, arcade shooter', duration: 0.5, influence: 0.8 },
  ],
  shotgun_fire: [
    { text: 'combat shotgun blast, colossal meaty boom, gritty low crunch, loud, dry, arcade shooter', duration: 0.8, influence: 0.85 },
    { text: 'pump shotgun fires one shell, thunderous explosive roar with heavy mechanical crunch, violent, dry, close range', duration: 0.8, influence: 0.85 },
  ],
  pistol_fire: [
    { text: 'heavy handgun single gunshot, bright hard bang, crisp slide snap, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
    { text: 'large caliber pistol fires one round, deep punchy boom with metallic action clack, aggressive, dry, close up', duration: 0.5, influence: 0.8 },
  ],
  plasma_fire: [
    { text: 'sci-fi plasma rifle single shot, searing electric discharge zap, tight energy crack, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
    { text: 'energy weapon fires one bolt, hot synthetic pulse with crackling static snap, aggressive, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
  ],
  flak_fire: [
    { text: 'flak cannon single blast, ripping shrapnel burst, deep booming concussion, heavy metal clank, loud, dry, arcade shooter', duration: 0.8, influence: 0.85 },
    { text: 'heavy grenade cannon fires one shell, explosive thumping launch with brutal breech clunk, loud, dry, arcade shooter', duration: 0.8, influence: 0.85 },
  ],

  // ---- IMPACTS + PAIN: fire on every single hit, so the most fatiguing -------
  impact_flesh: [
    { text: 'brutal wet flesh impact, thick meaty slap with bone crack, gore hit, loud, close up', duration: 0.5, influence: 0.8 },
    { text: 'heavy bullet hits body, wet squelching thud with sharp bone snap, visceral, close up', duration: 0.5, influence: 0.8 },
    { text: 'savage meat impact, deep wet punch with crunching gristle, brutal gore hit, close up', duration: 0.5, influence: 0.8 },
  ],
  pain_grunt: [
    { text: 'short guttural male pain grunt, sharp winded gasp, gritty retro video game voice, compressed', duration: 0.6, influence: 0.75 },
    { text: 'male soldier takes a hit, brief agonized shout, raw aggressive voice, retro video game, compressed', duration: 0.6, influence: 0.75 },
    { text: 'deep male grunt of pain, choked hard exhale, gritty arcade shooter voice, compressed', duration: 0.6, influence: 0.75 },
  ],

  // ---- LIFECYCLE + FEEDBACK -------------------------------------------------
  death: [
    { text: 'video game player death sound, heavy body collapse thud with dark descending synth fall, arcade game over sting, dry, close up', duration: 1.2, influence: 0.8 },
    { text: 'player dies in arena shooter, brutal impact drop with sinking distorted tone, grim, punchy, dry, close up', duration: 1.2, influence: 0.8 },
  ],
  kill_confirm: [
    { text: 'retro video game kill confirmation, crisp metallic ping, sharp bright satisfying chime', duration: 0.5, influence: 0.8 },
  ],
  weapon_swap: [
    { text: 'fast weapon swap foley, crisp slide rack and magazine seat, snappy mechanical clicks, dry, close up, arcade shooter', duration: 0.5, influence: 0.5 },
    { text: 'quick gun handling foley, metallic bolt pull and strap shift, tight mechanical snap, dry, close up, arcade shooter', duration: 0.5, influence: 0.5 },
  ],
  grenade_explosion: [
    { text: 'grenade explosion, deep concussive blast with sharp shrapnel crack and debris rain, punchy, dry, arcade shooter', duration: 1.2, influence: 0.8 },
    { text: 'frag grenade detonates, violent booming burst with ringing metal fragments, loud, dry, arcade shooter', duration: 1.2, influence: 0.8 },
  ],
}

function readKey() {
  let raw
  try { raw = fs.readFileSync(ENV_FILE, 'utf8') } catch (e) {
    console.error(`Cannot read ${ENV_FILE}: ${e.message}`); process.exit(1)
  }
  const m = raw.match(/^\s*LABS\s*=\s*(.+?)\s*$/m)
  if (!m) { console.error('No LABS=... entry in env file'); process.exit(1) }
  return m[1].replace(/^['"]|['"]$/g, '')
}

// same guard generate-sfx.mjs uses: an ElevenLabs error can come back 200 with a
// JSON/text body, and a truncated write would decode to silence at runtime.
function isValidMp3(buf) {
  if (buf.length < 512) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true   // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true             // MPEG sync
  return false
}

async function genOne(key, name, spec) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text: spec.text,
      duration_seconds: spec.duration,
      prompt_influence: spec.influence,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!isValidMp3(buf)) throw new Error(`response not valid mp3 (${buf.length} bytes)`)
  fs.writeFileSync(path.join(OUT_DIR, `${name}.mp3`), buf)
  return buf.length
}

// flatten VARIANTS into [{ name: 'rifle_fire_v2', base, spec }, ...]
function plan(only) {
  const out = []
  for (const base of Object.keys(VARIANTS)) {
    if (only && base !== only) continue
    VARIANTS[base].forEach((spec, i) => {
      out.push({ name: `${base}_v${i + 2}`, base, spec })
    })
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const list = args.includes('--list')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

  if (only && !VARIANTS[only]) { console.error(`Unknown base event: ${only}`); process.exit(1) }
  const jobs = plan(only)

  if (list) {
    jobs.forEach((j) => console.log(`${j.name.padEnd(24)} ${j.spec.duration}s  ${j.spec.text}`))
    console.log(`\n${jobs.length} variant takes in manifest.`)
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const key = readKey()
  let made = 0, skipped = 0, failed = 0

  for (const j of jobs) {
    const dest = path.join(OUT_DIR, `${j.name}.mp3`)
    if (!force && fs.existsSync(dest)) { console.log(`skip   ${j.name} (exists)`); skipped++; continue }
    try {
      const bytes = await genOne(key, j.name, j.spec)
      console.log(`ok     ${j.name}  ${(bytes / 1024).toFixed(1)} KB`)
      made++
      await new Promise((r) => setTimeout(r, 600)) // gentle on rate limits
    } catch (e) {
      console.error(`FAIL   ${j.name}: ${e.message}`)
      failed++
    }
  }
  console.log(`\nDone: ${made} generated, ${skipped} skipped, ${failed} failed. -> ${OUT_DIR}`)
  console.log('NEXT: bash scripts/trim-sfx-variants.sh')
  if (failed) process.exit(1)
}

main()
