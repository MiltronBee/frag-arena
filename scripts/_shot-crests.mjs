import puppeteer from "puppeteer-core"
import fs from "fs"
const OUT = process.env.HOME + "/unreal/_work/crest-shots"; fs.mkdirSync(OUT,{recursive:true})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await puppeteer.launch({ executablePath:"/usr/bin/google-chrome", headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--mute-audio","--window-size=1280,720"] })
try {
  const p = await b.newPage(); await p.setViewport({width:1280,height:720})
  await p.goto("https://sol-pkmn.fun/", { waitUntil:"domcontentloaded" })
  await sleep(2500); await p.keyboard.press("Enter").catch(()=>{}); await sleep(1200)
  await p.click("#enter-arena").catch(()=>{})
  await p.waitForFunction("window.gameClient?.simulator?.myRawEntity", { timeout:30000 })
  await sleep(2000)
  await p.evaluate(() => ["entry-overlay","splash","menu","main-menu"].forEach(id=>{const el=document.getElementById(id); if(el) el.style.display="none"}))
  const views = [
    { name:"red-crest",  x:-64, z:-2, y:-15, yaw:-1.35, pitch:0.05 },
    { name:"blue-crest", x:11,  z:0,  y:-22, yaw:1.55,  pitch:0.10 },
    { name:"west-deco",  x:-74, z:-2, y:-17, yaw:-1.55, pitch:0.10 },
  ]
  for (const v of views) {
    await p.evaluate((v)=>{ const s=window.gameClient.simulator, e=s.myRawEntity
      e.x=v.x; e.z=v.z; e.y=v.y; e.velX=e.velY=e.velZ=0; if(e.mesh) e.mesh.position.set(v.x,v.y,v.z)
      const cam=s.camera||s.renderer?.camera||s.renderer?.scene?.activeCamera
      if(cam){ if(cam.position) cam.position.set(v.x,v.y+1.4,v.z); if("rotation" in cam){cam.rotation.x=-v.pitch; cam.rotation.y=v.yaw} } }, v)
    for(let i=0;i<30;i++){ await p.evaluate(()=>{try{window.gameClient.simulator.renderer.scene.render()}catch(e){}}); await sleep(16) }
    await p.screenshot({ path:`${OUT}/${v.name}.png` }); console.log("shot", v.name)
  }
} finally { await b.close() }
