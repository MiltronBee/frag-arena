// Rotation-position persistence for the restart-based map rotation.
//
// The server plays common/mapRegistry.js ROTATION in order, ONE map per process
// lifetime (maps load once into the NullEngine scene, no dispose path). At the end
// of the MATCH_END intermission serverMain advances the index here and exits 0;
// pm2 (production) or scripts/serve-loop.sh (dev) restarts it on the next map.
//
// State lives in .rotation-state.json at the repo root (gitignored). Reads fail
// open to index 0 — a missing/corrupt/out-of-range file just restarts the cycle.
// Writes are atomic (tmp + rename on the same filesystem) so a crash mid-write can
// never leave a truncated file that would otherwise throw on the next boot.
import fs from 'fs'
import path from 'path'
import { ROTATION } from '../common/mapRegistry'

const STATE_FILE = path.resolve(process.cwd(), '.rotation-state.json')

// Current rotation index, clamped to [0, ROTATION.length). Any read/parse failure
// (first boot, deleted file, hand-edited garbage) resets to the top of the cycle.
export function readRotationIndex() {
	try {
		const idx = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).index | 0
		return idx >= 0 && idx < ROTATION.length ? idx : 0
	} catch {
		return 0
	}
}

// Persist the index atomically. updatedAt is informational only (debugging "when
// did the last rotation happen" without trusting file mtimes).
export function writeRotationIndex(index) {
	const tmp = STATE_FILE + '.tmp'
	fs.writeFileSync(tmp, JSON.stringify({ index, updatedAt: new Date().toISOString() }) + '\n')
	fs.renameSync(tmp, STATE_FILE)
}
