import puppeteer from "puppeteer-core"
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await puppeteer.launch({ executablePath:"/usr/bin/google-chrome", headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--mute-audio"] })
try {
  const p = await b.newPage()
  await p.goto("https://sol-pkmn.fun/", { waitUntil:"domcontentloaded" })
  await sleep(2500); await p.keyboard.press("Enter").catch(()=>{}); await sleep(1200)
  await p.click("#enter-arena").catch(()=>{})
  await p.waitForFunction("window.gameClient?.simulator?.myRawEntity", { timeout:30000 })
  await sleep(2500)
  const r = await p.evaluate(async () => {
    const s = window.gameClient.simulator, scene = s.renderer?.scene || s.scene
    const find = frag => scene.materials.find(m => (m.diffuseTexture?.url||"").includes(frag))
    const out = {}
    for (const frag of ["CTF_Crypt_C-st-128-R","CTF_Crypt_C-rst-128-B","SkyCity_Deco_sKantis2","SkyCity_Deco_runeSgn2"]) {
      const m = find(frag)
      if (!m) { out[frag] = "material not found"; continue }
      const url = m.diffuseTexture.url
      let size = "?"
      try { const resp = await fetch(url, {cache:"no-store"}); size = (await resp.blob()).size } catch(e) { size = "fetch-err "+e.message }
      out[frag] = { url, liveFetchedBytes: size, texW: m.diffuseTexture.getSize?.().width }
    }
    return out
  })
  console.log(JSON.stringify(r,null,2))
} finally { await b.close() }
