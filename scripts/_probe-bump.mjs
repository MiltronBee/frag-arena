import puppeteer from "puppeteer-core"
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await puppeteer.launch({ executablePath:"/usr/bin/google-chrome", headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--mute-audio"] })
try {
  const p = await b.newPage()
  await p.goto("https://sol-pkmn.fun/", { waitUntil:"domcontentloaded" })
  await sleep(2500); await p.keyboard.press("Enter").catch(()=>{}); await sleep(1200)
  await p.click("#enter-arena").catch(()=>{})
  await p.waitForFunction("window.gameClient?.simulator?.myRawEntity", { timeout:30000 })
  await sleep(2500)
  const r = await p.evaluate(() => {
    const s = window.gameClient.simulator, scene = s.renderer?.scene || s.scene
    const mats = scene.materials.filter(m => m.diffuseTexture && (m.diffuseTexture.url||"").includes("CTF-Visage"))
    const withBump = mats.filter(m => m.bumpTexture)
    return { totalMapMats: mats.length, withBump: withBump.length,
      sample: withBump.slice(0,4).map(m => ({ n:m.name.split("/").pop(), lvl:m.bumpTexture.level, bumpLoaded:m.bumpTexture.isReady?.() })) }
  })
  console.log(JSON.stringify(r,null,2))
} finally { await b.close() }
