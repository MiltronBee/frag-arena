import puppeteer from "puppeteer-core"
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await puppeteer.launch({ executablePath:"/usr/bin/google-chrome", headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--mute-audio"] })
try {
  const p = await b.newPage()
  await p.goto("https://sol-pkmn.fun/", { waitUntil:"domcontentloaded" })
  await sleep(2500); await p.keyboard.press("Enter").catch(()=>{}); await sleep(1200)
  await p.click("#enter-arena").catch(()=>{})
  await p.waitForFunction("window.gameClient?.simulator?.myRawEntity", { timeout:30000 })
  await sleep(1500)
  const r = await p.evaluate(() => {
    const s = window.gameClient.simulator
    const keys = Object.keys(s).filter(k => /yaw|pitch|look|rot|cam|angle|view/i.test(k))
    const cam = s.camera||s.renderer?.camera||s.renderer?.scene?.activeCamera
    return { simLookKeys: keys.map(k=>({k, v: typeof s[k]==="object"?"[obj]":s[k]})),
      camClass: cam?.getClassName?.(), camParent: cam?.parent?.getClassName?.(),
      camRot: cam?.rotation, camKeys: cam? Object.keys(cam).filter(k=>/yaw|pitch|rot|target|alpha|beta/i.test(k)):[] }
  })
  console.log(JSON.stringify(r,null,2))
} finally { await b.close() }
