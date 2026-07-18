// Generate CANDIDATE fire sounds via ElevenLabs — 4 design directions per weapon —
// for human audition at /sfx-audition.html. The winner per gun gets installed as
// public/assets/sfx/<gun>_fire.mp3 (then run trim-sfx.sh + redeploy).
//
// Directions per gun: A=real/cinematic, B=specific-gun reference, C=arcade punchy,
// D=heavy/brutal. Longer 0.8s durations keep the tail that makes a shot read as a
// shot (install-time trim caps at 0.55s with a slow fade, not the old hard 0.35s).
//
// Usage: node scripts/generate-sfx-candidates.mjs [--force]
// Output: public/assets/sfx/candidates/<gun>_<A-D>.mp3
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT_DIR = path.resolve('public/assets/sfx/candidates')
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation'
const ENV_FILE = path.join(os.homedir(), 'solSoccer', '.env')
const DUR = 0.8

const CANDIDATES = {
  rifle: {
    A: 'single powerful assault rifle gunshot, sharp explosive crack with deep bass punch, close range, dry, sound effect',
    B: 'AK-47 fires one single shot close up, loud violent crack, heavy low end thump, short tail, no music',
    C: 'arcade shooter assault rifle single gunshot, huge punchy slap, crisp aggressive transient, satisfying, dry',
    D: 'battle rifle single round fired, brutal concussive blast, metallic bolt clack, chest-hitting bass, close up',
  },
  smg: {
    A: 'single submachine gun gunshot, tight sharp crack, snappy mechanical action, close range, dry, sound effect',
    B: 'MP5 fires one single shot close up, crisp metallic snap, quick punchy report, short tail, no music',
    C: 'arcade shooter SMG single gunshot, snappy bright crack, fast punchy slap, satisfying, dry',
    D: 'compact machine pistol single round, hard aggressive snap, sharp mechanical clatter, close up',
  },
  // shotgun batch 2 (2026-07-17): user rejected the whole first batch — new directions
  shotgun: {
    A: 'devastating double barrel shotgun blast fired once, deafening deep boom with sharp explosive crack, close up, dry, sound effect',
    B: 'video game super shotgun firing one shot, colossal meaty boom, crunchy bass-heavy impact, extremely satisfying, dry',
    C: 'sawed off shotgun single blast, raw thunderous roar, gritty explosive punch, violent, close range, sound effect',
    D: 'heavy tactical shotgun single shot, tight controlled blast, deep concussive thump with crisp metallic snap, close up, dry',
  },
  pistol: {
    A: 'single heavy pistol gunshot, loud sharp crack, crisp slide action snap, close range, dry, sound effect',
    B: 'desert eagle magnum fires one single shot close up, powerful booming crack, heavy report, short tail, no music',
    C: 'arcade shooter pistol single gunshot, bright punchy crack, snappy satisfying slap, dry',
    D: 'high caliber revolver single round, thunderous hard bang, deep punchy boom, close up',
  },
  plasma: {
    A: 'single sci-fi plasma bolt shot, hot electric zap with a punchy discharge crack, close range, dry, sound effect',
    B: 'energy blaster fires one single bolt close up, searing electric pop, charged snap, short tail, no music',
    C: 'arcade shooter plasma rifle single shot, bright zappy pew with hard transient punch, satisfying, dry',
    D: 'heavy plasma cannon single discharge, violent electric burst, crackling energy slam, close up',
  },
  flak: {
    A: 'single flak cannon blast, explosive burst of shrapnel, deep concussive boom, close range, dry, sound effect',
    B: 'grenade launcher fires one single shell close up, huge hollow thump with metallic clank, short tail, no music',
    C: 'arcade shooter flak cannon single blast, massive chunky boom, violent scattering shrapnel, satisfying, dry',
    D: 'heavy artillery cannon single shot, devastating deep blast, brutal metallic concussion, close up',
  },
}

function readKey() {
  const raw = fs.readFileSync(ENV_FILE, 'utf8')
  const m = raw.match(/^\s*LABS\s*=\s*(.+?)\s*$/m)
  if (!m) { console.error('No LABS=... entry'); process.exit(1) }
  return m[1].replace(/^['"]|['"]$/g, '')
}

function isValidMp3(buf) {
  if (buf.length < 512) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true
  return false
}

const force = process.argv.includes('--force')
fs.mkdirSync(OUT_DIR, { recursive: true })
const key = readKey()
let made = 0, skipped = 0, failed = 0
for (const [gun, dirs] of Object.entries(CANDIDATES)) {
  for (const [letter, text] of Object.entries(dirs)) {
    const dest = path.join(OUT_DIR, `${gun}_${letter}.mp3`)
    if (!force && fs.existsSync(dest)) { skipped++; continue }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text, duration_seconds: DUR, prompt_influence: 0.85 }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!isValidMp3(buf)) throw new Error(`not valid mp3 (${buf.length}B)`)
      fs.writeFileSync(dest, buf)
      console.log(`ok    ${gun}_${letter}  ${(buf.length / 1024).toFixed(1)}KB`)
      made++
      await new Promise((r) => setTimeout(r, 500))
    } catch (e) {
      console.error(`FAIL  ${gun}_${letter}: ${e.message}`)
      failed++
    }
  }
}
console.log(`\n${made} generated, ${skipped} skipped, ${failed} failed -> ${OUT_DIR}`)
if (failed) process.exit(1)
