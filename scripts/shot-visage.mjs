// Load the artist's OBJ map in a standalone Babylon page (real Chrome via puppeteer),
// frame it, drop a 1-unit reference cube (our player unit) for scale, and screenshot
// top-down + 3/4 perspective. Prints the measured bounding box. Set ZUP=1 to rotate
// Z-up -> Y-up.  Run: node scripts/shot-objmap.mjs
import http from 'http'; import fs from 'fs'; import path from 'path'
import puppeteer from 'puppeteer-core'
const ROOT = path.resolve(process.env.HOME, 'unreal')
const OUT = path.resolve(ROOT, '_work/objmap'); fs.mkdirSync(OUT, { recursive: true })
const PORT = 8097
const ROTX = parseFloat(process.env.ROTX||'0')
const MAP = '/assets/maps/CTF-Visage/CTF-Visage.obj'
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MIME = { '.js':'text/javascript','.obj':'text/plain','.mtl':'text/plain','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.html':'text/html' }

const PAGE = `<!doctype html><html><head><meta charset=utf8><style>html,body,#c{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0b12}</style>
<script src="/node_modules/babylonjs/babylon.js"></script>
<script src="/node_modules/babylonjs-loaders/babylonjs.loaders.js"></script></head>
<body><canvas id=c></canvas><script>
const rotx = ${ROTX} * Math.PI/180;
const engine = new BABYLON.Engine(document.getElementById('c'), true);
const scene = new BABYLON.Scene(engine); scene.clearColor = new BABYLON.Color3(0.04,0.04,0.07);
const cam = new BABYLON.ArcRotateCamera('cam', -Math.PI/4, Math.PI/3, 200, BABYLON.Vector3.Zero(), scene);
cam.minZ = 0.05; cam.maxZ = 5000;
const h = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0.3,1,0.2), scene); h.intensity = 0.9;
const d = new BABYLON.DirectionalLight('d', new BABYLON.Vector3(-0.5,-1,0.4), scene); d.intensity = 0.8;
window.__ready = false;
// compact copy of client/graphics/mapLights.js bakeVertexColors (harness can't bundle imports)
const TYPEW = { Steady:1, Pulse:0.75, SubtlePulse:0.85, Blink:0.5, Strobe:0.55 };
const AMBIENT = ${process.env.AMBIENT||0.25}, GAIN = ${process.env.GAIN||0.8};
function bakeVC(P, N, lights) {
  const n = P.length/3, out = new Float32Array(n*4);
  const L = lights.map(l => ({x:l.pos_m[0],y:l.pos_m[1],z:l.pos_m[2],r:Math.max(l.radius_m||15,.001),
    w:(l.brightness/255)*(TYPEW[l.type]??1),c:l.rgb||[1,1,1]})).filter(l=>l.w>0.003);
  for (let i=0;i<n;i++){
    const px=P[i*3],py=P[i*3+1],pz=P[i*3+2],nx=N[i*3],ny=N[i*3+1],nz=N[i*3+2];
    let r=AMBIENT,g=AMBIENT,b=AMBIENT;
    for (const l of L){
      const dx=l.x-px,dy=l.y-py,dz=l.z-pz;
      if(dx>l.r||dx<-l.r||dy>l.r||dy<-l.r||dz>l.r||dz<-l.r)continue;
      const d2=dx*dx+dy*dy+dz*dz; if(d2>=l.r*l.r)continue;
      const d=Math.sqrt(d2), att=1-d/l.r;
      let inc=1; if(d>1e-4){const dot=(dx*nx+dy*ny+dz*nz)/d; inc=0.35+0.65*Math.max(dot,0);}
      const e=l.w*att*att*inc*GAIN; r+=l.c[0]*e; g+=l.c[1]*e; b+=l.c[2]*e;
    }
    out[i*4]=Math.min(r,1.5); out[i*4+1]=Math.min(g,1.5); out[i*4+2]=Math.min(b,1.5); out[i*4+3]=1;
  }
  return out;
}
BABYLON.SceneLoader.ImportMesh('', '/assets/maps/CTF-Visage/', 'CTF-Visage.obj', scene, async (meshes) => {
  try {
    const lj = await (await fetch('/assets/maps/CTF-Visage/CTF-Visage.lights.json')).json();
    meshes.forEach(m => {
      if (!m.getTotalVertices || m.getTotalVertices()===0) return;
      const p = m.getVerticesData(BABYLON.VertexBuffer.PositionKind), nn = m.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      if (p && nn) m.setVerticesData(BABYLON.VertexBuffer.ColorKind, bakeVC(p, nn, lj.lights));
    });
    console.log('baked lights:', lj.lights.length);
  } catch(e) { console.log('light bake skipped: '+e); }
  const root = new BABYLON.TransformNode('root', scene);
  meshes.forEach(m => { if (!m.parent) m.parent = root; });
  root.rotation.x = rotx;
  root.computeWorldMatrix(true);
  // merged bounds
  let min = new BABYLON.Vector3(1e9,1e9,1e9), max = new BABYLON.Vector3(-1e9,-1e9,-1e9);
  meshes.forEach(m => { if(!m.getBoundingInfo)return; if(m.getTotalVertices && m.getTotalVertices()===0)return; m.computeWorldMatrix(true); const b=m.getBoundingInfo().boundingBox;
    min = BABYLON.Vector3.Minimize(min, b.minimumWorld); max = BABYLON.Vector3.Maximize(max, b.maximumWorld); });
  const size = max.subtract(min); const center = min.add(max).scale(0.5);
  window.__bounds = { min:[min.x,min.y,min.z], max:[max.x,max.y,max.z], size:[size.x,size.y,size.z], center:[center.x,center.y,center.z] };
  // 1-unit reference cube (our player unit) on the floor near center, bright
  const ref = BABYLON.MeshBuilder.CreateBox('ref', { size: 1 }, scene);
  ref.position.set(center.x, min.y + 0.5, center.z);
  const rm = new BABYLON.StandardMaterial('rm', scene); rm.emissiveColor = new BABYLON.Color3(1,0.1,0.1); ref.material = rm;
  // frame camera
  cam.target = center; cam.radius = Math.max(size.x,size.y,size.z) * 1.4;
  window.__ready = true;
}, null, (s,msg,e)=>{ window.__err = String(msg||e); window.__ready = true; });
engine.runRenderLoop(()=>scene.render());
window.__snap = (a,b,r) => { cam.alpha=a; cam.beta=b; if(r)cam.radius=r; for(let i=0;i<8;i++)scene.render(); };
</script></body></html>`

const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/' || p === '/mapview') { res.writeHead(200,{'Content-Type':'text/html'}); return res.end(PAGE) }
  // /node_modules/* serves from the repo root; everything else (assets, maps) from public/
  const base = p.startsWith('/node_modules') ? ROOT : path.join(ROOT, 'public')
  const f = path.join(base, path.normalize(p))
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res)
})
await new Promise(r=>server.listen(PORT,r))
const browser = await puppeteer.launch({ executablePath: CHROME, headless:'new',
  args:['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1280,800'] })
try {
  const page = await browser.newPage(); await page.setViewport({ width:1280, height:800 })
  const errs=[]
  page.on('console',m=>{ console.log('C['+m.type()+']', m.text().slice(0,200)); if(m.type()==='error') errs.push(m.text().slice(0,140)) })
  page.on('pageerror', e=>console.log('PAGEERR', String(e).slice(0,300)))
  page.on('requestfailed', r=>console.log('REQFAIL', r.url().slice(-60), r.failure()?.errorText))
  await page.goto(`http://localhost:${PORT}/mapview`, { waitUntil:'domcontentloaded' })
  await page.waitForFunction('window.__ready===true', { timeout: 20000 }).catch(()=>console.log('TIMEOUT waiting __ready; __ready=', 'n/a'))
  const bounds = await page.evaluate(()=>window.__bounds); const err = await page.evaluate(()=>window.__err)
  console.log('ROTX='+ROTX+'  err='+(err||'none'))
  console.log('BOUNDS '+JSON.stringify(bounds))
  const tag = 'rot'+ROTX
  await page.evaluate(()=>window.__snap(-Math.PI/2, 0.02)); await sleep(200)
  await page.screenshot({ path:`${OUT}/${tag}-top.png` })
  await page.evaluate(()=>window.__snap(-Math.PI/4, Math.PI/3)); await sleep(200)
  await page.screenshot({ path:`${OUT}/${tag}-persp.png` })
  console.log('WROTE '+OUT+'/'+tag+'-{top,persp}.png  console_errors='+(errs.length))
} finally { await browser.close(); server.close() }
