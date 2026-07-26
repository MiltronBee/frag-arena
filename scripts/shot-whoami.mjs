import http from 'http'; import fs from 'fs'; import path from 'path'; import puppeteer from 'puppeteer-core'
const ROOT=path.resolve(process.env.HOME,'unreal/public'); const PORT=8063
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.woff2':'font/woff2','.md':'text/plain','.txt':'text/plain','.webp':'image/webp','.jpg':'image/jpeg'}
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(ROOT,path.normalize(p));if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf')}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)})
await new Promise(r=>server.listen(PORT,r))
const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio','--use-gl=angle','--use-angle=swiftshader']})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
for(const [name,vp] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2}]]){
  const p=await b.newPage(); await p.setViewport(vp)
  await p.goto('http://localhost:'+PORT+'/?whoami=1',{waitUntil:'domcontentloaded'}); await sleep(700)
  await p.mouse.click(200,400); await sleep(250); await p.mouse.click(200,400); await sleep(900)
  await p.screenshot({path:`/tmp/whoami-${name}.png`}); await p.close()
}
await b.close(); server.close(); console.log('shot')
