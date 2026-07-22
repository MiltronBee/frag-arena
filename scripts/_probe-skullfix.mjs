import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 600 })
await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 2500))
await page.evaluate(() => {
  document.body.classList.add('arena-entered')
  const s = document.getElementById('splash'); if (s) s.style.display = 'none'
  const e = document.getElementById('entry-overlay'); if (e) e.style.display = 'none'
  const c = document.getElementById('combat-state')
  c.classList.remove('combat-state-hidden')
  c.style.visibility = 'visible'; c.style.opacity = '1'; c.style.display = ''
})
await new Promise(r => setTimeout(r, 800))
const el = await page.$('#combat-state')
await el.screenshot({ path: '_work/fx_youdied.png' })
await browser.close()
console.log('ok')
