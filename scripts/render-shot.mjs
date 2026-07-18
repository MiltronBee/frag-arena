// Render the first-person viewmodel headless and screenshot it at hip + aimed for
// Rifle (reference) and Pistol (reported broken). Serves public/, boots the real
// client, switches weapons, pumps the render loop, and captures the canvas.
import http from 'http'; import fs from 'fs'; import path from 'path'
import puppeteer from 'puppeteer-core'
const ROOT = path.resolve(process.env.HOME, 'unreal/public'); const PORT = 8095
const OUT = path.resolve(process.env.HOME, 'unreal/_work/ads-shots'); fs.mkdirSync(OUT, { recursive: true })
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.wasm':'application/wasm','.woff2':'font/woff2' }
const server = http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(ROOT,path.normalize(p));if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf')}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)})
await new Promise(r=>server.listen(PORT,r))
const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--mute-audio','--window-size=1280,720']})
try {
  const page=await browser.newPage()
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:20000})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.viewmodel',{timeout:20000})
  const pump = async (ms)=>{ const n=Math.max(1,Math.round(ms/16)); for(let i=0;i<n;i++){ await page.evaluate(()=>{ try{window.gameClient.simulator.renderer.scene.render()}catch(e){} }); await sleep(16) } }
  // hide the entry overlay + splash so the gun is visible
  await page.evaluate(()=>{ ['entry-overlay','splash'].forEach(id=>{const e=document.getElementById(id); if(e){e.style.display='none'}}) })

  const shots = []
  for (const [idx, name] of [[0,'rifle'],[3,'pistol']]) {
    await page.evaluate((i)=>{ window.gameClient.simulator.switchWeapon(i) }, idx)
    await page.waitForFunction((n)=>{ const v=window.gameClient.simulator.viewmodel; return v && v.ready && v.spec && v.spec.name.toLowerCase()===n }, {timeout:20000}, name).catch(()=>{})
    await pump(1500) // settle into idle
    let f = `${OUT}/${name}-hip.png`; await page.screenshot({ path: f }); shots.push(f)
    await page.evaluate(()=>{ const v=window.gameClient.simulator.viewmodel; v._wantActive=true; v.setAim(true) })
    // drive the viewmodel to FULLY aimed (adsT=1) so the ADS holder mount applies —
    // the Simulator's _adsT loop doesn't run without a spawned entity in this harness
    for (let i=0;i<100;i++){ await page.evaluate(()=>{ try{window.gameClient.simulator.viewmodel.update(0.016,false,1.0); window.gameClient.simulator.renderer.scene.render()}catch(e){} }); await sleep(16) }
    f = `${OUT}/${name}-ads.png`; await page.screenshot({ path: f }); shots.push(f)
    const st = await page.evaluate(()=>window.gameClient.simulator.viewmodel.aimState)
    console.log(`${name}: aimState=${st}`)
    await page.evaluate(()=>window.gameClient.simulator.viewmodel.setAim(false))
    await pump(800)
  }
  console.log('WROTE:'); shots.forEach(s=>console.log('  '+s))
} finally { await browser.close(); server.close() }
