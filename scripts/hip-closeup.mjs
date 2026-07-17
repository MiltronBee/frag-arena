import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await browser.newPage();
await p.setViewport({ width: 900, height: 900 });
await p.goto("http://localhost:8180/?playground", { waitUntil: "domcontentloaded" });
await p.waitForFunction("window.playground && window.playground.groups && window.playground.groups.length>0", { timeout: 45000 });
await p.evaluate(() => { for (const s of ["#pg-panel", "#pg-clips", "#pg-roles", "aside"]) { const el = document.querySelector(s); if (el) el.style.display = "none"; } });
await p.evaluate(() => { window.playground.play("Idle_Loop"); });
await new Promise(r => setTimeout(r, 500));
await p.evaluate(() => {
  const cam = window.playground.scene.activeCamera;
  cam.setTarget(new BABYLON.Vector3(0, 0.55, 0));
  cam.alpha = Math.PI * 1.5; cam.beta = Math.PI / 2; cam.radius = 0.9;
});
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: "_work/hero_paint/preview/male_hip_front.png" });
await p.evaluate(() => {
  const cam = window.playground.scene.activeCamera;
  cam.alpha = Math.PI * 2; cam.beta = Math.PI / 2; cam.radius = 0.9;
});
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: "_work/hero_paint/preview/male_hip_side.png" });
await browser.close();
console.log("done");
