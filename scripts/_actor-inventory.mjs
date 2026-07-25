// What dynamic actors does each ROTATION map have EXTRACTED vs WIRED into the registry?
import fs from 'fs'
import path from 'path'
const D = path.join(process.env.HOME, 'unreal/_work/ut-actors')
const m = await import(path.join(process.env.HOME, 'unreal/common/mapRegistry.js'))

const rows = []
for (const slot of m.ROTATION) {
	const rec = m.getMapRecord(slot.mapId)
	const name = rec.name
	const actorsP = path.join(D, name + '.actors.json')
	const moversP = path.join(D, 'movers', name + '.movers.json')
	const actors = fs.existsSync(actorsP) ? JSON.parse(fs.readFileSync(actorsP, 'utf8')) : null
	const movers = fs.existsSync(moversP) ? JSON.parse(fs.readFileSync(moversP, 'utf8')) : null
	const mv = (movers && movers.MOVERS) || []
	const kinds = {}
	for (const x of mv) kinds[x.kind || '?'] = (kinds[x.kind || '?'] || 0) + 1
	rows.push({
		id: slot.mapId,
		name,
		extracted: {
			teleporters: actors ? (actors.TELEPORTERS || []).length : 'NO FILE',
			jumpPads: actors ? (actors.JUMP_PADS || []).length : 'NO FILE',
			movers: movers ? mv.length : 'NO FILE',
			moverKinds: kinds,
		},
		wired: {
			teleporters: rec.TELEPORTERS ? rec.TELEPORTERS.length : '—',
			jumpPads: rec.JUMP_PADS ? rec.JUMP_PADS.length : '—',
			movers: rec.MOVERS ? rec.MOVERS.length : '—',
		},
	})
}
for (const r of rows) {
	console.log(`${r.id.padEnd(14)} ${r.name.padEnd(16)} EXTRACTED tele=${String(r.extracted.teleporters).padStart(2)} jump=${String(r.extracted.jumpPads).padStart(2)} movers=${String(r.extracted.movers).padStart(3)} ${JSON.stringify(r.extracted.moverKinds)}`)
	console.log(`${''.padEnd(31)}WIRED     tele=${String(r.wired.teleporters).padStart(2)} jump=${String(r.wired.jumpPads).padStart(2)} movers=${String(r.wired.movers).padStart(3)}`)
}
