import puppeteer from "puppeteer-core"
import fs from "fs"
const OUT = process.env.HOME + "/unreal/_work/crest-shots"; fs.mkdirSync(OUT,{recursive:true})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await puppeteer.launch({ executablePath:"/usr/bin/google-chrome", headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--mute-audio","--window-size=1280,720"] })
try {
  const p = await b.newPage(); await p.setViewport({width:1280,height:720})
  await p.goto("https://sol-pkmn.fun/", { waitUntil:"domcontentloaded" })
  await sleep(2500); await p.keyboard.press("Enter").catch(()=>{}); await sleep(1200)
  await p.click("#enter-arena").catch(()=>{})
  await p.waitForFunction("window.gameClient?.simulator?.myRawEntity", { timeout:30000 })
  await sleep(2000)
  await p.evaluate(() => ["entry-overlay","splash","menu","main-menu"].forEach(id=>{const el=document.getElementById(id); if(el) el.style.display="none"}))
  // crest bbox centers (world): red west tower, blue east base
  const shots = [
    { name:"red2",  cam:[-64,-16,-2],  tgt:[-71.6,-16,-2] },
    { name:"blue2", cam:[11,-22.5,0],  tgt:[4.5,-24,0] },
  ]
  for (const v of shots) {
    await p.evaluate((v)=>{ const s=window.gameClient.simulator, e=s.myRawEntity
      e.x=v.cam[0]; e.y=v.cam[1]; e.z=v.cam[2]; e.velX=e.velY=e.velZ=0; if(e.mesh) e.mesh.position.set(...v.cam)
      const cam=s.camera||s.renderer?.camera||s.renderer?.scene?.activeCamera
      cam.position.set(v.cam[0], v.cam[1]+1.2, v.cam[2])
      cam.setTarget(new cam.position.constructor(...v.tgt)) }, v)
    for(let i=0;i<24;i++){ await p.evaluate(()=>{try{window.gameClient.simulator.renderer.scene.render()}catch(e){}}); await sleep(16) }
    await p.screenshot({ path:`${OUT}/${v.name}.png` }); console.log("shot", v.name)
  }
} finally { await b.close() }
