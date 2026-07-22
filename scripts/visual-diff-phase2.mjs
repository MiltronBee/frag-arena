// Phase 2 visual-drift diff: per-pair mismatched-pixel percentage, baseline (Babylon 4.0.3)
// vs phase2 (Babylon 9.17.0). Writes a per-pair diff PNG into phase2-shots/diff/.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const BASE = 'backups/upgrade-20260719-1425/baseline-shots'
const CUR = 'backups/upgrade-20260719-1425/phase2-shots'
const DIFFDIR = `${CUR}/diff`
mkdirSync(DIFFDIR, { recursive: true })

const names = [
  'grove-persp', 'grove-top', 'visage-persp', 'visage-top',
  'rifle-hip', 'rifle-ads', 'pistol-hip', 'pistol-ads',
  'ingame-map-eye', 'ingame-map-eye2', 'ingame-map-overview',
  'ingame-natural-spawn', 'ingame-grotto', 'ingame-torch-hall',
]

const rows = []
for (const n of names) {
  try {
    const a = PNG.sync.read(readFileSync(`${BASE}/${n}.png`))
    const b = PNG.sync.read(readFileSync(`${CUR}/${n}.png`))
    if (a.width !== b.width || a.height !== b.height) {
      rows.push({ n, pct: 'DIM', detail: `${a.width}x${a.height} vs ${b.width}x${b.height}` })
      continue
    }
    const { width, height } = a
    const diff = new PNG({ width, height })
    const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 })
    const total = width * height
    const pct = (mismatched / total) * 100
    writeFileSync(`${DIFFDIR}/${n}.diff.png`, PNG.sync.write(diff))
    rows.push({ n, pct: pct.toFixed(3), detail: `${mismatched}/${total}` })
  } catch (e) {
    rows.push({ n, pct: 'ERR', detail: e.message })
  }
}

rows.sort((x, y) => (parseFloat(y.pct) || 0) - (parseFloat(x.pct) || 0))
console.log('\n=== Visual drift: baseline(4.0.3) vs phase2(9.17.0) — mismatched-pixel % (threshold 0.1) ===')
console.log('pair'.padEnd(24), 'mismatch%'.padStart(10), '  pixels')
for (const r of rows) console.log(r.n.padEnd(24), String(r.pct).padStart(10), '  ' + r.detail)
const nums = rows.map(r => parseFloat(r.pct)).filter(x => !isNaN(x))
if (nums.length) {
  console.log(`\nworst ${Math.max(...nums).toFixed(3)}%  mean ${(nums.reduce((a, c) => a + c, 0) / nums.length).toFixed(3)}%  (over ${nums.length} pairs)`)
}
