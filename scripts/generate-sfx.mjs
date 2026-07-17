// Generate layered weapon SFX via the ElevenLabs Sound Effects API.
//
// Philosophy (per design): do NOT generate one monolithic "gun firing" clip.
// Generate each PHYSICAL COMPONENT of the event separately — the powder report,
// the mechanical action, the ejected brass hitting the floor, each reload motion —
// so the client can LAYER + time them per weapon (WeaponAudio.fireComposite /
// reload). Caliber-specific prompts give each gun its own voice from shared parts.
//
// Output: public/assets/sfx/<name>.mp3 (browser-cached, loaded once at audio init).
// Idempotent: skips a file that already exists unless --force. Runs offline at
// build/author time — the game NEVER calls ElevenLabs at runtime.
//
// Usage:
//   node scripts/generate-sfx.mjs                 # generate everything missing
//   node scripts/generate-sfx.mjs --only pistol_report   # one item (smoke test)
//   node scripts/generate-sfx.mjs --force         # regenerate all
//   node scripts/generate-sfx.mjs --list          # print manifest, generate nothing
//
// Key: read from ~/solSoccer/.env as LABS=sk_... (never printed, never committed).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT_DIR = path.resolve('public/assets/sfx')
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation'
const ENV_FILE = path.join(os.homedir(), 'solSoccer', '.env')

// DIRECT whole-event sounds (not layered components — those came out weak). One
// full clip per weapon fire + one per reload; ElevenLabs renders the whole gun.
// Prompts kept short + literal ("AR style rifle firing") — that reads best.
// name -> { text, duration (s, 0.5–30), influence (0–1; higher = more literal) }
const MANIFEST = {
  // ---- FIRE (one full shot per weapon) ----
  // Punchy BALLISTIC (real guns, not sci-fi) but big/dry/arcade — UT99 energy.
  // High prompt_influence forces the aggressive transient instead of a smooth
  // cinematic gunshot. WebAudio layers a synth sub-thump + crack under these
  // (see WeaponAudio.fire), so the AI clip supplies the mid "body + mechanical".
  rifle_fire:    { text: 'heavy assault rifle single gunshot, huge punchy mechanical slap, sharp crisp transient crack, aggressive, dry, close up, arcade shooter', duration: 0.5, influence: 0.8 },
  smg_fire:      { text: 'submachine gun single shot, tight snappy metallic crack, punchy rapid fire, aggressive, dry, close up', duration: 0.5, influence: 0.75 },
  shotgun_fire:  { text: 'massive combat shotgun blast, booming explosive bass thump, heavy mechanical crunch, loud, dry, arcade shooter', duration: 0.8, influence: 0.85 },
  pistol_fire:   { text: 'heavy handgun single gunshot, loud sharp metallic crack, punchy slide snap, aggressive, dry, close up', duration: 0.5, influence: 0.8 },

  // ---- RELOAD (one full reload per weapon; duration ≈ weaponsConfig reloadTime) ----
  rifle_reload:  { text: 'assault rifle reloading, magazine out, fresh magazine in, charging handle racked', duration: 1.5, influence: 0.4 },
  smg_reload:    { text: 'submachine gun reloading, magazine swap and bolt', duration: 1.2, influence: 0.4 },
  shotgun_reload:{ text: 'pump shotgun reloading, shells loaded into the tube and pump racked', duration: 2.2, influence: 0.4 },
  pistol_reload: { text: 'pistol reloading, magazine drop, fresh magazine, slide racked', duration: 1.0, influence: 0.4 },

  // ---- IMPACTS + FEEDBACK ----
  impact_flesh:  { text: 'heavy wet meat impact, bone crunching snap, squish, brutal gore hit, loud, close up', duration: 0.5, influence: 0.8 },
  pain_grunt:    { text: 'guttural male pain grunt, short aggressive shout, gritty retro video game voice, compressed', duration: 0.6, influence: 0.75 },
  kill_confirm:  { text: 'high pitched retro video game kill confirmation, metallic synthetic chime, sharp satisfying ding', duration: 0.5, influence: 0.8 },
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

function isValidMp3(buf) {
  if (buf.length < 512) return false
  // ID3 header, or an MPEG frame sync (0xFF 0xEx/0xFx)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true
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
  const dest = path.join(OUT_DIR, `${name}.mp3`)
  fs.writeFileSync(dest, buf)
  return buf.length
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const list = args.includes('--list')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

  const names = Object.keys(MANIFEST).filter((n) => !only || n === only)
  if (only && names.length === 0) { console.error(`Unknown sound: ${only}`); process.exit(1) }

  if (list) {
    names.forEach((n) => console.log(`${n.padEnd(20)} ${MANIFEST[n].duration}s  ${MANIFEST[n].text}`))
    console.log(`\n${names.length} sounds in manifest.`)
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const key = readKey()
  let made = 0, skipped = 0, failed = 0

  for (const name of names) {
    const dest = path.join(OUT_DIR, `${name}.mp3`)
    if (!force && fs.existsSync(dest)) { console.log(`skip   ${name} (exists)`); skipped++; continue }
    try {
      const bytes = await genOne(key, name, MANIFEST[name])
      console.log(`ok     ${name}  ${(bytes / 1024).toFixed(1)} KB`)
      made++
      await new Promise((r) => setTimeout(r, 600)) // gentle on rate limits
    } catch (e) {
      console.error(`FAIL   ${name}: ${e.message}`)
      failed++
    }
  }
  console.log(`\nDone: ${made} generated, ${skipped} skipped, ${failed} failed. -> ${OUT_DIR}`)
  if (failed) process.exit(1)
}

main()
