// Renders the brand SVG set: favicon-32.png (real asset) + a preview strip at
// every size the site uses (16 favicon / 30 topbar / 52 entry / 180 splash /
// 26+72 skull) on the site's dark background, for eyeballing before deploy.
// Usage: node scripts/brand-preview.mjs
import puppeteer from 'puppeteer-core'
import fs from 'fs'

const ROOT = '/home/miltron/unreal'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
fs.mkdirSync(`${ROOT}/_work/brand`, { recursive: true })

const b64 = (f) => fs.readFileSync(`${ROOT}/public/assets/brand/${f}`).toString('base64')
const src = (f) => `data:image/svg+xml;base64,${b64(f)}`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()

// 1) favicon-32.png — exact 32px raster of favicon.svg, transparent outside tile
await page.setViewport({ width: 32, height: 32 })
await page.setContent(`<style>*{margin:0}</style><img src="${src('favicon.svg')}" width="32" height="32">`)
await page.screenshot({ path: `${ROOT}/public/assets/brand/favicon-32.png`, omitBackground: true })

// 2) preview strip on the site's dark bg
await page.setViewport({ width: 900, height: 420 })
const cell = (f, s, label) =>
  `<div style="display:inline-block;text-align:center;margin:14px;vertical-align:bottom">
     <img src="${src(f)}" width="${s}" height="${s}" style="display:block;margin:0 auto">
     <small style="color:#888;font:11px monospace">${label} ${s}px</small></div>`
await page.setContent(`<body style="background:#0B0D12;margin:0;padding:10px">
  ${cell('favicon.svg', 16, 'favicon')} ${cell('favicon.svg', 32, 'favicon')}
  ${cell('logo.svg', 16, 'logo')} ${cell('logo.svg', 30, 'logo')} ${cell('logo.svg', 52, 'logo')} ${cell('logo.svg', 180, 'logo')}
  ${cell('skull.svg', 26, 'skull')} ${cell('skull.svg', 72, 'skull')}
</body>`)
await new Promise((r) => setTimeout(r, 300))
await page.screenshot({ path: `${ROOT}/_work/brand/preview-strip.png` })

await browser.close()
console.log('wrote public/assets/brand/favicon-32.png + _work/brand/preview-strip.png')
