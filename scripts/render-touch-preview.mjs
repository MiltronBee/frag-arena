// Render + MEASURE the touch controls at multiple phone viewports. Reconstructs
// the #touch-controls DOM (from client/TouchControls.js) over the game backdrop,
// draws a thumb-reach arc from the fire center, and prints a reach/collision
// report (distances, min gaps, left-half intrusion) so ergonomics is verifiable
// with numbers, not just eyeballing.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
let css = readFileSync(`${ROOT}/public/css/styles-v0.0.1.css`, 'utf8')
// optional candidate override appended AFTER the staged CSS (same specificity wins later)
if (process.env.OVERRIDE_CSS) css += '\n/* === CANDIDATE OVERRIDE === */\n' + readFileSync(process.env.OVERRIDE_CSS, 'utf8')
const bg = readFileSync(`${ROOT}/frag-live-desktop.png`).toString('base64')
const REACH = 130   // combat-tier thumb reach (px) from the fire (thumb-rest) center
const MAXREACH = 150

const BTNS = ['touch-fire','touch-aim','touch-jump','touch-reload','touch-switch','touch-throw','touch-gear']

const html = (arc) => `<!doctype html><html><head><meta charset="utf8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0a0e14;}
  body::before{content:'';position:fixed;inset:0;background:url(data:image/png;base64,${bg}) center/cover;filter:brightness(0.5) saturate(0.9);}
  #reach-arc{position:fixed;z-index:99;border-radius:50%;border:2px dashed rgba(127,233,255,0.55);pointer-events:none;}
  #reach-arc2{position:fixed;z-index:99;border-radius:50%;border:1px dashed rgba(255,184,77,0.4);pointer-events:none;}
  ${css}
</style></head><body class="arena-entered">
  <div id="touch-controls" style="opacity:1 !important;">
    <div id="touch-move-zone"></div>
    <div id="touch-look-zone"></div>
    <div id="touch-joy-base" class="active" style="left:110px;top:70%;"><div id="touch-joy-knob" style="transform:translate(calc(20px - 50%),calc(-16px - 50%))"></div></div>
    <div id="touch-fire" class="active"></div>
    <div id="touch-aim" class="is-selected"></div>
    <div id="touch-jump"></div>
    <div id="touch-reload" class="is-cooling" style="--cd:0.62"></div>
    <div id="touch-switch"></div>
    <div id="touch-throw"></div>
    <div id="touch-gear"></div>
  </div>
</body></html>`

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--force-color-profile=srgb'],
})
const page = await browser.newPage()
const views = [
  { name: 'portrait-390x844', w: 390, h: 844 },
  { name: 'portrait-sm-360x640', w: 360, h: 640 },
  { name: 'landscape-844x390', w: 844, h: 390 },
  { name: 'landscape-short-780x360', w: 780, h: 360 },
]

for (const v of views) {
  await page.setViewport({ width: v.w, height: v.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.setContent(html(), { waitUntil: 'domcontentloaded' })
  await new Promise(r => setTimeout(r, 400))

  const report = await page.evaluate((BTNS, REACH, MAXREACH, W) => {
    const c = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { id, x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 }; }
    const R = Object.fromEntries(BTNS.map(id => [id, c(id)]).filter(([,r]) => r))
    const fire = R['touch-fire']
    const dist = (a,b) => Math.round(Math.hypot(a.cx-b.cx, a.cy-b.cy))
    // reach from fire center
    const reach = {}
    for (const id of BTNS) { if (id==='touch-fire'||id==='touch-gear'||!R[id]) continue; const d = dist(fire, R[id]); reach[id] = d + (d>MAXREACH ? ' OUT!' : d>REACH ? ' far' : ' ok') }
    // pairwise nearest-edge gap (approx, circles): center dist - r1 - r2
    const gaps = []
    for (let i=0;i<BTNS.length;i++) for (let j=i+1;j<BTNS.length;j++) {
      const a=R[BTNS[i]], b=R[BTNS[j]]; if(!a||!b) continue
      const g = Math.round(dist(a,b) - a.w/2 - b.w/2)
      if (g < 16) gaps.push(`${BTNS[i].replace('touch-','')}~${BTNS[j].replace('touch-','')}=${g}px`)
    }
    // left-half intrusion (joystick zone) — any button whose left edge < W/2
    const leftIntrude = BTNS.filter(id => R[id] && id!=='touch-gear' && R[id].x < W/2).map(id => `${id.replace('touch-','')}(x=${Math.round(R[id].x)})`)
    // sizes
    const sizes = BTNS.filter(id=>R[id]).map(id => `${id.replace('touch-','')}=${Math.round(R[id].w)}`)
    // HIT-TEST: is each button the top element at its own center? (covered = unclickable)
    const covered = []
    for (const id of BTNS) { if(!R[id]) continue; const el = document.elementFromPoint(R[id].cx, R[id].cy); if (!el || (el.id !== id && el.closest('#'+CSS.escape(id)) === null)) covered.push(`${id.replace('touch-','')}<-${el?el.id||el.tagName:'null'}`) }
    return { fireCenter: {x: Math.round(fire.cx), y: Math.round(fire.cy)}, reach, tightGaps: gaps, leftHalfIntrusion: leftIntrude, sizes, coveredButtons: covered }
  }, BTNS, REACH, MAXREACH, v.w)

  // draw reach arcs centered on fire
  await page.evaluate((cx, cy, REACH, MAXREACH) => {
    for (const [id, rad] of [['reach-arc', REACH], ['reach-arc2', MAXREACH]]) {
      const d = document.createElement('div'); d.id = id
      d.style.left = (cx - rad) + 'px'; d.style.top = (cy - rad) + 'px'; d.style.width = d.style.height = (rad*2) + 'px'
      document.body.appendChild(d)
    }
  }, report.fireCenter.x, report.fireCenter.y, REACH, MAXREACH)

  await page.screenshot({ path: `${ROOT}/_work/ui/preview-${v.name}.png` })
  console.log(`\n### ${v.name}`)
  console.log('  sizes(px):', report.sizes.join(' '))
  console.log('  reach from fire (>150=OUT):', JSON.stringify(report.reach))
  console.log('  tight gaps (<16px):', report.tightGaps.length ? report.tightGaps.join(' ') : 'none')
  console.log('  LEFT-HALF intrusion (joystick zone!):', report.leftHalfIntrusion.length ? report.leftHalfIntrusion.join(' ') : 'none')
  console.log('  COVERED/unclickable buttons:', report.coveredButtons.length ? report.coveredButtons.join(' ') : 'none')
}
await browser.close()
