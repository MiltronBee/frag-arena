// Preview the pistol ADS at several holder heights WITHOUT touching weaponsConfig or
// rebuilding (an agent owns those files). Boots the current bundle, switches to the
// pistol, and for each candidate _adsPos.y overrides it at runtime, drives the
// viewmodel to fully-aimed, and screenshots. Compare to pick a lower framing.
import http from 'http'; import fs from 'fs'; import path from 'path'
import puppeteer from 'puppeteer-core'
const ROOT = path.resolve(process.env.HOME, 'unreal/public'); const PORT = 8094
const OUT = path.resolve(process.env.HOME, 'unreal/_work/pistol-heights'); fs.mkdirSync(OUT, { recursive: true })
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
  const pump = async (ms)=>{ const n=Math.max(1,Math.round(ms/16)); for(let i=0;i<n;i++){ await page.evaluate(()=>{ try{ const v=window.gameClient.simulator.viewmodel; v.update(0.016,false,1.0); window.gameClient.simulator.renderer.scene.render() }catch(e){} }); await sleep(16) } }
  await page.evaluate(()=>{ ['entry-overlay','splash'].forEach(id=>{const e=document.getElementById(id); if(e)e.style.display='none'}) })
  // equip pistol (index 3) and settle
  await page.evaluate(()=>{ window.gameClient.simulator.switchWeapon(3) })
  await page.waitForFunction(()=>{ const v=window.gameClient.simulator.viewmodel; return v && v.ready && v.spec && v.spec.name==='Pistol' }, {timeout:20000}).catch(()=>{})
  await pump(1200)
  await page.evaluate(()=>{ const v=window.gameClient.simulator.viewmodel; v._wantActive=true; v.setAim(true) })
  await pump(1200) // reach aimed
  for (const y of [0.03, 0.0, -0.03, -0.06]) {
    await page.evaluate((yy)=>{ window.gameClient.simulator.viewmodel._adsPos.y = yy }, y)
    await pump(500)
    const tag = String(y).replace('.', 'p').replace('-', 'm')
    const f = `${OUT}/pistol-y_${tag}.png`; await page.screenshot({ path: f }); console.log('WROTE ' + f)
  }
} finally { await browser.close(); server.close() }
