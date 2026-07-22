// One-shot: join and report the first-spawn loadout (fix: must be pistol WITH ammo).
import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})
try {
  const page = await browser.newPage()
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    'window.gameClient && window.gameClient.simulator && window.gameClient.simulator.myRawEntity && ' +
    'window.gameClient.simulator.viewmodel && window.gameClient.simulator.viewmodel.ready',
    { timeout: 45000 })
  await new Promise((r) => setTimeout(r, 1500)) // let first snapshots settle
  const s = await page.evaluate(() => {
    const sim = window.gameClient.simulator
    const raw = sim.myRawEntity
    const st = raw.weaponsState[sim.weaponIndex]
    const nameEl = document.getElementById('weapon-name')
    return {
      clientWeaponIndex: sim.weaponIndex,
      entityWeaponIndex: raw.currentWeaponIndex,
      viewmodelIndex: sim.viewmodel.spec.index,
      viewmodelName: sim.viewmodel.spec.name,
      hudWeaponName: nameEl ? nameEl.textContent : null,
      ownedWeapons: raw.ownedWeapons,
      magazineAmmo: st.magazineAmmo,
      reserveAmmo: st.reserveAmmo,
    }
  })
  console.log(JSON.stringify(s, null, 2))
  const ok = s.clientWeaponIndex === 3 && s.entityWeaponIndex === 3 && s.viewmodelIndex === 3 &&
    s.ownedWeapons === (1 << 3) && s.magazineAmmo > 0 && s.reserveAmmo > 0
  console.log(ok ? 'PASS first spawn = owned pistol with ammo' : 'FAIL first-spawn loadout wrong')
  process.exitCode = ok ? 0 : 1
} finally {
  await browser.close()
}
