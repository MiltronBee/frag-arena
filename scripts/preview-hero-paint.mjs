// Screenshot the repainted hero body from front/back/side in the playground.
//   node scripts/preview-hero-paint.mjs
// Requires: dev server or serve-public.mjs already running on :8180.
// Writes: _work/hero_paint/preview/{male,female}_{front,back,side,run,death}.png
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.URL || "http://localhost:8180/?playground";
const OUT = "_work/hero_paint/preview";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"],
});
const p = await browser.newPage();
await p.setViewport({ width: 700, height: 900 });
const errors = [];
const logs = [];
p.on("pageerror", (e) => errors.push("PAGEERR " + e.message.slice(0, 240)));
p.on("console", (m) => logs.push(m.text()));

await p.goto(BASE, { waitUntil: "domcontentloaded" });
await p.waitForFunction("window.playground && window.playground.groups && window.playground.groups.length>0", { timeout: 45000 }).catch(() => {});

async function frame(alpha, beta, radius, target) {
  await p.evaluate((a, b, r, t) => {
    const cam = window.playground.scene.activeCamera;
    if (cam.setTarget) cam.setTarget(new BABYLON.Vector3(t[0], t[1], t[2]));
    cam.alpha = a; cam.beta = b; cam.radius = r;
  }, alpha, beta, radius, target);
}
async function setGender(g) {
  const changed = await p.evaluate((g) => {
    if (!window.playground) return false;
    if (window.playground.gender !== g) { window.playground.gender = g; window.playground._loadModel(); return true; }
    return false;
  }, g);
  if (changed) {
    // wait for reload
    await new Promise((r) => setTimeout(r, 3000));
  }
}
async function play(clip) {
  await p.evaluate((c) => {
    const pg = window.playground;
    if (pg.byName.has(c)) pg.play(c);
  }, clip);
  await new Promise((r) => setTimeout(r, 900));
}
async function hidePanel() {
  await p.evaluate(() => {
    for (const sel of ["#pg-panel", ".pg-panel", "aside", ".panel", "#pg-clips", "#pg-roles"]) {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    }
  });
}

async function shootHero(gender) {
  await setGender(gender);
  await hidePanel();
  // idle first: fresh pose
  await play("Idle_Loop");
  // frame full body from front
  await frame(Math.PI * 1.5, Math.PI / 2.15, 2.6, [0, 1.0, 0]);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: OUT + "/" + gender + "_front_idle.png" });
  // side
  await frame(Math.PI * 2.0, Math.PI / 2.15, 2.6, [0, 1.0, 0]);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: OUT + "/" + gender + "_side_idle.png" });
  // back
  await frame(Math.PI * 0.5, Math.PI / 2.15, 2.6, [0, 1.0, 0]);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: OUT + "/" + gender + "_back_idle.png" });
  // close on face (helmet cap + skin)
  await frame(Math.PI * 1.5, Math.PI / 2.5, 1.2, [0, 1.35, 0]);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: OUT + "/" + gender + "_face_closeup.png" });
  // close on hands (skin preserved test)
  await frame(Math.PI * 1.5, Math.PI / 2.05, 1.5, [0, 0.85, 0]);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: OUT + "/" + gender + "_hands_closeup.png" });
  // run
  await play("Jog_Fwd_Loop");
  await frame(Math.PI * 1.5, Math.PI / 2.15, 2.6, [0, 1.0, 0]);
  await new Promise((r) => setTimeout(r, 600));
  await p.screenshot({ path: OUT + "/" + gender + "_run.png" });
  // death
  await play("Death01");
  await new Promise((r) => setTimeout(r, 1000));
  await p.screenshot({ path: OUT + "/" + gender + "_death.png" });
}

await shootHero("male");
await shootHero("female");

console.log("errors:", errors.length);
errors.forEach((e) => console.log("  " + e));
console.log("logs (last 5):");
logs.slice(-5).forEach((l) => console.log("  " + l.slice(0, 200)));

await browser.close();
process.exit(errors.length ? 1 : 0);
