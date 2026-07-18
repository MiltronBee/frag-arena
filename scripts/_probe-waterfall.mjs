import puppeteer from 'puppeteer-core'
const URL = 'https://sol-pkmn.fun/'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--ignore-gpu-blocklist',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
})
async function visit(label) {
  const page = await browser.newPage()
  const t0 = Date.now()
  let net = 0, cached = 0, netReqs = 0, cacheReqs = 0
  const netRows = []
  page.on('response', r => {
    try {
      if (r.url().startsWith('blob:')) return
      const kb = Math.round(parseInt(r.headers()['content-length'] || '0', 10) / 1024)
      if (r.fromCache()) { cached += kb; cacheReqs++ }
      else { net += kb; netReqs++; netRows.push({ kb, url: r.url().replace(/https:\/\/sol-pkmn\.fun/,'').split('?')[0] }) }
    } catch (e) {}
  })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  let playAt = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const btn = await page.evaluate(() => document.getElementById('enter-arena')?.textContent?.trim())
    if (btn && btn.startsWith('PLAY')) { playAt = (Date.now()-t0)/1000; break }
  }
  console.log(`${label}: PLAY at ${playAt}s | network ${Math.round(net/1024)}MB in ${netReqs} reqs | from-cache ${Math.round(cached/1024)}MB in ${cacheReqs} reqs`)
  netRows.sort((a,b) => b.kb - a.kb)
  console.log('  top network fetches:', netRows.slice(0,6).map(r => `${r.url}(${Math.round(r.kb/1024)}MB)`).join(' '))
  await page.close()
}
await visit('FIRST VISIT ')
await visit('REPEAT VISIT')
await browser.close()
