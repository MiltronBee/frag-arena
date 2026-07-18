import puppeteer from 'puppeteer-core'
const URL = process.env.FRAG_URL || 'https://sol-pkmn.fun/'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--ignore-gpu-blocklist',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
})
const page = await browser.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(`[${m.type()}] ${m.text().slice(0,300)}`) })
page.on('pageerror', e => errs.push('[pageerror] ' + String(e).slice(0,500)))
page.on('requestfailed', r => errs.push('[reqfail] ' + r.url().slice(0,200) + ' ' + (r.failure()?.errorText || '')))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const s = await page.evaluate(() => ({
    btn: document.getElementById('enter-arena')?.textContent?.trim()?.slice(0,60),
    prog: window.gameClient?.simulator?._assetProgress ?? window.gameClient?.simulator?.assetProgress,
  }))
  console.log(`t=${(i+1)*5}s btn="${s.btn}" prog=${s.prog}`)
  if (s.btn && s.btn.startsWith('PLAY')) break
}
await page.screenshot({ path: '_work/live-load-probe.png' })
console.log(errs.slice(0, 30).join('\n') || '(no console errors)')
await browser.close()
