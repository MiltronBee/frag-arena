// Against LIVE: (1) menu track starts on a click; (2) after crossfading to 'match',
// further clicks/taps do NOT restart the menu track (the in-game loop bug).
import puppeteer from 'puppeteer-core'
const CHROME=process.env.CHROME_BIN||'/usr/bin/google-chrome'; const URL='https://sol-pkmn.fun/'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio','--use-gl=angle','--use-angle=swiftshader']})
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'FAIL')+'  '+n);c?pass++:fail++}
try{
  const page=await b.newPage()
  await page.emulate({viewport:{width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:3},userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'})
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:30000})
  await page.waitForFunction('window.gameClient && window.gameClient.simulator && window.gameClient.simulator.music',{timeout:20000})
  await page.evaluate(()=>{const s=document.getElementById('splash'); if(s&&s.parentNode) s.parentNode.removeChild(s)})
  // simulate the menu: unlock + play menu
  await page.evaluate(()=>{const m=window.gameClient.simulator.music; m.unlock(); m.play('menu')})
  await sleep(600)
  const menu=await page.evaluate(()=>{const bg=document.getElementById('bg-menu');return{paused:bg.paused,t:+bg.currentTime.toFixed(2),cur:window.gameClient.simulator.music.current}})
  ok('menu track plays on menu ('+JSON.stringify(menu)+')', !menu.paused && menu.t>0.1 && menu.cur==='menu')
  // crossfade to match, let menu fade->pause
  await page.evaluate(()=>window.gameClient.simulator.music.play('match'))
  await sleep(1400)
  const mid=await page.evaluate(()=>{const bg=document.getElementById('bg-menu');return{paused:bg.paused,cur:window.gameClient.simulator.music.current,matchPaused:window.gameClient.simulator.music.tracks.match.paused}})
  ok('after crossfade: menu paused, match playing ('+JSON.stringify(mid)+')', mid.paused===true && mid.cur==='match' && mid.matchPaused===false)
  // now simulate in-game taps: real taps + synthetic clicks
  for(let i=0;i<5;i++){ await page.touchscreen.tap(180+i*5,400); await page.evaluate(()=>window.dispatchEvent(new Event('click'))); await sleep(120) }
  await sleep(500)
  const after=await page.evaluate(()=>{const bg=document.getElementById('bg-menu');return{menuPaused:bg.paused,menuVol:+bg.volume.toFixed(3),cur:window.gameClient.simulator.music.current,matchPaused:window.gameClient.simulator.music.tracks.match.paused}})
  ok('menu track STAYS paused after in-game taps ('+JSON.stringify(after)+')', after.menuPaused===true && after.cur==='match' && after.matchPaused===false)
}finally{await b.close()}
console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
