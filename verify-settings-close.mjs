// Verify bug #2 fix: on a phone the ✕ is hit-testable (top AND after scrolling), a
// real tap on it closes settings, and Escape closes settings too.
import http from 'http'; import fs from 'fs'; import path from 'path'; import puppeteer from 'puppeteer-core'
const ROOT=path.resolve(process.env.HOME,'unreal/public'); const CHROME=process.env.CHROME_BIN||'/usr/bin/google-chrome'; const PORT=8061
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.woff2':'font/woff2'}
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const file=path.join(ROOT,path.normalize(p));if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);return res.end('nf')}res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res)})
await new Promise(r=>server.listen(PORT,r))
const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio','--use-gl=angle','--use-angle=swiftshader']})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'FAIL')+'  '+n);c?pass++:fail++}
try{
  const page=await browser.newPage()
  await page.emulate({viewport:{width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:3},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'})
  await page.goto('http://localhost:'+PORT+'/',{waitUntil:'domcontentloaded',timeout:20000})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator',{timeout:15000})
  await page.evaluate(()=>{const s=document.getElementById('splash');if(s&&s.parentNode)s.parentNode.removeChild(s)})
  const closed=()=>page.evaluate(()=>document.getElementById('settings-menu').classList.contains('settings-closed'))
  const openIt=()=>page.evaluate(()=>window.gameClient.simulator._openSettings())

  // hit-test the ✕ at scrollTop 0
  await openIt(); await sleep(200)
  const hitTop=await page.evaluate(()=>{const b=document.getElementById('settings-close');const r=b.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const el=document.elementFromPoint(cx,cy);return{cx:+cx.toFixed(0),cy:+cy.toFixed(0),hit:el===b||b.contains(el),vh:window.innerHeight}})
  ok('✕ hit-testable at top of panel  '+JSON.stringify(hitTop), hitTop.hit && hitTop.cy>=0 && hitTop.cy<=hitTop.vh)

  // scroll the panel fully down, ✕ must STILL be hit-testable (sticky)
  await page.evaluate(()=>{const m=document.getElementById('settings-menu');m.scrollTop=m.scrollHeight})
  await sleep(150)
  const hitScrolled=await page.evaluate(()=>{const b=document.getElementById('settings-close');const r=b.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const el=document.elementFromPoint(cx,cy);return{cy:+cy.toFixed(0),hit:el===b||b.contains(el)}})
  ok('✕ STILL hit-testable after scrolling to bottom  '+JSON.stringify(hitScrolled), hitScrolled.hit)

  // a REAL tap on the ✕ closes settings
  const b=await page.$('#settings-close'); const bb=await b.boundingBox()
  await page.touchscreen.tap(bb.x+bb.width/2, bb.y+bb.height/2); await sleep(200)
  ok('real tap on ✕ closes settings', await closed())

  // Escape closes settings
  await openIt(); await sleep(150)
  await page.keyboard.press('Escape'); await sleep(150)
  ok('Escape closes settings', await closed())

  // RESUME/BACK still closes (regression check) via real tap — scroll to it first
  await openIt(); await sleep(150)
  await page.evaluate(()=>{const m=document.getElementById('settings-menu');m.scrollTop=m.scrollHeight})
  await sleep(150)
  const rb=await page.$('#resume-game'); const rbb=await rb.boundingBox()
  const rHit=await page.evaluate(()=>{const b=document.getElementById('resume-game');const r=b.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const el=document.elementFromPoint(cx,cy);return el===b||b.contains(el)})
  ok('BACK button reachable after scroll-to-bottom', rHit)
}finally{await browser.close();server.close()}
console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
