// Touch ADS button check: under mobile/touch emulation, confirm TouchControls is
// built, the #touch-aim button exists, and a synthetic touchstart/touchend on it
// flips the SAME input.aimDown flag the desktop RMB path uses (so the verified
// Simulator/Viewmodel ADS path applies identically on touch).
import http from 'http'; import fs from 'fs'; import path from 'path'
import puppeteer, { KnownDevices } from 'puppeteer-core'
const ROOT = path.resolve(process.env.HOME, 'unreal/public'); const PORT = 8096
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.wasm':'application/wasm','.woff2':'font/woff2' }
const server = http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(ROOT,path.normalize(p));if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf')}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)})
const results=[]; const check=(n,p,d)=>results.push({n,p:!!p,d})
await new Promise(r=>server.listen(PORT,r))
const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--mute-audio']})
try {
  const page=await browser.newPage()
  await page.emulate(KnownDevices['iPhone 13'])
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:20000})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator',{timeout:15000})
  const built = await page.evaluate(()=>({
    isTouch: window.gameClient.simulator.isTouch,
    hasTouchControls: !!window.gameClient.simulator.touchControls,
    aimBtn: !!document.getElementById('touch-aim'),
    fireBtn: !!document.getElementById('touch-fire'),
  }))
  check('touch device detected', built.isTouch, JSON.stringify(built))
  check('TouchControls constructed', built.hasTouchControls, JSON.stringify(built))
  check('#touch-aim button exists', built.aimBtn, JSON.stringify(built))

  // synthesize a touchstart on the aim button and confirm aimDown latches, then release
  const toggled = await page.evaluate(() => {
    const btn = document.getElementById('touch-aim')
    const inp = window.gameClient.simulator.input
    const mk = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'changedTouches', { value: [{ identifier: 1, clientX: 300, clientY: 600 }] }); return e }
    btn.dispatchEvent(mk('touchstart'))
    const down = inp._currentState.aimDown
    btn.dispatchEvent(mk('touchend'))
    const up = inp._currentState.aimDown
    return { down, up }
  })
  check('touch aim press -> aimDown true', toggled.down === true, JSON.stringify(toggled))
  check('touch aim release -> aimDown false', toggled.up === false, JSON.stringify(toggled))
} finally { await browser.close(); server.close() }
let failed=0; for(const r of results){console.log(`${r.p?'PASS':'FAIL'}  ${r.n}${r.d?'  ['+r.d+']':''}`); if(!r.p)failed++}
console.log(`\n${results.length-failed}/${results.length} checks passed`); process.exit(failed?1:0)
