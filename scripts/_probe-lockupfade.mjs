import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 720 })
await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 2500))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const read = () => page.evaluate(() => getComputedStyle(document.querySelector('.lockup-rule')).opacity)
const before = await read()
await page.evaluate(() => document.getElementById('issuance-modal').classList.remove('info-closed'))
await sleep(400); const during = await read()
await page.evaluate(() => {
  document.getElementById('issuance-modal').classList.add('info-closed')
  document.getElementById('howto-modal').classList.remove('howto-closed')
})
await sleep(400); const howto = await read()
await page.evaluate(() => document.getElementById('howto-modal').classList.add('howto-closed'))
await sleep(400); const after = await read()
console.log(JSON.stringify({ before, during, howto, after }))
await browser.close()
