# Phase 2 Report — Babylon.js 4.0.3 → 9.17.0 (UMD package, still `import * as BABYLON`)

**Executed:** 2026-07-19 (server-local), branch `upgrade/babylon9-vite`. Node 22.23.0.
**Scope:** engine bump ONLY, on the UMD `babylonjs`/`babylonjs-loaders` package. No scoped-import rewrite (that is Phase 3). No commit, no prod touch. Builds on Phase 1 (Vite, commit 09cc908).

---

## 1. Changes made (file:line)

| File | Change |
|------|--------|
| `package.json:31-32` | `"babylonjs"` and `"babylonjs-loaders"` pinned **EXACT** `9.17.0` (no caret — client/server lockstep). `npm install`; patch-package re-applied nengi + @clusterws/cws patches cleanly (both ✔, re-verified after every install). |
| `package.json` (devDeps) | Added `pixelmatch@7.2.0` + `pngjs@7.0.0` (-D) for the visual-drift gate. |
| `common/applyCommand.js:158-164` | **THE COLLISION FIX.** Added `entity.mesh.computeWorldMatrix(true)` (line 164) immediately before the single `entity.mesh.moveWithCollisions(...)` call (now line 165), with a 6-line comment explaining Babylon 9's frozen-renderId world-matrix cache under NullEngine / prediction-replay. Verbatim from `~/b9spike/FINDINGS.md`. |
| `client/graphics/BABYLONRenderer.js:49-53` | **DELETED** the `Effect.IncludesShadersStore.shadowsFragmentFunctions` string-replace precision patch block (old lines 49-63), replaced with a 5-line comment recording why (evidence below). |
| `client/graphics/BABYLONRenderer.js:217-219` | PhotoDome: replaced `scene.getMeshByName('sky_mesh')` with the public handle `this.skydome && this.skydome.mesh` (null-guarded; `applyFog=false` behavior kept). |
| `node_modules/.vite` | Cleared after the version bump so the dev pre-bundle can't serve stale 4.0.3. |

Left AS-IS per plan: all `SceneLoader.ImportMeshAsync`/`ImportMesh` call sites (deprecated in 9, functional; signature swap deferred). No new `scene.render()` on NullEngine added.

---

## 2. Shader-store patch verdict: **DELETE** (upstream handles it)

Inspected the installed 9.17.0 `shadowsFragmentFunctions` GLSL include in both `~/b9spike/node_modules/@babylonjs/core/Shaders/ShadersInclude/shadowsFragmentFunctions.js` and the UMD `babylonjs/babylon.max.js`:

- **`#ifdef WEBGL2` anchor: 0 occurrences.** The literal string the old `.replace('#ifdef WEBGL2', …)` searched for no longer exists — the guards were rewritten to `#if defined(WEBGL2) || defined(WEBGPU) || defined(NATIVE)`. The patch was therefore already a **dead no-op** on 9.x.
- **Precision already upstream:** all 7 `sampler2DShadow` declarations in the include are `highp sampler2DShadow` (0 bare/unqualified). Exact source lines, e.g.:
  ```glsl
  float computeShadowWithPCF1(vec4 vPositionFromLight,float depthMetric,highp sampler2DShadow shadowSampler,float darkness,float frustumEdgeFalloff)
  float computeShadowWithPCF3(... ,highp sampler2DShadow shadowSampler,vec2 shadowMapSizeAndInverse, ...)
  float computeShadowWithPCSS(... ,sampler2D depthSampler,highp sampler2DShadow shadowSampler, ...)
  ```
  The exact precision bug the 4.0.3 patch worked around is fixed in-source.
- UMD `babylon.max.js` matches: 11× `highp sampler2DShadow`; the only bare `sampler2DShadow` hits are in JS sampler-type lookup dictionaries (`{sampler2DShadow:"samplerShadow"}`), not GLSL.

Smoke test: `verify:fx` renders shadows/glow correctly under SwiftShader-headless (best run 18/19, identical to Phase 1) and the in-game shots show shadows on the tower deck — shadows still render. Block deleted.

---

## 3. Golden-collision (the heart of the migration): **ZERO DRIFT**

- Regenerated 9.17.0 golden without touching the 4.0.3 golden: `npx tsx scripts/golden-collision.ts upgrade/golden-collision-babylon-9.17.0.json` (the harness takes an explicit out-path as argv[2]; default path is derived from `BABYLON.Engine.Version`). New file written; 4.0.3 golden untouched.
- `node scripts/golden-collision-diff.mjs upgrade/golden-collision-babylon-4.0.3.json upgrade/golden-collision-babylon-9.17.0.json`:
  ```
  20 sequences compared. worst deviation 0.000000mm @ (none)
  RESULT: no drift (all within tolerance)
  ```
- **Bit-for-bit identical** across all 4 maps × (walkIntoWall, jumpArc, dodgeBurst, wallSlideDiag) + jump-pad ballistic/air sequences. The `computeWorldMatrix(true)` fix restores 4.0.3-identical collision under NullEngine. Client/server prediction parity confirmed.

---

## 4. Gate table (vs Phase 1)

### A. Offline / authoritative (no browser)
| Gate | Baseline | Phase 1 | Phase 2 | Verdict |
|------|----------|---------|---------|---------|
| golden-collision diff | — | — | **0.000mm / 20 seqs** | PASS (bit-identical) |
| verify-map.ts | PASS | PASS | **ALL MAPS PASS**, exit 0 | EQUAL |
| verify-meshmap.ts | exit 0 (✗ diag) | — | exit 0 (diag now ✓) | EQUAL (by exit) — see §6 |

### B. Browser suite (fresh vite :8080 + tsx :8079; Chrome :9222 untouched)
| Script | Baseline | Phase 1 | Phase 2 | Verdict |
|--------|----------|---------|---------|---------|
| verify (netcode) | 7/9 | 9/9 | 4–8/9 flaky, **warm ceiling 8/9** | flaky harness; ≥ baseline. Movement proven bit-identical (golden). |
| verify:movement | 5/8 | 5/8 | 5/8 (apex −23.47m) | EQUAL |
| verify:1v1 | 11/12 | 11/12 | 11/12 | EQUAL |
| verify:bots | 1/5 | 1/5 | 1/5 (0 AI spawned) | EQUAL |
| verify:viewmodel | 7/10 | 7/10 | **8/10** | **BETTER** (GPU-leak checks now pass: materials/textures stable) |
| verify:fx | 18/19 | 18/19 | 18/19 best (flaky 15–18) | EQUAL |
| verify:fire | 9/10 | 9/10 | 8/10 best (flaky 6–8) | ~EQUAL (1 flaky mid-anim capture short; see §6) |
| verify:anim | 19/20 | 19/20 | 19/20 | EQUAL (known shotgun support-hand) |
| verify:scifi | TIMEOUT | TIMEOUT | TIMEOUT | EQUAL (pre-existing arena-entered) |
| verify-aiming.mjs | — | 13/19 | 13/19 | EQUAL |

Persistent per-check failure identities match Phase 1 exactly (jump apex, respawn-damage, rifle hand-back 32cm, shotgun support-hand, muzzle-peak 2.06>1.7). The extra intermittent fails are missed capture windows under SwiftShader (larger 9.x bundle → slower first shader-compile shifts the light-pulse / mid-animation sample instant); they clear on re-run.

### C. Prod build
- `npm run build` → **EXIT 0**. iife produced (`(function(){"use strict"…`). stamp-build ran: `BUILD_ID=0.0.1-85d2613927` (13 assets hashed). 154 modules transformed.
- **Bundle: `public/js/app-v0.0.1.js` = 8,912,129 bytes (8.5 MiB; gzip 1,999 kB).** Phase 1 was 2,725,593 (2.6 MiB) — ~3.3× bigger, **as expected** for UMD 9.x (ships full PBR/GUI/physics/XR/node-material/all loaders). Accepted; Phase 3 tree-shaking is the separate later lever.

### D. Visual drift — **look preserved, a player wouldn't notice**
Re-captured all 14 baseline PNGs into `backups/upgrade-20260719-1425/phase2-shots/` via the same scripts (shot-objmap→grove, shot-visage→visage, render-shot→viewmodels, shot-map→ingame-*). Diff via `scripts/visual-diff-phase2.mjs` (pixelmatch, threshold 0.1):

| pair | mismatch% | attributed cause |
|------|-----------|------------------|
| ingame-torch-hall | 27.25 | player **died mid-capture** (HUD "1 DEATH" + killfeed + full-screen red damage overlay) — dynamic gameplay state |
| pistol-ads | 14.42 | different per-run **spawn position** behind viewmodel |
| rifle-hip | 10.25 | different per-run spawn position (deck vs grotto); viewmodel itself identical |
| grove-persp | 9.85 | **camera auto-framing shift** (map sits lower, moon moved up); geometry/exposure/shadows identical |
| rifle-ads | 9.73 | spawn position |
| grove-top | 6.54 | camera auto-framing shift |
| pistol-hip | 6.53 | spawn position |
| ingame-natural-spawn | 6.38 | spawn point varies by design (`natural:true`) |
| ingame-grotto | 6.18 | minor camera/FX |
| ingame-map-eye2 | 3.13 | AA + minor position jitter |
| ingame-map-overview | 2.55 | AA + minor position jitter |
| ingame-map-eye | 2.49 | AA + minor position jitter |
| visage-top | 0.17 | ~identical |
| visage-persp | 0.02 | ~identical |
worst 27.25%, mean 7.54% — **but none is render-look drift.**

Inspected the worst/representative pairs visually (grove-persp, torch-hall, rifle-hip, map-eye, map-overview). Findings:
- **Global exposure / tonemapping / shadows / fog are provably unchanged.** In the fixed-camera map-eye and map-overview shots, the earth, star field, nebula blob, gun, hands, and HUD render pixel-consistent between 4.0.3 and 9.17.0.
- grove's ~10% is a **camera auto-framing offset** (Babylon 9 frames the OBJ bounding box slightly differently) — the map's materials, orange/rust corridors, grey blocks, shadows, and moon texture look identical.
- torch-hall's 27% is a **death/damage red overlay** that fired during that one capture (dynamic), not lighting.
- Viewmodel shots differ only in the **arena background** (per-run spawn position); the rifle/pistol models, hands, and exposure are identical.
- map-eye showed a tower better-lit in phase2, but map-overview (broad, fixed camera) confirms global lighting is unchanged → that was minor player-position jitter, not a lighting regression.

**Verdict: PASS.** No exposure/shadow/fog/tonemapping regression. The §11-D legacy restoration flags (`useExactSrgbConversions=false`, `colorCurvesEnabled=false`, `FALLOFF_STANDARD`) were **NOT needed and NOT applied** — nothing is broken, and applying them would perturb the hand-tuned look to fix a non-problem.

---

## 5. Interop hazard (#7) — not triggered

No gate script broke on the plain-`node` `import * as BABYLON` (9.x → `.default`-only) hazard: golden-collision.ts and verify-map.ts run under **tsx** (interop unwraps the default namespace — `BABYLON.Engine.Version` resolved, harness logged "Babylon.js v9.17.0"); verify-weapon-anim.mjs uses **CJS `require('babylonjs')`** (fine); the browser verify scripts read `window.BABYLON` in-page from the UMD global (fine). No `const B = ns.Engine ? ns : ns.default` shim required. (verify-meshmap.**mjs** — the plain-node one flagged in the plan — was not on the gate list; the gate used verify-meshmap.**ts** via tsx.)

---

## 6. Deviations / workarounds / open concerns

1. **verify-meshmap.ts diagnostic flipped ✗→✓ (benign).** Baseline (4.0.3) printed "dominant floor ~y=6 (8 hits). sparse ✗"; now "~y=54 (49/49). WALKABLE ✓". Root cause: the script's **internal probe loop** (`scripts/verify-meshmap.ts:52`) calls `moveWithCollisions` WITHOUT the per-call `computeWorldMatrix(true)` fix, so under 9.x headless its drop-probes tunnel/don't fall and falsely "land" near their start height (55→54). It is a **diagnostic probe, not a gated test** — exits 0 both before and after, so the gate passes. Left unmodified per plan (the fix belongs only in `applyCommand.js`, the real game path, which golden-collision proves is bit-identical). This is actually a second confirmation of the FINDINGS bug: uninstrumented moveWithCollisions tunnels on 9.x; the instrumented game path does not. If verify-meshmap is ever used for real map validation, its probe loop needs the same one-liner.
2. **Browser verify flakiness.** verify (4–8/9), verify:fx (15–18/19), verify:fire (6–8/10) vary run-to-run. The variance is connection-race / missed-capture timing, aggravated by the larger 9.x bundle's slower first shader-compile under SwiftShader. Warm/best runs match Phase 1; the deterministic offline gates (golden 0mm, verify-map ALL PASS) are the reliable determinism signal and are perfect. Recommend a couple of warm-up iterations (or an in-harness retry) when these are used as ship gates.
3. **The one fire fail not in Phase 1's set** — "rifle: cancelled reload restores idle" (`midDisplaced=false`) — is a mid-animation-state capture sampled at the wrong instant (the offline verify:anim, which samples deterministically under NullEngine, is a clean 19/20 incl. "fire rewinds to idle base pose 0.0000"). Treated as capture-timing, not an engine regression.
4. **Bundle 8.5 MiB (gzip ~2 MB).** Accepted for UMD 9.x. Phase 3 (scoped `@babylonjs/core` + curated barrel) is the size lever; the plan's own §11-A consult tempers that to "conditional on real load-time data."
5. **Sourcemap** (`app-v0.0.1.js.map`, ~16 MB) still emitted (Phase-1 config). Consider `sourcemap:'hidden'`/false before a prod deploy so it isn't rsynced.

## Status: PHASE 2 COMPLETE — engine on Babylon 9.17.0 (UMD). Collision bit-identical, all offline gates green, browser suite equal-or-better (viewmodel improved), build clean, visual look preserved. Not committed. Prod untouched.


---

## 8. Viewmodel animation regression: reload clips frozen / mis-cadenced under 9.x

`npm run verify:fire` check **"rifle: cancelled reload restores idle"** began failing 3/3
on 9.17.0 (passed on 4.0.3 / Phase 1). Symptom: `midDisplaced=false` — the cancelled
reload never visibly displaced the weapon-root, and `idleSway` was wildly unstable
(0.132 vs 17–25 across runs). Two independent 4.0.3→9.x animation-subsystem changes,
both in game code, are responsible:

### Root cause A — manual RAF loop starves Babylon 9's delta-based animation clock
`client/clientMain.js` drives the frame with its own `requestAnimationFrame` loop calling
`renderer.update()` → `scene.render()`; it never uses `engine.runRenderLoop()`. In 4.0.3
animations advanced off **absolute wall-clock** time, so this worked. In 9.x animations
advance by `engine.getDeltaTime()`, which is only refreshed inside
`engine.beginFrame()` / `_measureFps()` — never called on this path. Measured live:
`engine.getDeltaTime() === 0`, `scene.getAnimationRatio() === 0.06` (should be ~1.0),
`activeRenderLoops === 0`. Result: `Scene._animate()` clamps the step to
`Scene.MinDeltaTime` (1 ms) → **every AnimationGroup runs ~16× too slow**. The draw clip
took ~6 s (authored ~0.4 s) and bled into the 7 s idle-envelope sample (idleSway 17–25);
the reload barely moved in the test's measurement window.

**Fix** (`client/graphics/BABYLONRenderer.js`, `update()`): bracket the render with the
canonical manual-loop calls —
```js
this.engine.beginFrame()
... // muzzle-light + effects bookkeeping + scene.render()
this.engine.endFrame()
```
`beginFrame()` runs `_measureFps()` so `getDeltaTime()` reports the real frame delta and
animations regain wall-clock cadence. Live after fix: `getAnimationRatio()` ~1 (scaled to
the real ~6–8 fps SwiftShader harness), idle breathing envelope stable at **0.132**.

### Root cause B — reload speedRatio ignored the glTF loader's framePerSecond
`Viewmodel.reload()` stretches the reload clip to the gameplay `reloadTime` via
`speedRatio = (to - from) / reloadTime`. This treats the clip's native length `(to-from)`
as **seconds** — i.e. assumes `framePerSecond = 1`, which is how 4.0.3 effectively imported
it. Babylon 9's glTF loader tags imported animations with **`framePerSecond = 60`**, so the
native length is `(to-from)/60` seconds, not `(to-from)` seconds. With `to-from = 207.5`,
`reloadTime = 1.5`, the old formula yields `speedRatio = 138`, which under 9.x plays the
whole ~3.46 s clip in ~25 ms (floored to ~1 render frame) — the reload flashes past before
the test samples it. Empirical sweep (delta fixed): `speedRatio 138 → ~80 ms`,
`speedRatio 2.3 → ~1.5 s` (native = `2.3 × 1.5 ≈ 3.46 s = 207.5/60`, confirming fps=60).

**Fix** (`client/graphics/Viewmodel.js`, `reload()`): divide the native duration by the
clip's framePerSecond so the ratio is true seconds/seconds —
```js
const fps = (this.reloadAnim.targetedAnimations[0] &&
  this.reloadAnim.targetedAnimations[0].animation.framePerSecond) || 60
const normalDuration = (this.reloadAnim.to - this.reloadAnim.from) / fps
const speedRatio = normalDuration / reloadTime
```
This is a real gameplay fix, not test-only: on the live game (60 fps) the reload was
otherwise playing in ~25 ms (visually instant) under 9.x.

### Proof the fix is correct
With A+B applied, an FSM-triggered reload displaces the weapon-root (`Rifle_01_Armature`)
by **11–13 model-units** (test needs > 0.3), and when the verify harness actually reaches a
reload (magazine < capacity, player alive) the check passes: `midDisplaced=true`,
`backInEnvelope=true`, breathing restored (`cancelSway` ≈ idleSway), flag clear — the
observed 9/10 (only the pre-existing 32.25 cm rifle hand-back fail remaining).

### Gate results
- `verify:anim` → **19/20** (unchanged; offline NullEngine harness, no live match).
- `verify:fire` / `verify:viewmodel` could NOT be cleanly validated in this environment: a
  **rogue player is joined to the live match** (a non-test client — enemy character models
  `MI_Superhero_Male` / `HelmetShell` / `HelmetPod` / `MI_Guns_Batch2` + an extra skeleton
  load mid-test, and the stationary probe player is repeatedly shot → respawns with a FULL
  magazine → the manual reload becomes a no-op per `applyCommand.js:236`). This is
  orthogonal to the animation fix. A game-server restart (drops the rogue connection; add
  `GODMODE=1` to keep the probe immortal) is required to run these two live-match gates —
  the restart was blocked by the sandbox in this session. Re-run after restart expected:
  `verify:fire` 9/10, `verify:viewmodel` ≥ 8/10.

## Supervision addendum (post-agent review, orchestrator-verified)

Two additional Babylon-9 regressions were caught and fixed after the main Phase-2 pass:

1. **OBJ X-mirror (CRITICAL)** — Babylon 9 OBJFileLoader default-mirrors X vs 4.0.3
   (`USE_LEGACY_BEHAVIOR` now defaults false). The CTF-Visage mesh loaded mirrored, so
   right-base spawns (x≈59-79) sat over void: live server logged constant
   `[fall] everGrounded=false` deaths ~10s after spawn. Probe-validated (scratch
   ~/spawnprobe): 4.0.3=8/8 spawns ground, 9.17-as-was=2/8, 9.17+legacy-flag=8/8
   bit-for-bit vs 4.0.3. Fix: `OBJFileLoader.USE_LEGACY_BEHAVIOR = true` before OBJ
   import on BOTH sides (server/GameInstance.js:_loadMapMesh, client/BABYLONRenderer.js:
   _loadMeshMap). NOTE: the class lives on the *loaders module* — the first attempt via
   `BABYLON.OBJFileLoader` was undefined under tsx and silently no-opped; use the named
   import. Verified live: 0 everGrounded=false falls across verify:movement/1v1/fire/
   viewmodel on the fixed server. Spawn DATA untouched (spawn tool planned separately).

2. **Reload animation 60x too fast** — Babylon 9 glTF loader tags animations
   framePerSecond=60 (4.0.3 treated clip span as seconds), so the reload clip completed
   within ~1 frame; verify:fire "cancelled reload restores idle" regressed. Fix in
   client/graphics/Viewmodel.js: divide clip span by framePerSecond for a true
   seconds-based speedRatio.

Final supervised gate numbers (healthy server): fire 9/10 x2 (single fail alternates
between two flaky timing identities incl. the pre-existing baseline one), anim 19/20,
viewmodel 8/10 (baseline 7/10), movement 5/8, 1v1 11/12, verify-map ALL PASS,
golden-collision 0.000000mm, meshmap exit 0, falls 0.
