import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const PHASE2 = 'backups/upgrade-20260719-1425/phase2-shots'
const PHASE3 = 'backups/phase3-shots'
mkdirSync(`${PHASE3}/diff`, { recursive: true })

// pairs: phase3 filename -> phase2 filename
const pairs = [
  ['ingame-natural-spawn.png', 'ingame-natural-spawn.png'],
  ['ingame-map-overview.png', 'ingame-map-overview.png'],
  ['ingame-map-eye.png', 'ingame-map-eye.png'],
  ['ingame-map-eye2.png', 'ingame-map-eye2.png'],
  ['ingame-grotto.png', 'ingame-grotto.png'],
  ['ingame-torch-hall.png', 'ingame-torch-hall.png'],
  ['rifle-hip.png', 'rifle-hip.png'],
  ['rifle-ads.png', 'rifle-ads.png'],
  ['pistol-hip.png', 'pistol-hip.png'],
  ['pistol-ads.png', 'pistol-ads.png'],
  ['visage-persp.png', 'visage-persp.png'],
  ['visage-top.png', 'visage-top.png'],
  ['grove-persp.png', 'grove-persp.png'],
  ['grove-top.png', 'grove-top.png'],
]
const rows = []
for (const [p3, p2] of pairs) {
  const f3 = `${PHASE3}/${p3}`, f2 = `${PHASE2}/${p2}`
  if (!existsSync(f3)) { rows.push([p3, 'MISSING(p3)', '']); continue }
  if (!existsSync(f2)) { rows.push([p3, 'MISSING(p2)', '']); continue }
  const a = PNG.sync.read(readFileSync(f2))
  const b = PNG.sync.read(readFileSync(f3))
  if (a.width !== b.width || a.height !== b.height) { rows.push([p3, `SIZE ${a.width}x${a.height} vs ${b.width}x${b.height}`, '']); continue }
  const diff = new PNG({ width: a.width, height: a.height })
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 })
  const pct = (100 * n / (a.width * a.height)).toFixed(2)
  writeFileSync(`${PHASE3}/diff/${p3}`, PNG.sync.write(diff))
  rows.push([p3, pct + '%', n + ' px'])
}
console.log('pair'.padEnd(28), 'mismatch', 'pixels')
for (const [n, pct, px] of rows) console.log(n.padEnd(28), String(pct).padStart(8), ' ', px)
