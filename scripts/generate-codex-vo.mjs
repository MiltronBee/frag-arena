// Pre-render the CODEX narration with ElevenLabs, once, at author time.
//
// WHY THIS EXISTS: the Codex shipped narrating through the browser's own
// speechSynthesis, which meant re-synthesising every entry on every click, in whatever
// voice the player's OS happens to have, differently on every platform, and not at all
// where the API is missing or muted. codex.js already had a per-entry `vo` field that
// MenuScreens prefers over TTS — this fills it in.
//
// Deliberately NOT the announcer's monster chain (scripts/generate-announcer.mjs). That
// chain exists to turn a voice into an arena PA barking three words over gunfire. The
// Codex is the one surface in this product meant to be READ, at length, in quiet — it
// wants a clean take. The processing here is only what a spoken-word file needs to sit
// at a consistent level: silence trim and loudness normalisation.
//
// BUILD/AUTHOR TIME ONLY. The game never calls ElevenLabs at runtime.
//
// Usage:
//   node scripts/generate-codex-vo.mjs            # render anything missing
//   node scripts/generate-codex-vo.mjs --force     # re-render everything
//   node scripts/generate-codex-vo.mjs --only the-arsenal
//
// Key: read from ~/solSoccer/.env as LABS=sk_... (never printed, never committed).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { CODEX_ENTRIES, codexNarration } from '../client/config/codex.js'

// CHAVITA — a cloned voice, es-latin-american. It is a SPANISH voice reading ENGLISH
// prose, which multilingual_v2 handles and which is the point: the accent is character,
// and it makes the Codex sound like someone in this world telling you about it rather
// than a stock narrator. If that ever reads wrong, swap the id and --force.
const VOICE_ID = process.env.CODEX_VOICE || 'Ek5c7iQaoVegaQY9r0Ic'
const MODEL_ID = 'eleven_multilingual_v2'
// Higher stability than the announcer preset: this is long-form narration, where
// take-to-take drift across eight files is far more noticeable than in a one-word bark.
const VOICE_SETTINGS = { stability: 0.6, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true }

const OUT_DIR = path.resolve('public/assets/vo/codex')
const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const envPath = path.join(os.homedir(), 'solSoccer', '.env')
const key = fs.readFileSync(envPath, 'utf8').match(/^LABS=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`no LABS=... in ${envPath}`)

fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let made = 0, skipped = 0, failed = 0

for (const entry of CODEX_ENTRIES) {
	if (ONLY && entry.id !== ONLY) continue
	const finalPath = path.join(OUT_DIR, `${entry.id}.mp3`)
	if (fs.existsSync(finalPath) && !FORCE) { console.log(`skip   ${entry.id} (exists)`); skipped++; continue }

	const text = codexNarration(entry)
	let res
	for (let attempt = 1; attempt <= 5; attempt++) {
		res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
			method: 'POST',
			headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
			body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
		})
		if (res.ok) break
		// 429/5xx are capacity; a long entry is worth waiting out rather than losing.
		if (res.status === 429 || res.status >= 500) { console.error(`  ${res.status} — retry ${attempt}/5`); await sleep(15000); continue }
		break
	}
	if (!res.ok) { console.error(`FAIL   ${entry.id}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`); failed++; continue }

	const raw = path.join(OUT_DIR, `${entry.id}.raw.mp3`)
	fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()))
	try {
		// Trim dead air at both ends so pressing LISTEN starts speaking immediately, then
		// normalise so no entry is noticeably louder than its neighbours.
		execFileSync('ffmpeg', ['-y', '-i', raw,
			'-af', 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:detection=peak,'
				+ 'areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:detection=peak,areverse,'
				+ 'dynaudnorm=f=250:g=15',
			'-codec:a', 'libmp3lame', '-q:a', '4', finalPath], { stdio: 'pipe' })
		fs.unlinkSync(raw)
	} catch (e) {
		// ffmpeg missing or unhappy: the unprocessed take is still a usable file.
		fs.renameSync(raw, finalPath)
		console.error(`  (ffmpeg failed for ${entry.id}, shipping the raw take)`)
	}
	const kb = (fs.statSync(finalPath).size / 1024).toFixed(0)
	console.log(`ok     ${entry.id.padEnd(16)} ${String(kb).padStart(4)}kB  ${text.length} chars`)
	made++
}

console.log(`\nDone: ${made} generated, ${skipped} skipped, ${failed} failed. -> ${OUT_DIR}`)
if (failed) process.exitCode = 1
