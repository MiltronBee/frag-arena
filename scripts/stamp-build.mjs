// Cache-busting build stamp. Run AFTER webpack (see `npm run build`).
//
// Computes a single BUILD_ID from the CONTENT of every shipped asset (the JS
// bundle, the CSS, and all weapon GLBs) and writes it into public/index.html:
//   * as `window.__BUILD_ID__` (read by Viewmodel to version GLB URLs), and
//   * as a `?v=<BUILD_ID>` query on the app <script> and the stylesheet <link>.
//
// Because the id is derived from asset content, it changes iff a shipped asset
// changes, and JS + GLBs from one build always share the SAME id. A phone can
// therefore never mix a new bundle with a stale cached GLB (or vice versa): the
// html points every asset at one matched, content-addressed version. index.html
// itself must be served without a long cache (it is the bootstrap that carries
// the new id) — standard for HTML; verify the deploy does not cache it hard.
//
// Idempotent: re-running restamps in place whether or not a query already exists.
import fs from 'fs'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => path.join(root, p)

// Hash the JS bundle, the CSS, and every weapon GLB (sorted for determinism).
const weaponsDir = rel('public/assets/weapons')
const glbs = fs.existsSync(weaponsDir)
  ? fs.readdirSync(weaponsDir).filter((f) => f.endsWith('.glb')).sort()
    .map((f) => 'public/assets/weapons/' + f)
  : []
const assetFiles = [
  'public/js/app-v0.0.1.js',
  'public/css/styles-v0.0.1.css',
  ...glbs,
]
const hash = crypto.createHash('sha256')
let hashed = 0
for (const f of assetFiles) {
  const p = rel(f)
  if (fs.existsSync(p)) { hash.update(fs.readFileSync(p)); hashed++ }
}
if (hashed === 0) {
  console.error('stamp-build: no assets found to hash (did webpack run?)')
  process.exit(1)
}
const BUILD_ID = '0.0.1-' + hash.digest('hex').slice(0, 10)

// Stamp public/index.html — surgical replaces only; all other markup untouched.
const idxPath = rel('public/index.html')
let html = fs.readFileSync(idxPath, 'utf8')

// 1) app bundle: set/replace the ?v= query
html = html.replace(
  /(<script src="js\/app-v[0-9.]+\.js)(\?v=[^"]*)?"/,
  `$1?v=${BUILD_ID}"`)
// 2) stylesheet: set/replace the ?v= query
html = html.replace(
  /(href="css\/styles-v[0-9.]+\.css)(\?v=[^"]*)?"/,
  `$1?v=${BUILD_ID}"`)
// 3) inline build id: drop any prior injection, then inject fresh right before
//    the app <script> so it is defined before the bundle executes
html = html.replace(/[ \t]*<script>window\.__BUILD_ID__=[^<]*<\/script>\n/g, '')
html = html.replace(
  /([ \t]*)(<script src="js\/app-v)/,
  `$1<script>window.__BUILD_ID__="${BUILD_ID}";</script>\n$1$2`)

fs.writeFileSync(idxPath, html)
console.log('stamp-build: BUILD_ID=%s (hashed %d assets)', BUILD_ID, hashed)
