// Generate the arena-announcer VOICE PACKAGE via ElevenLabs Text-to-Speech,
// then apply an ffmpeg "Monster Voice" post-effect to every line.
//
// TARGET SOUND — replicate voicechanger.io's first effect, "Monster Voice
// Changer": a big evil troll/ogre. The character comes from (1) deepening the
// pitch via an oscillating tremolo, (2) SLIGHT distortion (overdrive), and
// (3) rolling off the high frequencies for a smoother, menacing tone. We do all
// of this with ffmpeg so the whole pipeline is reproducible — no web tool.
//
// PIPELINE (per line):
//   1. ElevenLabs TTS -> candidates/<name>_raw.mp3      (clean, unprocessed)
//   2. ffmpeg monster chain, 3 intensity variants  -> candidates/<name>_v1|v2|v3.mp3
//   3. copy the CHOSEN variant                     -> announcer/<name>.mp3
//
// THE MONSTER FFMPEG CHAIN (per variant, params in VARIANTS below):
//   silenceremove(both ends)              -> tight ~0.6-1.4s clip, transient at t=0
//   asetrate=44100*P, aresample=44100     -> pitch DOWN by factor P (deepen troll)
//   atempo=(1/P)                          -> restore original tempo (keep words intelligible)
//   tremolo=f=F:d=D                       -> the "oscillating signals" troll character
//   volume=DdB, asoftclip=type=tanh       -> SLIGHT analog-style distortion (kept intelligible).
//                                            (this ffmpeg build has no `overdrive` filter, so we
//                                            drive a tanh soft-clipper instead — same harmonic grit)
//   lowpass=f=L                           -> filter out highs = smoother menacing tone
//   dynaudnorm                            -> consistent loudness across the whole pack
// Heaviest variant (v3) also adds a light acrusher for extra grit.
//
// Output: public/assets/sfx/announcer/<name>.mp3  (final chosen variant)
//         public/assets/sfx/announcer/candidates/<name>_{raw,v1,v2,v3}.mp3
//         public/assets/sfx/announcer/index.json   (manifest: name -> file)
//
// Idempotent: skips a line whose final .mp3 already exists unless --force.
// BUILD/AUTHOR TIME ONLY — the game NEVER calls ElevenLabs at runtime.
//
// Usage:
//   node scripts/generate-announcer.mjs                 # generate everything missing
//   node scripts/generate-announcer.mjs --only headshot # one line (smoke test)
//   node scripts/generate-announcer.mjs --force         # regenerate all
//   node scripts/generate-announcer.mjs --list          # print manifest, generate nothing
//
// Key: read from ~/solSoccer/.env as LABS=sk_... (never printed, never committed).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// CONFIG — tune these and re-run with --force to re-render the whole pack.
// ---------------------------------------------------------------------------

// Deep/aggressive male preset. "Marcus - authoritative and deep" reads clear and
// low, so it survives the heavy pitch-down without turning to mud. Swap for
// another voice_id (e.g. SOYHLrjzK2X1ezoPC6cr "Harry - Fierce Warrior",
// q3Cn7YL2pKwHVPKtacY3 "Dave - deep and gruff") and --force to re-audition.
const VOICE_ID = 'bqtGibd9LR6cgGFVVu09'
const MODEL_ID = 'eleven_multilingual_v2'
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }

// Which processed variant becomes the final <name>.mp3 the game will load.
const CHOSEN_VARIANT = 'v2'

// The three monster-effect intensities. P = pitch factor (lower = deeper troll);
// atempo is derived as 1/P so words stay intelligible. tremF/tremD = tremolo (oscillation).
// drive = dB pre-gain into the tanh soft-clipper (higher = more slight distortion).
// lowpass = cutoff (roll off highs). crush = optional acrusher bits (null = off).
const VARIANTS = {
  v1: { label: 'light',  P: 0.82, tremF: 5, tremD: 0.25, drive: 4,  lowpass: 3500, crush: null },
  v2: { label: 'medium', P: 0.78, tremF: 6, tremD: 0.35, drive: 7,  lowpass: 3200, crush: null },
  v3: { label: 'heavy',  P: 0.72, tremF: 7, tremD: 0.45, drive: 11, lowpass: 2900, crush: 6 },
}

// Silence-trim threshold (both ends). Keeps the word tight (~0.6-1.4s aim).
const SILENCE_THRESH = '-40dB'

// ---------------------------------------------------------------------------
// THE LINES — name -> spoken text. Short + punchy; the monster effect adds character.
// ---------------------------------------------------------------------------
const LINES = {
  // ---- Combat medals ----
  headshot:        'Headshot!',
  first_blood:     'First blood!',
  double_kill:     'Double kill!',
  triple_kill:     'Triple kill!',
  multi_kill:      'Multi kill!',
  killing_spree:   'Killing spree!',
  rampage:         'Rampage!',
  unstoppable:     'Unstoppable!',
  godlike:         'Godlike!',

  // ---- Match events ----
  fight:           'Fight!',        // match start
  victory:         'Victory!',      // win  (owner may prefer "You win" — edit + --force)
  defeat:          'Defeat!',       // lose (owner may prefer "You lose" — edit + --force)
  draw:            'Draw!',

  // ---- Mode callouts ----
  team_deathmatch: 'Team Deathmatch!',
  capture_the_flag:'Capture the Flag!',
  domination:      'Domination!',

  // ---- Objective (for later CTF / DOM) ----
  flag_taken:      'Flag taken!',
  flag_captured:   'Flag captured!',
  flag_returned:   'Flag returned!',
  point_captured:  'Point captured!',
}

// ---------------------------------------------------------------------------
const OUT_DIR = path.resolve('public/assets/sfx/announcer')
const CAND_DIR = path.join(OUT_DIR, 'candidates')
const ENV_FILE = path.join(os.homedir(), 'solSoccer', '.env')
const TTS_ENDPOINT = (id) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`

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
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true       // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true                 // MPEG frame sync
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// TTS with one retry on transient 429/503.
async function ttsOnce(key, text) {
  const res = await fetch(TTS_ENDPOINT(VOICE_ID), {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!isValidMp3(buf)) throw new Error(`response not valid mp3 (${buf.length} bytes)`)
  return buf
}

async function tts(key, text) {
  try {
    return await ttsOnce(key, text)
  } catch (e) {
    if (e.status === 429 || e.status === 503) {
      console.warn(`  transient ${e.status}, retrying once in 2s...`)
      await sleep(2000)
      return await ttsOnce(key, text)
    }
    throw e
  }
}

// Build the ffmpeg -af monster chain for a variant.
function chainFor(v) {
  const tempo = (1 / v.P).toFixed(4)
  const parts = [
    // Trim leading + trailing silence AND collapse long internal pauses (TTS likes
    // to insert a dramatic mid-word gap on short exclamations). stop_silence leaves
    // a small natural gap so multi-word phrases don't glue together.
    `silenceremove=start_periods=1:start_duration=0:start_threshold=${SILENCE_THRESH}:` +
      `stop_periods=-1:stop_duration=0.12:stop_threshold=${SILENCE_THRESH}:stop_silence=0.05`,
    // deepen (pitch down) then restore tempo
    `asetrate=44100*${v.P}`,
    `aresample=44100`,
    `atempo=${tempo}`,
    // oscillation + distortion + high rolloff
    `tremolo=f=${v.tremF}:d=${v.tremD}`,
    `volume=${v.drive}dB`,
    `asoftclip=type=tanh`,
  ]
  if (v.crush) parts.push(`acrusher=bits=${v.crush}:mode=log:mix=0.35`)
  parts.push(`lowpass=f=${v.lowpass}`)
  parts.push(`dynaudnorm`)
  return parts.join(',')
}

function ffmpeg(inFile, outFile, af) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inFile, '-af', af,
    '-codec:a', 'libmp3lame', '-q:a', '4', outFile], { stdio: 'inherit' })
}

function duration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'csv=p=0', file]).toString().trim()
  return parseFloat(out)
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const list = args.includes('--list')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

  const names = Object.keys(LINES).filter((n) => !only || n === only)
  if (only && names.length === 0) { console.error(`Unknown line: ${only}`); process.exit(1) }

  if (list) {
    names.forEach((n) => console.log(`${n.padEnd(18)} "${LINES[n]}"`))
    console.log(`\n${names.length} lines. voice_id=${VOICE_ID} chosen=${CHOSEN_VARIANT}`)
    console.log(`variants: ${Object.entries(VARIANTS).map(([k, v]) => `${k}(${v.label},P=${v.P})`).join('  ')}`)
    return
  }

  fs.mkdirSync(CAND_DIR, { recursive: true })
  const key = readKey()
  let made = 0, skipped = 0, failed = 0
  const manifest = {
    generated_at: new Date().toISOString(),
    voice_id: VOICE_ID,
    model_id: MODEL_ID,
    chosen_variant: CHOSEN_VARIANT,
    effect: 'ffmpeg monster chain: silenceremove(trim+collapse) -> asetrate/aresample/atempo(deepen, tempo-restored) -> tremolo(oscillation) -> volume+asoftclip=tanh(slight distortion) -> [acrusher on v3] -> lowpass(roll off highs) -> dynaudnorm',
    variants: VARIANTS,
    clips: {},
  }

  for (const name of names) {
    const finalFile = path.join(OUT_DIR, `${name}.mp3`)
    if (!force && fs.existsSync(finalFile)) {
      console.log(`skip   ${name} (exists)`); skipped++
      manifest.clips[name] = {
        text: LINES[name],
        file: `announcer/${name}.mp3`,
        duration: +duration(finalFile).toFixed(3),
        candidates: Object.keys(VARIANTS).map((vk) => `announcer/candidates/${name}_${vk}.mp3`)
          .concat(`announcer/candidates/${name}_raw.mp3`),
      }
      continue
    }
    try {
      // 1. TTS -> raw
      const raw = path.join(CAND_DIR, `${name}_raw.mp3`)
      const buf = await tts(key, LINES[name])
      fs.writeFileSync(raw, buf)
      // 2. all variants
      for (const [vk, v] of Object.entries(VARIANTS)) {
        ffmpeg(raw, path.join(CAND_DIR, `${name}_${vk}.mp3`), chainFor(v))
      }
      // 3. chosen -> final
      fs.copyFileSync(path.join(CAND_DIR, `${name}_${CHOSEN_VARIANT}.mp3`), finalFile)
      const d = duration(finalFile)
      console.log(`ok     ${name.padEnd(18)} ${d.toFixed(2)}s  "${LINES[name]}"`)
      manifest.clips[name] = {
        text: LINES[name],
        file: `announcer/${name}.mp3`,
        duration: +d.toFixed(3),
        candidates: Object.keys(VARIANTS).map((vk) => `announcer/candidates/${name}_${vk}.mp3`)
          .concat(`announcer/candidates/${name}_raw.mp3`),
      }
      made++
      await sleep(500) // gentle pacing
    } catch (e) {
      console.error(`FAIL   ${name}: ${e.message}`)
      failed++
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2))
  console.log(`\nDone: ${made} generated, ${skipped} skipped, ${failed} failed. -> ${OUT_DIR}`)
  console.log(`Manifest: ${path.join(OUT_DIR, 'index.json')}`)
  if (failed) process.exit(1)
}

main()
