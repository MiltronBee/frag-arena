# Upgrade Plan: Babylon.js 4.0.3 → 9.x + webpack 4 → Vite

> **TARGET LOCKED (user decision, 2026-07-19): Babylon.js 9.x** — the March-2026 major (`@babylonjs/core@^9`, currently 9.17.0), migrated in ONE hop from 4.0.3. Everywhere this doc says "8.x", read **9.x**; 8-specific notes are retained only because most 4→8 breaking changes are also 4→9 breaking changes (the surfaces are cumulative).
>
> **Status:** RESEARCH / PLAN — nothing executed yet.
> **Produced:** 2026-07-19, from 7 parallel deep-dive audits (6 codebase + 1 live-web cross-check), synthesized.
> **Audience:** the engineer or next Claude instance who executes this. Assumes repo-layout familiarity, not migration specifics.
> **How to use:** read §0 (decisions) → §9 (risk register) → §10 (execution order) first. §§2–8 are the detailed evidence, each cite-able to `path:line`.

---

## 0. TL;DR, and the decisions to make first

The client renders on **Babylon.js 4.0.3 (2019)** and builds with **webpack 4.41 (2019)** — five engine majors behind, a monolithic **2.62 MiB** bundle, and it needs the `--openssl-legacy-provider` Node hack just to build. This is the complete plan to modernize.

**This is NOT the perf work.** The lag/freeze fixes (shadow-map freeze, resolution cap, allocation pooling) already shipped 2026-07-19 in `BABYLONRenderer.js` + `Simulator.js` and are independent — the migration must **preserve** them (each is engine-agnostic and carries over; §7 confirms).

### ✅ Decision 1 — target version: **9.x, DECIDED.**
The live-web check (§8) found the original "8.x" target already superseded: Babylon **9.0 shipped 2026-03-26; npm `latest` is 9.17.0** (both `@babylonjs/core` and UMD `babylonjs`, lockstep). The team chose to go straight to the March release — **4.0.3 → 9.x in one hop.** Rationale: one major/year each March, and the 4→8 and 8→9 breaking surfaces are cumulative, so stopping at 8 buys nothing. **Pin one exact 9.x version (e.g. `9.17.0`) and use the identical version for client AND server** (§5 desync risk — a client/server version skew corrupts prediction). Re-check `npm view @babylonjs/core version` at execution time and pin whatever `latest` is then.

### ⚠️ Decision 2 — how far to push the import rewrite? (Recommend **full scoped rewrite**, but stage it.)
Two independent moves are bundled under "the upgrade": the **engine bump** (mostly mechanical API fixes, §2) and the **`babylonjs` UMD → `@babylonjs/core` scoped-import rewrite** (§3) — the latter is the *only* thing that shrinks the bundle, and it touches ~23 files. They can ship in separate phases.

### Recommended sequencing (de-risked; each phase independently shippable + passes the §6 checklist)
- **Phase 1 — Vite, same Babylon 4.0.3.** Swap only the bundler; keep `import * as BABYLON from 'babylonjs'`. Proves build/dev/deploy before touching the engine. *(If Babylon 4.0.3's UMD fights Rollup/esbuild, fold into Phase 2.)*
- **Phase 2 — Babylon 9.x on the UMD package.** Bump `babylonjs`→^9, fix the API breaks (§2), still `import * as BABYLON`. Now on the modern engine with minimal import churn. **Do the visual-QA re-tune here** (§8 drift risk).
- **Phase 3 — scoped `@babylonjs/core` imports + tree-shaking.** The bundle-size win (§3). Highest churn; do it once the engine is proven stable. This is where runtime-silent breakage lives (§3/§5 side-effect imports).
- **Phase 4 (optional) — WebGPU opt-in.** Runtime-detected, WebGL2 default/fallback (§7).

### The headline numbers
- Bundle: **2.62 MiB today** → ~4–5 MiB if you stay on UMD 9.x (worse!) → **~1.4–1.8 MiB** with the scoped rewrite (Babylon's own ES6 example claims 700 KB vs 2.3 MB for a lean feature set; validate with `rollup-plugin-visualizer`, don't assume).
- ~90% of the `BABYLON.*` API surface is stable 4→8/9. Risk concentrates in **three coupled spots**: the stale shader-store patch, the deprecated `ImportMeshAsync`, and **loader/side-effect registration** under scoped imports.

---

## 1. Current-state facts (measured)

- Babylon `4.0.3` + `babylonjs-loaders@4.0.3`, `import * as BABYLON from 'babylonjs'` in **23 files** (global-namespace style); loaders via side-effect `import 'babylonjs-loaders'`.
- Build: webpack 4.41.1 + webpack-dev-server 3.8.2 + terser, run with `cross-env NODE_OPTIONS=--openssl-legacy-provider`.
- Output: single fixed-name `public/js/app-v0.0.1.js` ≈ **2.62 MiB**. `public/index.html` hand-authored & served directly; `scripts/stamp-build.mjs` rewrites `?v=<BUILD_ID>` cache-busters + injects `window.__BUILD_ID__` (which versions runtime GLB/audio fetches).
- Dev: `npm start` = webpack-dev-server (client :8080) ∥ `tsx watch server/serverMain.js` (game server :8079). Client dials `ws://host:8079` in dev, `wss://host/ws` (nginx) in prod.
- Netcode: `nengi@1.18` + `ws@8` + two `patch-package` patches (one — the nengi ESM patch — is a **Vite prerequisite**). Server + `common/` run under `tsx` (Node 22) and **share Babylon collision math with the client** → client/server must stay bit-identical (§5).
- ~30 `verify:*`/probe scripts drive headless Chrome (puppeteer-core + swiftshader) against `localhost:8080`, reading `window.gameClient` / `window.BABYLON`.
- **Audit corrections to note:** `firingFx.js` has no direct `BABYLON.*` calls; `mapLights.js` does not exist (baking is `BABYLONRenderer._bakeMapLights`); there are **no** custom `ShaderMaterial`/`NodeMaterial` and **no** webpack asset-loaders (all assets are runtime URL fetches).


---

## 2. Babylon 4→8 API changes

> **Corrections to the brief from this audit:** `client/graphics/firingFx.js` contains **no direct `BABYLON.*` calls** (comments only), and `mapLights.js` **does not exist** — map-light baking lives in `BABYLONRenderer._bakeMapLights`.

**Scope read:** `BABYLONRenderer.js`, `CharacterModel.js`, `Viewmodel.js`, `arenaDressing.js`, `Simulator.js`, `AnimPlayground.js`, `common/entity/*`, and every `BABYLON.*` call site in `client/` + `common/`.

### Risk-ranked table

| API / call site (path:line) | 4.0.3 usage | 8.x status | Action needed | Risk |
|---|---|---|---|---|
| `Effect.IncludesShadersStore.shadowsFragmentFunctions` string-patch (`BABYLONRenderer.js:55-64`) | Mutates the `shadowsFragmentFunctions` GLSL include, replacing `#ifdef WEBGL2` to inject `precision highp sampler2DShadow;` | **moved-namespace + behavior-changed.** Canonical store is now `BABYLON.ShaderStore` (GLSL/WGSL split); `Effect.IncludesShadersStore` survives as a deprecated GLSL alias. WebGL1 dropped in 8 → shaders rewritten, the literal `#ifdef WEBGL2` guard the patch searches for very likely no longer exists → `.replace()` matches nothing → **dead no-op** | Confirm the include content in installed 8.x. The original precision bug is almost certainly fixed upstream in the WebGL2-only shaders → block can likely be **deleted**. If kept, don't assume `#ifdef WEBGL2` is present | **High** |
| `new Engine(canvas, true)` (`BABYLONRenderer.js:68`, `AnimPlayground.js:28`) | Engine with possible WebGL1 fallback | **behavior-changed.** Babylon 8 is **WebGL2/WebGPU only** — WebGL1 removed. Never falls back to WebGL1; the `#ifdef WEBGL2` branch is always taken | Constructor still runs; audit anything gated on WebGL1; drop the WEBGL2 shader workaround. Target browsers all have WebGL2 in 2026 | **High** |
| `SceneLoader.ImportMeshAsync(names, rootUrl, file, scene)` — 9 sites: `CharacterModel.js:46,98,152`; `Viewmodel.js:74,168`; `arenaDressing.js:72`; `BABYLONRenderer.js:466`; `AnimPlayground.js:129,255,298` | Static promise loader; consumes `result.{meshes,animationGroups,skeletons,transformNodes,particleSystems}` | **deprecated, removed-with-replacement.** `SceneLoader.*` deprecated in 7/8 for module functions `ImportMeshAsync(source, scene, options?)`, `LoadAssetContainerAsync`, `AppendSceneAsync`. New `ImportMeshAsync` has a **different signature** (single source + options object). Old static still exists, same return shape, **keeps working with deprecation warnings** | Short term: no change. Medium term: migrate to new signature. **Return fields used here are unchanged** | **High** |
| Loader registration `import 'babylonjs-loaders'` (`Viewmodel.js:2`, `CharacterModel.js:2`, `arenaDressing.js:2`, `AnimPlayground.js:2`) | Auto-registers glTF/OBJ SceneLoader plugins | **behavior-changed** (registration refactored in 8). If plugins don't register, **every `ImportMeshAsync` rejects at runtime** | Verify glTF+OBJ plugins register under new package layout — single point of failure for all mesh loading | **High** |
| `PhotoDome` + `scene.getMeshByName('sky_mesh')` (`BABYLONRenderer.js:226-229`) | Reads dome's internal child mesh by name `<domeName>_mesh` | **behavior-risk (unverified).** Ctor/options unchanged, but relying on internal `sky_mesh` name is fragile across the `TextureDome` refactor | Use public handle `this.skydome.mesh.applyFog = false` instead of `getMeshByName('sky_mesh')` | **Med** |
| `imageProcessingConfiguration` block (`BABYLONRenderer.js:102-112`) | Material-level tonemap+vignette | **unchanged (best knowledge).** Props + `VIGNETTEMODE_MULTIPLY` persist. Default `toneMappingType` stays `TONEMAPPING_STANDARD` — **not** aware of a default→ACES change. Curve may not be byte-identical across 5 majors | Visual QA of exposure/contrast once | **Med/Low** |
| `ShadowGenerator` (`BABYLONRenderer.js:155-170`): blur ESM, `blurKernel`, `getShadowMap().refreshRate = REFRESHRATE_RENDER_ONCE` | Frozen static map (the perf work) | **unchanged.** Ctor, both props, `getShadowMap()`, `REFRESHRATE_RENDER_ONCE`, `resetRefreshCounter` all persist | Verify RENDER_ONCE still bakes after async geometry — the perf design hinges on it | **Low** |
| Cameras: `TargetCamera`/`ArcRotateCamera`/`FreeCamera`, `.layerMask`, `scene.activeCameras=[...]`, `scene.cameraToUseForPointers` | Dual-camera world+viewmodel via layerMask | **unchanged.** Multi-cam via `activeCameras` array is still supported and **not deprecated** (only singular `activeCamera` is the "default cam"). The brief's "activeCameras deprecation" concern does **not** apply | None | **Low** |
| Lights + `includedOnlyMeshes` (empty=all) + `Light.FALLOFF_GLTF` | Whitelisted vm light, GLTF falloff | **unchanged.** Empty-list-means-all semantics (the anchor hack at `:191-195` depends on it), `FALLOFF_GLTF=2`, default `maxSimultaneousLights=4` recompile behavior all persist | None | **Low** |
| `MeshBuilder.Create{Box,Sphere,Cylinder,Ground,Plane}`, `createInstance`, `VertexBuffer.*Kind`, `TransformNode`, `DynamicTexture`, `GlowLayer`, `AnimationGroup` | Standard mesh/material/instance/anim | **unchanged.** No option renames on builders used here | None | **Low** |
| `StandardMaterial`, `Texture`, `Engine.ALPHA_*`, `Mesh.BILLBOARDMODE_*`, `Scene.FOGMODE_EXP2`, `Engine.LastCreatedScene` | Materials, blends, billboards, fog | **unchanged** | None | **Low** |
| Math: `Vector3`, `Color3/4`, `Quaternion`, `Matrix` + statics (`Transform*`, `CrossToRef`, `Project`, `Distance`, `FromEulerAngles`, `Compose`…) | Core math everywhere | **unchanged** — most stable surface | None | **Low** |
| `NullEngine` + `getEngine().name === 'NullEngine'` guard | Headless server/verify branch | **unchanged.** Name still `'NullEngine'` | None | **Low** |
| `Ray` + picking, `moveWithCollisions`, `checkCollisions`, `collisionsEnabled`, `mesh.ellipsoid` | Client collision movement | **unchanged.** Built-in collision API stable | None | **Low** |

### HIGH-risk detail

**2a. Stale WebGL2 shader-store injection (`BABYLONRenderer.js:55-64`).** Patches a private GLSL include to fix a 4.x WebGL2 `sampler2DShadow` precision bug. In 8: store moved to `BABYLON.ShaderStore` (Effect alias deprecated) AND WebGL1-drop rewrote the include so the `#ifdef WEBGL2` search text likely no longer exists → `String.replace` silently no-ops. **Recommended: delete the block** (upstream WebGL2-only shaders already handle precision). If kept, target `ShaderStore.GetIncludesShadersStore()` and don't assume the guard text. *Confirm include content against installed 8.x before deciding.*

**2b. `SceneLoader.ImportMeshAsync` deprecated (9 sites).** Old static still works in 8 (deprecation warnings), identical `ISceneLoaderAsyncResult`. Forward path is module `ImportMeshAsync(fullUrl, scene, options?)` with collapsed signature. **All consumed return fields (`meshes`, `animationGroups`, `skeletons`, `transformNodes`, `particleSystems`) are stable** → mechanical signature swap, not a data rewrite.

**2c. Loader registration is the load-bearing dependency.** All of 2b depends on the loaders package registering glTF/GLB + OBJ. If registration silently fails under the new layout, every mesh load rejects ("no plugin for .glb/.gltf") while math paths keep working — looks like a content bug, is actually a loader bug. **Add a post-migration smoke check that one `.glb` and the map `.obj` both load.**

### Confirmed safe / no change (don't re-check)
Core math (Vector3/Color3/4/Quaternion/Matrix + all statics used); cameras (Target/ArcRotate/Free, layerMask, activeCameras array, cameraToUseForPointers); lights (Hemi/Dir/Point, includedOnlyMeshes incl. empty=all, FALLOFF_GLTF, maxSimultaneousLights=4); shadows (ShadowGenerator, blur ESM, REFRESHRATE_RENDER_ONCE, shadowOrthoScale); imageProcessing (tonemap/contrast/exposure/vignette + VIGNETTEMODE_MULTIPLY, default STANDARD); meshes/materials (MeshBuilder shapes incl. faceColors, StandardMaterial, Texture, DynamicTexture, createInstance, VertexBuffer kinds, TransformNode, GlowLayer, AnimationGroup); constants (ALPHA_*, LastCreatedScene, setHardwareScalingLevel, BILLBOARDMODE_*, FOGMODE_EXP2); collisions/picking (collisionsEnabled, checkCollisions, ellipsoid, moveWithCollisions, Ray); NullEngine + name guard.

**Bottom line:** ~90% of the `BABYLON.*` surface is API-stable 4→8. Risk concentrates in three coupled spots: the **stale WebGL2 shader patch** (delete/rework), the **deprecated `ImportMeshAsync`** (works now; plan the swap; return shape safe), and **loader registration** under the new package layout.


---

## 3. Package & import restructuring (tree-shaking)

The single biggest lever on the 2.62 MiB bundle. Today every module pulls the **entire** Babylon library through the monolithic `babylonjs` UMD package + `BABYLON.*` global.

### Import inventory — 23 files (8 client, 7 common, 2 server, 6 scripts)

| File | Line | Current import |
|------|------|----------------|
| `client/playground/AnimPlayground.js` | 1,2 | `import * as BABYLON from 'babylonjs'` + `import 'babylonjs-loaders'` (glTF) |
| `client/graphics/FragLayer.js` | 1 | `import * as BABYLON from 'babylonjs'` |
| `client/graphics/Viewmodel.js` | 1,2 | namespace + loaders (glTF) |
| `client/graphics/BABYLONRenderer.js` | 1,3 | namespace + loaders (OBJ) |
| `client/graphics/CharacterModel.js` | 1,2 | namespace + loaders (glTF) |
| `client/graphics/arenaDressing.js` | 1,2 | namespace + loaders (glTF) |
| `client/factories/createObstacleFactory.js` | 1 | namespace |
| `client/factories/createFactories.js` | 1 | namespace |
| `common/weapon.js` | 3 | `import { Vector3, Ray } from 'babylonjs'` |
| `common/entity/Projectile.js` | 2 | namespace |
| `common/applyCommand.js` | 2 | `import { Vector3, Matrix, Axis } from 'babylonjs'` |
| `common/entity/MegaHealthPickup.js` | 2 | namespace |
| `common/entity/Obstacle.js` | 2 | namespace |
| `common/entity/Grenade.js` | 2 | namespace |
| `common/entity/PlayerCharacter.js` | 2 | namespace |
| `server/BotController.js` | 12 | namespace |
| `server/GameInstance.js` | 30,31 | namespace + loaders (OBJ) |
| `scripts/_sweep-pad.ts` | 4 | namespace |
| `scripts/verify-map.ts` | 13 | namespace |
| `scripts/verify-weapon-anim.mjs` | 21,22 | `const BABYLON = require('babylonjs')` + `require('babylonjs-loaders')` |
| `scripts/verify-meshmap.ts` | 7,8 | namespace + loaders |
| `scripts/verify-meshmap.mjs` | 5,6 | namespace + loaders |
| `scripts/probe-visage.ts` | 7,8 | namespace + loaders |

**Plus a runtime global dependency (not an import):** `scripts/probe-anim.mjs:97` runs `const BABYLON = window.BABYLON` **inside the browser page** (puppeteer `page.evaluate`), then `new BABYLON.Vector3(...)`. This is why the migration cannot simply drop the global — see the barrel pattern.

### Strategy: two paths

**Path A — UMD `babylonjs` 8.x (low effort, WRONG direction).** Bump `^4.0.3`→`^8`, keep every import verbatim, `window.BABYLON` self-attaches. Zero churn, all side-effects pre-registered. **But it makes the bundle BIGGER (~4–5 MiB):** `import * as BABYLON from 'babylonjs'` is an opaque UMD blob bundlers cannot tree-shake, and 8.x is a larger library — you ship PBR/GUI/physics/particles/audio/XR/node-material/every loader, none used. Acceptable only as a temporary "get it compiling on 8.x" checkpoint.

**Path B — scoped `@babylonjs/core` + `@babylonjs/loaders` with deep imports (RECOMMENDED).** The only path that shrinks the bundle (~1.4–1.8 MiB). Touches all 23 files; requires the exhaustive side-effect checklist below — **this is where migrations silently break at runtime**.

### The tree-shaking reality (critical, counter-intuitive)

- **`import * as BABYLON from '@babylonjs/core'` does NOT tree-shake.** The package root/barrel re-exports the entire library and marks many submodules as having side effects; a namespace import of the barrel forces the bundler to keep essentially all of it — UMD-sized output through an ESM specifier. **Switching to `@babylonjs/core` while importing from the package root buys nothing.** Tree-shaking only happens with **deep submodule paths** (`@babylonjs/core/Maths/math.vector`, …), which the barrel defeats.
- **Deep named imports per file** tree-shake but force rewriting every `BABYLON.Foo`→`Foo` across 23 files (127 `Vector3` sites alone).

**RECOMMENDED: a curated local barrel.** One project-owned module does the deep imports + side-effects once, re-exports the used classes, and is imported as a namespace everywhere. Each of the 23 files changes only the specifier string (`from 'babylonjs'` → `from '<rel>/babylon'`); bodies untouched. Real tree-shaking + near-zero call-site churn + one place to keep `window.BABYLON` alive.

### Exhaustive side-effect-import checklist (for THIS codebase)

Scoped Babylon requires **explicit** registration of anything driven by a scene component/plugin/prototype augmentation. Miss one → fails **at runtime, not build time**. Put these in the barrel:

**Loaders (replaces `import 'babylonjs-loaders'`):**
- `import '@babylonjs/loaders/glTF'` — glTF/GLB (Viewmodel, CharacterModel, arenaDressing, AnimPlayground). (Or `.../glTF/2.0`.)
- `import '@babylonjs/loaders/OBJ'` — OBJ maps (`BABYLONRenderer.js:466` AND **server** `GameInstance.js:613`, collision geometry from data URI).

**Core scene infra:**
- `import '@babylonjs/core/Loading/sceneLoader'`
- `import '@babylonjs/core/Loading/loadingScreen'` (SceneLoader triggers the loading UI; omitting can throw)
- `import '@babylonjs/core/Collisions/collisionCoordinator'` — **CRITICAL.** Powers `moveWithCollisions`/`checkCollisions` (client + server). Missing → silent no-op, players fall through the map.
- `import '@babylonjs/core/Culling/ray'` — `Ray` + scene picking prototype extensions.
- `import '@babylonjs/core/Animations/animatable'` + `@babylonjs/core/Animations/animationGroup` — glTF `AnimationGroup` playback.

**Rendering features:**
- `import '@babylonjs/core/Lights/Shadows/shadowGenerator'` **and** `.../shadowGeneratorSceneComponent` — the scene-component half is what makes materials sample the shadow map; missing → shadows silently vanish.
- `import '@babylonjs/core/Layers/glowLayer'` — GlowLayer.
- `import '@babylonjs/core/Helpers/photoDome'` + `@babylonjs/core/Materials/Background/backgroundMaterial` (PhotoDome renders on BackgroundMaterial).
- `import '@babylonjs/core/Materials/Textures/renderTargetTexture'` — `REFRESHRATE_RENDER_ONCE`.
- `import '@babylonjs/core/Materials/imageProcessingConfiguration'` — `VIGNETTEMODE_MULTIPLY`.

**Materials/textures (nothing renders without these):**
- `import '@babylonjs/core/Materials/standardMaterial'` — **CRITICAL** (21 sites + default material). Missing → everything black.
- `.../Materials/Textures/texture`, `.../Materials/Textures/dynamicTexture`, `.../Materials/effect` (the shadow-precision injection reads `Effect.IncludesShadersStore`; must load **before** any material compiles → keep at top of barrel).

**Meshes/builders (MeshBuilder methods added by per-shape modules):**
- `@babylonjs/core/Meshes/meshBuilder` + explicit shape builders: `boxBuilder`, `sphereBuilder`, `cylinderBuilder`, `groundBuilder`, `planeBuilder` (list explicitly — `MeshBuilder.CreateBox is not a function` is the failure mode).
- `@babylonjs/core/Meshes/instancedMesh` — `createInstance` (arena dressing).
- Classes: `@babylonjs/core/Meshes/mesh`, `.../transformNode`, `@babylonjs/core/Buffers/buffer` (VertexBuffer).

**Lights/cameras/engine/math (plain class imports):**
- Lights: `hemisphericLight`, `directionalLight`, `pointLight`, `light`.
- Cameras: `freeCamera`, `arcRotateCamera`, `targetCamera`. AnimPlayground's `cam.attachControl` also needs `Cameras/Inputs/arcRotateCameraPointersInput` (+ mousewheel/keyboard) — **skip if AnimPlayground is excluded from the prod entry**.
- Engines: `@babylonjs/core/Engines/engine`, `.../nullEngine` (8 NullEngine sites).
- Math (pure, no side-effects): `Vector3/Quaternion/Matrix` from `Maths/math.vector`; `Color3/Color4` from `Maths/math.color`; `Axis` from `Maths/math.axis`; `Scene` from `@babylonjs/core/scene`.

**Server-side note:** `GameInstance.js`/`BotController.js` need collision-coordinator, OBJ loader, sceneLoader, nullEngine — but **not** render-only modules (glow, photoDome, shadow, imageProcessing, camera inputs). **Use a separate slimmer server barrel** to avoid dragging renderer modules into Node. The `require('babylonjs')` scripts must move to ESM `import` (deep-path CJS `require` may not resolve via the `exports` map).

### `window.BABYLON` barrel pattern

UMD attaches `BABYLON` to `window` for free; scoped ESM does not, so `scripts/probe-anim.mjs:97` (and any live-scene probe) would get `undefined`. The shader-injection at `BABYLONRenderer.js:56` reads the *module's* `Effect`, so it's fine either way — but the probes need a global. Create `client/babylon.js`: side-effect imports first (effect/shader store before materials), then named re-exports of exactly the ~30 classes used, then `if (typeof window !== 'undefined') window.BABYLON = <the re-export namespace>`.

> **Gotcha:** do NOT `window.BABYLON = require('@babylonjs/core')` or `import * as BABYLON from '@babylonjs/core'` in prod just to feed probes — that re-imports the full barrel and un-does tree-shaking. Source the global from the curated re-exports only. If a bundler dislikes a circular self-import, build the namespace object explicitly from the concrete class list. Simplest robust variant: assign the global from the explicit class list, not a self-import.

### package.json changes

```diff
-    "babylonjs": "^4.0.3",
-    "babylonjs-loaders": "^4.0.3",
+    "@babylonjs/core": "^8.0.0",
+    "@babylonjs/loaders": "^8.0.0",
```
Keep both on the **same** 8.x minor (a version mismatch duplicates `@babylonjs/core` in the bundle — check `package-lock.json` resolves a single copy).

**`sideEffects` trap:** `@babylonjs/core`'s own `package.json` declares a curated `sideEffects` array (that's what lets tree-shaking drop unused modules while keeping deep-imported ones). **But** if `frag-arena`'s own `package.json` ever sets a blanket `"sideEffects": false`, the bundler may drop the barrel's bare `import '@babylonjs/core/...'` side-effect lines — silently un-registering loaders/collisions/materials. So either don't add `"sideEffects": false`, or whitelist the barrels: `"sideEffects": ["**/babylon.js", "**/babylon.node.js"]`.

### Realistic bundle outcome
- Today (webpack 4 + UMD 4.0.3): ~2.62 MiB.
- Path A (UMD 8.x): **worse**, ~4–5 MiB.
- Path B (scoped + curated barrel): ships only the used slice, drops PBR/GUI/physics/XR/particles/sprites/audio/node-material/post-process/~13 loaders. Babylon slice **~1.1–1.5 MiB** (glTF loader alone ~300–400 KiB, unavoidable). Total prod bundle **~1.4–1.8 MiB — roughly a 30–45% cut**, plus gzip/brotli and optional glTF-loader code-split. Further wins: exclude dev-only `AnimPlayground.js` from prod entry; confirm a single `@babylonjs/core` in the lockfile.

**Effort is real:** 23 files re-pointed (mechanical), 2 barrel modules authored, ~30 symbols mapped to submodule paths, `require`→`import` in scripts, and — the risky part — validating every side-effect module is present, since failures (black render, no shadows, players falling through the map, `CreateBox is not a function`) surface only at runtime for the specific missed feature. **Budget the side-effect verification, not the find-and-replace, as the bulk of the work.**


---

## 4. Vite build migration

### webpack → Vite mapping

| webpack 4 | Where today | Vite equivalent | Notes |
|---|---|---|---|
| `entry: './client/clientMain.js'` | `webpack.common.js:6` | `build.rollupOptions.input` | Non-HTML input is fine. |
| Fixed output `public/js/app-v0.0.1.js` | `webpack.common.js:8-9` | `build.outDir` + `output.entryFileNames` | Pin the name (Option B). |
| `mode` dev/prod | dev/prod configs | `defineConfig(({command}) => …)` | Auto. |
| `TerserPlugin` | `webpack.prod.js:3,8` | `build.minify: 'esbuild'` | Drops `terser` dep. |
| `webpack-dev-server` :8080 | `webpack.dev.js:7-12` | `server.port: 8080` | HMR built in. |
| `contentBase: public` | `webpack.dev.js:8` | `root`/`publicDir` | The tricky part — §4. |
| `webpack-merge` (3 files) | all configs | one `vite.config.js` | 3→1. |
| `NODE_OPTIONS=--openssl-legacy-provider` | `package.json:10-11` | *deleted* | §3. |
| implicit `process.env.NODE_ENV` | read at `Simulator.js:185` | explicit `define` | **Gotcha** — Vite doesn't shim `process.env`. |
| `patch-package` postinstall | `package.json:25` | unchanged | §6. |
| `stamp-build.mjs` | `package.json:11` | unchanged (Option B) | §8. |

### Recommendation: Option B — fixed output name, keep hand-authored index.html + stamp-build

Three codebase facts force it:
1. **`public/index.html` is hand-authored & served directly by nginx** (~600 lines: inline splash controller, HUD DOM, menu; manual `<script src="js/app-v0.0.1.js?v=…">` + CSS `<link>` at `:27,603`). Letting Vite own it (Option A) = large blast radius, zero gameplay benefit.
2. **`window.__BUILD_ID__` is a *runtime* cache-buster.** Read at runtime to version GLB/audio fetches: `Viewmodel.js:72-73,162-163`, `WeaponAudio.js:134`. Those GLBs are fetched by URL (not in the module graph), so Vite's content-hashing never touches them → `stamp-build.mjs` must survive **regardless** of bundler.
3. **Deploy expects `public/js/app-v0.0.1.js`** (nginx serves `public/`); keeping the name means deploy + nginx + stamp-build regexes all keep working.

Option A (Vite owns index.html, hashed names) is viable but needs reauthoring index.html, importing CSS through JS, `outDir=public/` with `emptyOutDir:false`, **and still a slimmed stamp-build for GLBs**. More churn, more deploy risk. Not recommended.

### The `--openssl-legacy-provider` hack — deleted
webpack 4 hashes chunk IDs with MD4; Node 17+ (OpenSSL 3) removed MD4 from the default provider → webpack throws `error:0308010C` unless the legacy provider is re-enabled. Vite (Rollup+esbuild) never uses MD4 → **flag obsolete**. Delete it and remove `cross-env`.

### Static assets — resolving the `public/` collision (do NOT move files)
`public/` is simultaneously nginx web root, hand-authored index.html/css/assets home, AND build output dir (`public/js`). Vite's default `publicDir` would self-copy/empty it.
- **`publicDir: false`** — opt out of Vite's public-dir machinery.
- **`build.outDir: 'public/js'`, `emptyOutDir: false`** — write only the bundle without wiping siblings.
- **`base: '/'`** — runtime GLB/OBJ/audio fetches are absolute-from-origin strings.
- **Dev root = `public/`** so the hand-authored index.html + sibling css/assets serve as-is; a `transformIndexHtml` (apply:'serve') plugin swaps the built-bundle `<script>` for the ESM source entry; `server.fs.allow: [ROOT]` so the module graph reaches `../client`, `../common`.

### Annotated `vite.config.js` (Option B)

```js
import { defineConfig } from 'vite'
import path from 'node:path'
const VERSION = '0.0.1'
const ROOT = __dirname
const ENTRY = path.resolve(ROOT, 'client/clientMain.js')

export default defineConfig(({ command }) => {
  const isBuild = command === 'build'
  return {
    root: isBuild ? ROOT : path.resolve(ROOT, 'public'),
    publicDir: false,                 // §4 collision fix
    base: '/',
    define: {                         // Vite does NOT shim process.env; Simulator.js:185 reads it
      'process.env.NODE_ENV': JSON.stringify(isBuild ? 'production' : 'development'),
    },
    optimizeDeps: {
      include: ['babylonjs', 'babylonjs-loaders'], // UMD/CJS — pre-bundle for dev
      // add 'nengi' if dev logs a CJS interop warning
    },
    server: {
      port: 8080, strictPort: true,
      proxy: { '/ws': { target: 'ws://localhost:8079', ws: true, changeOrigin: true } }, // OPTIONAL today
      fs: { allow: [ROOT] },
    },
    build: {
      outDir: path.resolve(ROOT, 'public/js'),
      emptyOutDir: false,
      target: 'es2019', sourcemap: true, minify: 'esbuild',
      rollupOptions: {
        input: ENTRY,
        output: {
          format: 'iife',                       // plain <script src>, matches index.html:603
          entryFileNames: `app-v${VERSION}.js`, // pin: app-v0.0.1.js
          inlineDynamicImports: true,           // single file so stamp-build hashes one
        },
      },
    },
    plugins: [devSourceEntry(isBuild, ROOT)],
  }
})

function devSourceEntry(isBuild, root) {
  return {
    name: 'dev-source-entry', apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<script src="js\/app-v[0-9.]+\.js[^"]*"><\/script>/,
        `<script type="module" src="/@fs/${path.resolve(root, 'client/clientMain.js')}"></script>`)
    },
  }
}
```
`format:'iife'` + `inlineDynamicImports` because the tag is a classic `<script src>` (not `type=module`) and stamp-build hashes exactly one file. The `?playground` branch uses a **static** import of `AnimPlayground`, so no code-splitting to worry about.

### package.json scripts
- **`client`**: `vite` (replaces `cross-env … webpack-dev-server`) — the only material change.
- **`build`**: `vite build && node scripts/stamp-build.mjs` (the tail is byte-for-byte the same).
- **`preview`** (new): `vite preview --port 8080`.
- **`start`/`server`/`server:once`**: untouched (tsx, orthogonal).
- **`verify:*`**: bundler-agnostic; keep pointing at `:8080` (or a `vite preview`). `process.env.NODE_ENV==='development'` in dev keeps `devToolsEnabled` on (`Simulator.js:185`).
- **Keep** `npm-run-all`, `tsx`, `patch-package`, `puppeteer-core`. **Remove** `cross-env`, `webpack`, `webpack-cli`, `webpack-dev-server`, `webpack-merge`, `terser-webpack-plugin`. **Add** `vite` (^6). `minify:'esbuild'` → no terser dep.

### patch-package, loaders, wasm
- **patch-package**: runs at postinstall, bundler-independent. Vite consumes already-patched `node_modules` (incl. the dev pre-bundle). No change.
- **Runtime-loaded meshes need no bundler config** — GLB/OBJ/audio are runtime URL fetches, never `import`ed; no `assetsInclude`/`assetsInlineLimit` tuning needed. Static under `public/assets/`.
- **No worker config** needed (no `new Worker(new URL(...))`).
- **Draco/wasm heads-up (runtime, not Vite):** if a weapon GLB uses `KHR_draco_mesh_compression`, Babylon's loader pulls the Draco decoder from a CDN unless configured — a runtime concern.
- **CJS/ESM interop:** `babylonjs`/`babylonjs-loaders` are UMD/CJS; `import * as BABYLON` + side-effect loaders work under Vite (Rollup/esbuild interop), faster in dev via `optimizeDeps.include`. When migrating to scoped `@babylonjs/core` ESM (may bring wasm side-modules), revisit `optimizeDeps.exclude` + `assetsInclude` for `.wasm`.

### Gotchas
1. **`public/` collision (highest risk):** must set `publicDir:false` + `emptyOutDir:false` or Vite copies/empties the live web root.
2. **Fixed output name:** pin via `output.entryFileNames` + `format:'iife'` + `inlineDynamicImports`.
3. **`process.env.NODE_ENV` not shimmed:** without the `define` block, `Simulator.js:185` throws `ReferenceError: process is not defined`. (Cleaner long-term: use `import.meta.env.PROD`.)
4. **Dev has no built bundle:** the `transformIndexHtml` plugin rewrites the `<script>` to the ESM source entry; `server.fs.allow:[ROOT]` required.
5. **WS proxy optional today:** client dials `ws://hostname:8079` directly in dev (`GameClient.js:26`), bypassing Vite. Add the `/ws` proxy + switch GameClient's dev branch only if you want dev to mirror prod's nginx `/ws`.
6. **Delete `--openssl-legacy-provider` / `cross-env`.**
7. **Keep stamp-build in `build`** — it versions runtime-fetched GLBs/audio via `window.__BUILD_ID__`, which Vite hashing never covers.


---

## 5. Server, shared code & netcode

The non-browser side runs the **same Babylon math + collision engine as the client**, headless under `NullEngine`. `serverMain.js` is launched via `tsx watch`, builds one `GameInstance`, steps it at `UPDATE_RATE=40` Hz. The authoritative sim, client prediction, and every `tsx` verify harness all execute the identical `common/applyCommand.js` — so **the Babylon upgrade is a physics-determinism change, not just a client-render change.**

### Server-executed Babylon symbols

| Symbol (server-executed) | path:line | 8.x action |
|---|---|---|
| `NullEngine` | `GameInstance.js:73`; `verify-map.ts:31`; `_sweep-pad.ts:12` | `@babylonjs/core/Engines/nullEngine` |
| `Scene`, `collisionsEnabled` | `GameInstance.js:75-76`; `verify-map.ts:33-34` | `@babylonjs/core/scene` + collision-coordinator side-effect |
| `Vector3` (+ `.scale/.add/.subtract/.normalize`) | `applyCommand.js:2,69,80`; `weapon.js:3,99`; `GameInstance.js:327,402,449`; `BotController.js:30`; `PlayerCharacter.js:12` | `Maths/math.vector` |
| `Vector3.TransformCoordinates` | `applyCommand.js:80,111`; `weapon.js:95` | core Maths (deterministic) |
| `Matrix.RotationAxis`, `Axis.Y` | `applyCommand.js:2,79` | `Maths/math.axis` |
| `Color4` (module top-level → runs on server) | `PlayerCharacter.js:5-7` | `Maths/math.color` — server DOES construct these |
| `MeshBuilder.CreateBox` | `PlayerCharacter.js:11`; `Obstacle.js:6`; `verify-map.ts:36`; `MegaHealthPickup.js:26` | `Meshes/Builders/boxBuilder` |
| `MeshBuilder.CreateSphere` | `Projectile.js:13`; `Grenade.js:16` | **`Meshes/Builders/sphereBuilder`** — bare collision mesh built on server too |
| `mesh.moveWithCollisions` | `applyCommand.js:158` | **the crux — see below** |
| `checkCollisions`, `ellipsoid` | `PlayerCharacter.js:12-13`; `Obstacle.js:7`; `GameInstance.js:132,152,572,626` | needs collision side-effect active |
| `Ray` + `intersectsMesh` | `weapon.js:3,99`; `GameInstance.js:327`; `BotController.js:28,34`; `lagCompensatedHitscanCheck.js:26` | **`Culling/ray` side-effect** |
| `Engine.LastCreatedScene` | `Projectile.js:7`; `Grenade.js:12`; `MegaHealthPickup.js:21` | still on `Engine`/`EngineStore` in 8 |
| `SceneLoader.ImportMeshAsync` + OBJ | `GameInstance.js:31,613` | deprecated; OBJ → `@babylonjs/loaders/OBJ` |
| `TransformNode` | `GameInstance.js:616` | core |

Client-only symbols imported into shared modules but guarded off server via `getEngine().name !== 'NullEngine'`: `StandardMaterial`, `Color3`, `Engine.ALPHA_ADD` in `Projectile.js:21-39`, `Grenade.js:22-39`, `MegaHealthPickup.js:32-36`. Under `import * as BABYLON` these still get pulled into the Node build though never run — see below.

### Required Node-side side-effect imports (put in a shared module both sides import)
```js
import "@babylonjs/core/Engines/nullEngine";
import "@babylonjs/core/Collisions/collisionCoordinator"; // moveWithCollisions / checkCollisions
import "@babylonjs/core/Culling/ray";                     // ray.intersectsMesh (hitscan, bot LoS, lag-comp)
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";   // Projectile/Grenade build mesh under NullEngine
import "@babylonjs/loaders/OBJ";                          // mesh-map collider from data URI
```
- **`collisionCoordinator` is load-bearing.** Without it `collisionsEnabled` no-ops and `moveWithCollisions` (`applyCommand.js:158`) degrades to a raw translate — players walk through walls, never ground. Must be present on **both** sides identically.
- **`Culling/ray`** makes `ray.intersectsMesh` return a real hit — lag-comp hitscan, bot LoS, pellet rays.
- **`sphereBuilder` is easy to miss** — Projectile/Grenade build their mesh even under NullEngine (only the glow material is guarded).
- **4→8 behavior:** NullEngine still works headless; `enableOfflineSupport=false` (`GameInstance.js:74`) still valid. **Real risk: the collision solver's slide/epsilon math may have changed 4.0.3→8.x** — `moveWithCollisions` resting Y, wall-slide, jump-pad ballistics can shift, and `mapMesh.js` spawns/`killY` + `JUMP_PADS` launch vectors were **calibrated on 4.0.3**. Re-run `verify-map.ts`/`verify-meshmap.ts` post-bump and expect to re-tune.

### tsx / Node 22 ESM
- `common/*.js` are ESM; tsx transpiles them. Moving to `@babylonjs/core` makes them **native ESM-to-ESM** (cleaner, no interop shim). Deep subpaths resolve under Node 22 ESM; no special tsx config.
- **`require` in ESM:** `GameInstance.js:33` (`require('xhr2')`) and `:611` (`require('fs')`) work because tsx polyfills `require`. Keep, or convert to `createRequire`. Pure `node` would throw — fine, server is always launched via tsx.
- **Dead legacy entry:** `server/index.js` still uses the abandoned `esm` bootstrap; nothing imports it (run scripts target `serverMain.js`). Harmless but delete it.

### nengi 1.18 + patches (independent of migration, one is a Vite prerequisite)
- **`patches/nengi+1.18.0.patch`** rewrites nengi's `esm`-hook bootstrap to native `export { default } from './index-es6.js'` — **required for Vite** (Vite/esbuild can't run the `esm` runtime hook) and for tsx. Zero Babylon coupling. Keep.
- **`patches/@clusterws+cws+3.0.0.patch`** shims the abandoned native `@clusterws/cws` over pure-JS `ws` + adds a `handleProtocols` echo for the `nengi-protocol` subprotocol. Server-transport only; survives untouched.
- **Vite gotcha:** unlike webpack 4, Vite does **not** auto-polyfill Node built-ins. If nengi's client entry isn't cleanly tree-shakeable and the server transport path leaks into the client bundle, Vite tries to bundle `ws`/`@clusterws/cws` → `net`/`tls`/`http` and breaks the browser build. **Mitigation:** verify nengi resolves a browser-safe entry; if not, alias `ws` and `@clusterws/cws` to an empty stub in the client Vite config. Keep nengi 1.18 pinned (unmaintained; out of scope to replace).

### Shared-code bundling both ways
`common/*` is consumed by both the Vite client and the tsx server. The scoped + side-effect approach works in both **if the side-effect set is centralized in one shared module** both entrypoints import — else the two builds register different feature sets (desync).
- `Projectile.js`/`Grenade.js`/`MegaHealthPickup.js` reference `StandardMaterial`/`Color3`/`ALPHA_ADD` inside NullEngine guards; the namespace import drags rendering/material modules into the Node build (bloat, slower cold-start). **Convert these to named imports** so esbuild drops the material path from the Node bundle.
- `PlayerCharacter.js:11` builds `CreateBox` with `faceColors` (Color4) at construction — this **does** run on the server; keep `Color4` + `boxBuilder`.
- The OBJ loader is **server-critical** (`GameInstance.js:613` loads the map as server collision geometry from a `data:` URL) — `@babylonjs/loaders/OBJ` must be in the Node build.

### Node version, xhr2, NODE_OPTIONS
- Runtime is **Node 22** via tsx. Add `"engines": { "node": ">=22" }`.
- **`xhr2` (runtime dep):** the headless Node side has no `XMLHttpRequest`; Babylon's SceneLoader issues one to "fetch" the OBJ map (even from a `data:` URL). `GameInstance.js:33` installs it globally before the OBJ import. Babylon 8 still routes Node file loading through its XHR wrapper; Node 22 has global `fetch` but not `XMLHttpRequest` → **keep `xhr2`**, verify the OBJ path after the bump.
- **`NODE_OPTIONS`:** only the webpack scripts used `--openssl-legacy-provider`; Vite removes the need. The tsx server never used it. Post-migration: no `NODE_OPTIONS` anywhere.

### ⚠️ Desync risk callout (highest priority)
**Client and server MUST run identical collision math or prediction reconciliation drifts.** The same `applyCommand.js:158` `moveWithCollisions` is the authoritative move (server) and the predicted move (client); nengi replays it during reconciliation. Two failure modes:
1. **Version skew** — if the Vite client and tsx server resolve different `@babylonjs/core` patch versions, `moveWithCollisions`/`intersectsMesh` can produce byte-different results → constant reconciliation snapping, hitscan disagreeing with the crosshair. **Pin one exact `@babylonjs/core` version for both.**
2. **Side-effect-import skew** — collision/ray now depend on side-effect imports; if the client registers them implicitly while a leaner server set omits `collisionCoordinator`/`Culling/ray`, the server's move no-ops or hitscan never hits while the client predicts normal movement → immediate desync. **Put the entire side-effect block in one shared module imported by both.**

Even in lockstep, the 4.0.3→8.x solver change shifts resting/slide positions vs the old tuning. Re-run `verify-map.ts`, `_sweep-pad.ts`, `verify-meshmap.ts` post-upgrade and re-tune before shipping.


---

## 6. Verify harness & asset pipeline

Everything that consumes the built client or loads runtime assets: ~30 `scripts/*.mjs`/`*.ts` puppeteer harnesses, `assetManifest.js` + `assetPreloader.js`, `stamp-build.mjs`.

### Runtime hooks that MUST be preserved

| Hook | Set at | Read by | Fate under Vite + scoped Babylon 8 |
|---|---|---|---|
| `window.gameClient` | `clientMain.js:18` | every browser verify (`verify-netcode.mjs:67`, `verify-movement.mjs:81`, `verify-firing-fx.mjs:55`, `probe-live.mjs:20`…) | **Survives** — explicit `window.` assign, bundler-agnostic. Non-negotiable. |
| `window.playground` + `?playground` | `clientMain.js:7-11` | `verify-helmet-anims.mjs:4`, `probe-helmet.mjs:7`, `probe-playground.mjs:6`, `tune-helmet.mjs:9` | **Survives**; needs Vite dev to serve index.html at `/?playground` (trivial, path is `/`). |
| `window.__BUILD_ID__` | injected by `stamp-build.mjs:61-64`; read at `index.html:595` | `Viewmodel.js:72-73,162-163`, `WeaponAudio.js:134` append `?v=<id>` to runtime fetch URLs | **Must be preserved** (§ cache-busting). Produced by the post-build stamp, not the bundler. |
| `window.BABYLON` (UMD global) | side-effect of monolithic `babylonjs` UMD | in-page `page.evaluate`: `probe-anim.mjs:97`, `verify-fire-attachment.mjs:92,98-100`, `verify-helmet-anims.mjs:27` | **Breaks** under scoped imports (no window attach). `verify-scifi-skin.mjs:90` already notes "page has no BABYLON global" and works around it — so it's **already unreliable**; only 3 scripts assume it. Remedy: (a) dev-only barrel `window.BABYLON = core`, or (b) rewrite those 3 to reach math via `gameClient` objects. |

**Also load-bearing (not globals, but hard-coded object paths — don't rename):** `gameClient.simulator.myRawEntity`, `gameClient.client.entities`/`.tick`, `gameClient.simulator.renderer.scene`/`.camera`/`._muzzleLight`/`._pool.smoke`, `gameClient.simulator.viewmodel.ready`/`.spec.index`/`._result`, `renderer.arenaDressing._nodes`, `simulator.input._currentState`/`frameState`.

### Dev-server URL/port contract
- **`http://localhost:8080/`** default (overridable via `FRAG_URL`) for essentially every browser harness. **Vite must serve on `:8080` and serve index.html at `/`** or every script needs editing. Cheapest path: pin Vite to 8080.
- **`:8081/?playground`** hardcoded (no env) in `verify-helmet-anims.mjs:4`, `probe-helmet.mjs:7`, `probe-playground.mjs:6`, `tune-helmet.mjs:9` — implies a second dev instance historically on 8081; breaks under Vite unless an 8081 instance is served or scripts updated.
- **`:8180/?playground`** served by `scripts/serve-public.mjs` (static `public/`, `PORT=8180`) against the **prebuilt** bundle.
- **Self-serve-`public/` scripts** spin up their own `http.createServer` loading the **built** bundle: `verify-aiming.mjs:12-13`, `pistol-height.mjs`, `rifle-height.mjs`, `render-shot.mjs`, `verify-touch-aim.mjs`, `verify-meshmap.mjs`, `shot-objmap.mjs`, `shot-visage.mjs`. **They read `public/js/app-v0.0.1.js` via the committed `public/index.html`.** Under Option B (fixed name, output stays in `public/js`) these keep working unchanged; under Option A (hashed → `dist/`) their static `ROOT` must repoint from `public` → `dist` (`serve-public.mjs:8` is the shared choke point).
- **Prod `https://sol-pkmn.fun/`**: `probe-live.mjs`, `probe-float.mjs`, `verify-live-connect.mjs` — the real test that cache-busting survived deploy.

### Asset pipeline — zero assets are bundler-resolved (the easy case)
Repo-wide grep for `import x from '*.png|glb|gltf|mp3…'` / `require('*.png')` in `client/`+`common/` returns **nothing**, and the webpack configs declare **no `module.rules`/loaders**. Every asset is a runtime absolute-URL fetch:
- GLB/glTF/textures via `assetManifest.js` string URLs (`hero_male.glb:25`, `helmet_0.glb:50`, `Gun_Rifle.gltf:89`…); `assetPreloader.js` passes them straight to the loader.
- Arena dressing: `arenaDressing.js:15` `BASE='/assets/scifi/'`.
- Audio: `WeaponAudio.js:136` `fetch('/assets/sfx/'+name+'.mp3'+v)`.
- Fonts/CSS/brand: static `<link>`/`<img>` in index.html; CSS is a hand-authored static file (public-dir asset).

**Vite implication: easy.** Preserve the `public/` layout so `/assets/…` and `/css/…` resolve identically (Vite copies publicDir verbatim, no hashing, no import graph) → asset pipeline works with **no code changes**. Caveat (import-agent's concern): SceneLoader plugins are registered by the side-effect `import 'babylonjs-loaders'`; if dropped, every `/assets/*.glb` fetch still succeeds over HTTP but yields **no meshes** (silent) — top regression to catch.

### stamp-build.mjs + cache-busting — fate
Today: after webpack prod, hashes content of `public/js/app-v0.0.1.js` + `public/css/styles-v0.0.1.css` + every `public/assets/weapons/*.glb` (`:24-34`) into one `BUILD_ID` (`:45`), then edits `public/index.html`: (1) `?v=` on the app `<script>` (`:52-54`), (2) `?v=` on the CSS `<link>` (`:56-58`), (3) injects `window.__BUILD_ID__` (`:61-64`).
- **(1)+(2)** bust JS/CSS caches on **fixed** filenames. Under **hashed** output they become dead no-ops (Vite's hashing already busts JS/CSS). Under **fixed-name** output (Option B) they still work and are still needed.
- **(3) is NOT redundant under either strategy — MUST keep.** `window.__BUILD_ID__` busts the **runtime-fetched** GLBs/mp3s Vite never hashes (they live in publicDir, copied un-hashed) — without it a phone mixes a new bundle with a stale cached GLB.

**Next engineer:** keep a post-build stamp step in `npm run build`. Option B: **survives nearly verbatim** (repoint paths if names drift). Option A (hashed JS/CSS): **shrink stamp-build to just step (3)** — hash the GLB/mp3 content, inject `window.__BUILD_ID__` into the built `dist/index.html`, drop the `?v=` script/link rewrites, retarget paths `public/`→`dist/`.

### Migration acceptance checklist (ordered — cheapest/most-diagnostic first)
> Add the manually-run `tsx`/`node` scripts (`verify-map.ts`, `verify-meshmap.ts`, `verify-aiming.mjs`, `verify-touch-aim.mjs`) to the run set — only the `verify:*` names are in package.json.

**Phase 0 — offline sim/loader parity (Node NullEngine, no dev server, no bundle):**
1. `tsx scripts/verify-map.ts` — authoritative collision + jump-pad ballistics on NullEngine. **Best detector of (c) collision/physics desync** and Babylon-8 NullEngine/`moveWithCollisions` breaks.
2. `npm run verify:anim` — NullEngine `ImportMeshAsync` from `/assets/weapons/`. **Best Node-side detector of (a) a missing loader side-effect** (throws "no plugin for .gltf").
3. `tsx scripts/verify-meshmap.ts` — GLB map import + collision walk.

**Phase 1 — bundle boots + sim parity (browser):**
4. `npm run verify` (netcode) — **the canary.** If the Vite bundle throws on load or a hook was renamed, `waitForFunction(window.gameClient…)` times out here first. Validates handshake/replication/prediction.
5. `npm run verify:movement` — jump/dodge/gravity + "no reconciliation spam". **Best browser detector of (c) prediction/physics desync.**
6. `npm run verify:1v1` — damage/death/respawn (hit-reg).
7. `npm run verify:bots` — populated-room stability.

**Phase 2 — renderer/material/loader parity (browser):**
8. `npm run verify:scifi` — arena-dressing GLB load, obstacle/instance/`_nodes` counts. **Best browser detector of (a) a silently-absent loader/material** (dressedNodes/instances = 0, no error).
9. `npm run verify:viewmodel` — first-person GLB import, skeleton/animationGroup/mesh counts + no-leak.
10. `npm run verify:fx` — muzzle light pulse + smoke + the **scene-light-count-constant / "no uncaught client errors"** invariant. **Best detector of (b) a shader-injection break** (the custom `Effect` string-patch).
11. `npm run verify:fire` — bone/muzzle attachment. **Note: uses `window.BABYLON` in-page (`:92`) → itself breaks under scoped imports until fixed.**
12. `verify:weapons`, `verify:killfeedback`, `verify:touchlook`, `verify:mobile`, `verify-aiming.mjs`, `verify-touch-aim.mjs` — input/HUD/ADS; last two also test the **built** bundle (repoint ROOT to `dist/` if Option A).

**Phase 3 — production bundle + cache-busting:**
13. `npm run build` then a self-serve script — proves the Vite prod bundle loads and `window.__BUILD_ID__` is present.
14. Confirm the built `index.html` carries `window.__BUILD_ID__` and GLB/mp3 fetches include `?v=<id>`; then `probe-live.mjs` against the deployed build for a real-nginx cache-bust smoke.

**Regression→detector summary:** (a) missing loader/material import → `verify:anim` (throws) + `verify:scifi`/`verify:viewmodel` (silent-zero-meshes); (b) shader-injection break → `verify:fx` (+ `verify:viewmodel` skinned compile); (c) collision/physics desync → `verify-map.ts` (authoritative) + `verify:movement` + `verify:1v1`.


---

## 7. WebGPU feasibility & shader/render risk

**Key fact:** the whole client renders through `BABYLONRenderer.js` (1208 lines) on a **manual RAF loop, not `engine.runRenderLoop`** (`clientMain.js:21-31` → `GameClient.update` → `Simulator.update` → `renderer.update()` → `scene.render()` at `:1203`). There is **no custom `ShaderMaterial`, `NodeMaterial`, or raw shader anywhere** (grep is empty) — the entire look is `StandardMaterial` + stock shaders + `GlowLayer` + `PhotoDome` + material-level `ImageProcessingConfiguration`. So there is almost no custom GLSL to port. The one exception is the shader-include string patch.

### The `#ifdef WEBGL2` shader-injection block (`BABYLONRenderer.js:49-64`)
Runs at module scope on import, before any engine exists:
```js
const store = BABYLON.Effect.IncludesShadersStore
const inc = store && store.shadowsFragmentFunctions
if (inc && inc.indexOf('precision highp sampler2DShadow') === -1) {
    store.shadowsFragmentFunctions = inc.replace(
        '#ifdef WEBGL2', '#ifdef WEBGL2\nprecision highp sampler2DShadow;')
}
```
- **What/why:** Babylon 4.0.3's WebGL2 PCF helpers declared `sampler2DShadow` params without a default precision. Lenient desktop drivers accept it; strict GLES compilers (SwiftShader, some mobile GPUs) reject the whole effect → shadow-receiving materials fall back to a no-shadow variant, and (per the comment) that churn can crash the instanced-mesh VAO bind. The patch injects `precision highp sampler2DShadow;` before any effect compiles. Pure brittle **string-replace against Babylon-internal GLSL**; idempotent + self-disabling.

**Fate on Babylon 8 / WebGL2 — probably a harmless no-op, but VERIFY (real risk, not a freebie):**
- Babylon 8's default engine is WebGL2-only, so `#ifdef WEBGL2` is always taken; the strict-GLES concern still exists (SwiftShader/mobile compile GLSL ES 3.0).
- But the patch depends on two internal strings with ~6 years to change: the include named exactly `shadowsFragmentFunctions`, and it still containing the literal `#ifdef WEBGL2`. Two silent-failure modes: (1) include renamed/removed → `inc` undefined → no-op (safe); (2) include exists but no longer contains `#ifdef WEBGL2` (very likely now that WebGL2 is unconditional) → `.replace` no-match → precision line never injected, silently. If modern Babylon already declares the precision (highly likely — fixed upstream long ago), fine; if not, shadows break only on strict drivers desktop dev never sees.
- **Action:** grep Babylon 8's `shadowsFragmentFunctions` for `sampler2DShadow` + a precision qualifier. If present → **delete the block**. If not → keep it but re-derive the anchor from the actual v8 source. Either way, **smoke-test shadows under SwiftShader** (the existing `scripts/` puppeteer harnesses already run software GL — the exact environment this patch targets).

**Fate under WebGPU — inapplicable and inert:** WebGPU uses **WGSL, not GLSL**, compiled from a separate WGSL store (`ShaderStoreWGSL`), not the GLSL `Effect.IncludesShadersStore` this patches → no-op. The content is meaningless in WGSL (no `#ifdef WEBGL2`, no `precision highp`, no `sampler2DShadow` — WGSL uses `texture_depth_2d` + `sampler_comparison`). Nothing to port; delete/skip on the WebGPU path. The real WebGPU question is whether StandardMaterial's *generated WGSL* shadow path renders correctly (a support question, verify by eye).

### WebGPUEngine adoption & async-init restructuring
`new Engine(canvas, true)` (`:68`) is synchronous. `WebGPUEngine` requires `await engine.initAsync()` **before any scene/material/forceCompilation/render**. The renderer ctor currently does ALL of that synchronously (`:68-459`, incl. six `forceCompilation` calls at `:452-457`). A JS ctor can't be async → **static async factory + two-phase boot**, and the async-ness ripples up 3 levels (Simulator reads `renderer.scene`/`.camera` immediately at `Simulator.js:52,122`; GameClient builds Simulator sync at `GameClient.js:11`; clientMain builds GameClient + starts RAF sync at `clientMain.js:16,31`).

**After (sketch):**
```js
// BABYLONRenderer.js
static async create() {
  const r = Object.create(BABYLONRenderer.prototype)
  const canvas = document.getElementById('main-canvas')
  const wantWebGPU = /* runtime flag */ && await BABYLON.WebGPUEngine.IsSupportedAsync
  if (wantWebGPU) { r.engine = new BABYLON.WebGPUEngine(canvas); await r.engine.initAsync() }
  else            { r.engine = new BABYLON.Engine(canvas, true) }   // unchanged WebGL2 path
  r._build()   // everything after `new Engine` in the current ctor moves here
  return r
}
// Simulator.create(client): sync field-init + `await s.init()` (awaits BABYLONRenderer.create())
// clientMain: window.onload = async () => { const gc = await GameClient.create(); window.gameClient = gc; loop() }
```
Notes:
- **The manual-RAF design helps** — gating boot is just "don't call `loop()` until the awaited factory returns"; no render-loop restructure.
- **`window.gameClient` appears one microtask-chain later** → headless harnesses that assume it exists synchronously after load must poll/await (flagged for harness section).
- **`setHardwareScalingLevel` parity:** identical (WebGPUEngine extends the same base); the pixel-budget cap + resize handler carry over unchanged.
- **Perf work carries over:** shadow `REFRESHRATE_RENDER_ONCE` freeze + hardware-scaling cap are engine-agnostic.
- **Snapshot rendering (WebGPU bonus): do NOT adopt.** The renderer mutates the scene every frame (pooled FX toggle visibility/transforms/layerMask, per-mesh texture swaps `:842-852`, per-frame depth clear) — exactly what snapshot FAST mode assumes doesn't happen. Big behavioral risk, no clear win.

### Per-feature WebGPU-support table

| Feature (path:line) | WebGPU in Babylon 8 | Risk | Notes |
|---|---|---|---|
| `StandardMaterial` (all, e.g. `:282`) | Supported | Low | WGSL variant, verify look |
| `ImageProcessingConfiguration` material-level (`:102-112`) | Supported | Low–Med | Baked in WGSL; check vignette/tonemap match |
| `GlowLayer` selective bloom (`:444-449`) | Supported | **Med** | Effect layers historically WebGPU-fragile; verify whitelist bounds |
| `PhotoDome` + space spheres (`:226,:235-267`) | Supported | Low | Plain meshes + textures |
| blur ESM shadows + `RENDER_ONCE` (`:156,:169`) | Supported | Med | API fine; WGSL shadow *fidelity* to verify |
| `createInstance` + shadow renderList (`arenaDressing.js:171,179`) | Supported | Low | No VAO → old crash concern moot |
| `forceCompilation` warm (`:452-457`) | Supported | Low–Med | Async pipeline; confirm no first-shot hitch |
| `layerMask` dual-camera / `activeCameras` (`:118,125,134`) | Supported | Low | |
| **Manual depth clear between cameras** (`:130`) | Uncertain | **High** | Mid-frame depth-only clear across pass boundary — test first |
| GLSL `IncludesShadersStore` patch (`:55-64`) | N/A (inert) | ok | WGSL uses a different store; delete on WebGPU path |
| `setHardwareScalingLevel` + resize (`:84-92`) | Supported | Low | Identical API |
| `new Engine(...)` sync ctor (`:68`) | **Breaks** | **High** | Requires `await initAsync()` → async boot |
| Snapshot rendering (bonus) | Supported but **unsuitable** | — | Scene mutates every frame |

> ⚠️ **The mid-frame depth clear is the highest render-specific WebGPU risk.** `onBeforeCameraRenderObservable` calls `engine.clear(null, false, true, false)` (depth-only) before the viewmodel camera renders (`:128-132`) so the gun draws depth-cleared over the world. WebGPU handles clears via render-pass `loadOp`/`storeOp` at pass boundaries; a depth-only clear injected *between* two `activeCameras` is the operation most likely to differ (or need a fresh pass) on WebGPU. If it breaks, the viewmodel z-clips through world geometry. Test this first; it's the item most likely to need a WebGPU-specific path.

*"Supported" = Babylon 8 exposes it on WebGPU per shared architecture; not run on this codebase — treat shadow/glow/tonemap fidelity as verify-by-eye, not byte-identical.*

### Staged recommendation
**Ship Babylon 8 on WebGL2 first (behavior-preserving), then add WebGPU as a runtime-detected opt-in later.**
1. **WebGL2 is low-risk/high-certainty** — no custom shaders to port; the injection block is (almost certainly) an obsolete no-op; the engine ctor stays synchronous, so the entire async-boot restructure (and the `window.gameClient` timing change rippling into the harnesses) is **avoided for the first ship**. Migrating 4→8 API drift is the real work — don't compound it with an async rewrite.
2. **WebGPU's per-feature status is "supported but unverified for this scene."** Two items (mid-frame depth clear, effect-layer glow) are genuinely uncertain → opt-in territory.
3. **WebGPU fits this game's shape well when added** (static scene, frozen shadow map, no custom shaders) — a clean future win. Keep both engines behind one factory + a `?webgpu`/stored-flag toggle with automatic WebGL2 fallback.

**WebGPU opt-in changes, ranked by risk (highest first):** (1) async boot restructure + harness timing; (2) the mid-frame depth clear; (3) GlowLayer selective bloom; (4) shadow visual fidelity (WGSL); (5) image-processing parity; (6) delete/skip the GLSL patch on the WebGPU path; (7) `forceCompilation` first-shot warm. Separately (independent of WebGPU): as part of the WebGL2 migration, verify-or-delete the `#ifdef WEBGL2` patch against Babylon 8's actual source and regression-test shadows under SwiftShader.


---

## 8. External research & version cross-check (web, mid-2026)

Verified against live sources July 2026. **Most important correction: the plan targeted "8.x", but 8.x is no longer current** — Babylon 9.0 shipped 2026-03-26 and npm `latest` is 9.17.0. Below assumes the real target is **9.x**, flagging where 8-vs-9 matters.

### Verified facts (dated sources)
- **Current: `@babylonjs/core` and `babylonjs` (UMD) both `9.17.0`**, published in lockstep, `latest` as of 2026-07-19 (npm registry JSON — npmjs.com HTML 403s automated fetch).
- **9.x is current; 8.x is one major behind.** 9.0 announced 2026-03-26 (`blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/`); 8.0 was 2025-03-27.
- **Cadence:** one major/year each March; frequent minors (9.x already at .17 by July). UMD `babylonjs` still maintained at parity, but docs steer migrating projects to ES6 `@babylonjs/core`.
- **`@babylonjs/core` `sideEffects` is an explicit ~400-glob allow-list, NOT `false`** (verified from published `package.json`) — this is what makes tree-shaking safe. No runtime deps, no `engines` field.
- **`SceneLoader.ImportMeshAsync` is deprecated** → module funcs `ImportMeshAsync`, `AppendSceneAsync`, `LoadSceneAsync`, `LoadAssetContainerAsync`, `ImportAnimationsAsync`.
- **Vite current major is 7.0** (2025-06-24), ESM-only, **requires Node 20.19+ or 22.12+** (Node 18 EOL-dropped). App's Node 22 is fine. *(Note: §4's config drafts referenced Vite 6/`^6`; bump to Vite 7 — config shape is compatible, just verify Node ≥ 20.19/22.12 on all build images.)*
- **WebGPU near feature-complete but not a drop-in default.** `WebGPUEngine` needs `await initAsync()`; **GLSL custom shaders still work** (no forced WGSL rewrite); `EngineFactory.CreateAsync()` tries WebGPU→WebGL→NullEngine.
- **WebGL (incl. WebGL1) has NOT been removed** as of 8/9 — "maintained side by side with WebGPU for the foreseeable future."

### Claim → web says → correction

| Plan assumption | Web says (mid-2026) | Correction/confirmation |
|---|---|---|
| Target "8.x" | Latest **9.17.0**; 9.0 Mar 2026 | **Correct to 9.x** — one hop; 4→8 and 8→9 breaking surfaces are cumulative anyway. |
| Both packages at 8.x | Both **9.17.0**, lockstep | Confirmed both exist; UMD maintained; `@babylonjs/core` is the tree-shaking target. |
| **WebGL1 dropped in a major** (assumed in §2/§7) | **Not dropped**; WebGL kept side-by-side | **Reconciled below.** The `#ifdef WEBGL2` guard the shader-patch searches for likely still exists (WebGL1 path present) — so §7's "guard text removed → silent no-op" is *less* likely, but the "verify against actual source + SwiftShader smoke-test" action stands. |
| `ImportMeshAsync` deprecated w/ new signature | Confirmed → `ImportMeshAsync(source, scene, options?)`, `async`, options object not positional | **Confirmed.** Old class callable but flagged. Rewrite call sites (9 client + server). |
| glTF loader registration changed | Yes — ES6 needs side-effect registration | `import "@babylonjs/loaders/glTF.js"` + `import "@babylonjs/loaders/OBJ.js"`, **or** new `import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic"; registerBuiltInLoaders()`. |
| ImageProcessing default tonemap operator changed | **Could not verify** a default flip; tonemapping still opt-in, default Standard | **Unverified** — audit visually, don't trust a spec change. The real visual risk is sRGB/gamma (below). |
| Custom GLSL needs WGSL under WebGPU | Core ships GLSL+WGSL; **custom GLSL still supported** on WebGPU | **No forced rewrite.** But GLSL relying on `#ifdef WEBGL2`/GL built-ins may hit the compat path — validate on WebGPU or stay WebGL2. |
| `scene.activeCameras` behavior | No specific 4→9 break surfaced | Dual-camera layerMask viewmodel still idiomatic; **verify at runtime** (unverified). |
| Bundle 2.62 MiB monolith | ES6 selective imports commonly cut to **~700 KB** (Babylon's example: "700Kb vs 2.3Mb"); importing from the barrel defeats it (~4 MB) | Confirmed — big wins need **per-file/curated-barrel** imports, not `@babylonjs/core` root. |
| instances/CSG unaffected | 8.0: **instances now created with a parent**; `CSG`→`CSG2` (Manifold) | App uses `instances` — verify parenting didn't shift the viewmodel/mesh hierarchy. App doesn't use CSG. |

### Things we might be missing (not visible to static analysis)
- **Silent visual drift is the #1 real risk.** A documented 4→8 upgrade rendered materials "wrapped in plastic" (clear-coat re-enabled + IBL/energy-conservation default flips). This app uses **StandardMaterial**, so PBR-specific flags matter less — **but the sRGB/gamma-buffer + `getCaps().supportSRGBBuffers` changes affect StandardMaterial textures, GlowLayer intensity, and ImageProcessing exposure/contrast/vignette**, all of which this game deliberately tunes. **Budget a side-by-side visual-QA pass and expect to re-tune numbers** (do it in Phase 2). Restoration flags exist if needed (`PBRBRDFConfiguration.DEFAULT_*`, `supportSRGBBuffers`).
- **`sideEffects` allow-list is good, but** if the app (or an aggressive minifier) ever forces `"sideEffects": false` on `@babylonjs/core`, or strips "unused" imports, shader/loader **registration silently vanishes** (black screen / "no loader for .glb"). Keep side-effect imports at a top-level module.
- **patch-package + Vite/ESM interplay (important — the current shader patch collides here).** Under ES6, the node_modules paths patch-package targets change entirely (`@babylonjs/core/...` ESM). Existing Babylon patches need regeneration. **And Vite pre-bundles deps via esbuild — it can serve a cached copy that bypasses your patch** unless you `optimizeDeps.exclude` the patched package or clear `.vite` cache. **Prefer replacing the node_modules string-patch with Babylon's supported shader-store injection API** rather than patching. *(This reinforces §2/§7: get off the internal-string patch.)*
- **Vite + WASM/worker decoders (Draco/KTX2/Basis)** lazy-load workers + `.wasm`. If any GLB uses them: `optimizeDeps.exclude` the decoders, self-host the `.wasm` (not CDN). KTX2 is a separate scope `@babylonjs/ktx2decoder`.
- **No first-party Babylon Vite starter** — only community templates (`eldinor/bp800` = Babylon 8/Vite 6/Havok, `paganaye/babylonjs-vite-boilerplate`); they pin Vite 6, you'd bump to 7.
- **`--openssl-legacy-provider` disappears** with the toolchain swap (webpack-4-on-modern-Node artifact).
- **NullEngine server side is unaffected by the renderer swap**, but on the ES6 migration import only geometry/collision side-effects into Node — barrel imports drag the full engine into the Node bundle and slow tsx startup (aligns with §5).
- **WebGPU is opt-in, not free** even at 9.x — Safari/Firefox stable WebGPU still catching up; snapshot rendering WebGPU-only w/ caveats; WebXR unsupported under WebGPU. **Keep WebGL2 the production default; don't let `EngineFactory.CreateAsync` silently pick WebGPU without QA.**
- **Size-analysis tooling:** add `rollup-plugin-visualizer` to confirm tree-shaking actually worked post-migration.
- **CI/build images:** Vite 7 hard-fails on Node 18 (EOL-dropped) — verify build images, not just the dev machine.

### Could NOT verify online
- A breaking change to the **default ImageProcessing tonemapping operator** (still appears opt-in) — verify visually.
- A change to **`scene.activeCameras`** semantics across 4→9 — verify at runtime.
- The exact publish date of `9.17.0` (only that it's current `latest`).

### Primary sources
Babylon 9.0: `blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/` · 8.0: `forum.babylonjs.com/t/57452` · npm: `registry.npmjs.org/@babylonjs/core`, `/babylonjs`, `unpkg.com/@babylonjs/core/package.json` · Breaking changes: `doc.babylonjs.com/breaking-changes/` · What's New: `doc.babylonjs.com/whats-new` · ES6/tree-shaking: `doc.babylonjs.com/setup/frameworkPackages/es6Support` · Loaders/new ImportMeshAsync: `doc.babylonjs.com/features/featuresDeepDive/importers/loadingFileTypes`, `forum.babylonjs.com/t/56566` · WebGPU: `doc.babylonjs.com/setup/support/webGPU`(+`/webGPUStatus`) · PBR/sRGB drift: `forum.babylonjs.com/t/62305` · Vite 7: `vite.dev/blog/announcing-vite7` · Vite+Babylon: `doc.babylonjs.com/setup/templates/repos/viteTS/`, `forum.babylonjs.com/t/51711` · KTX2/WASM: `doc.babylonjs.com/features/featuresDeepDive/materials/using/ktx2Compression`


---

## 9. Consolidated risk register & reconciled conflicts

### Cross-audit conflicts, reconciled
Two knowledge-based audits (§2, §7) made a claim the live-web check (§8) corrected. Resolutions:

1. **"WebGL1 was dropped in Babylon 8."** (§2, §7 assumed this.) **FALSE per §8** — Babylon docs say WebGL is maintained side-by-side with WebGPU. **Consequence:** the `#ifdef WEBGL2` string the shader-patch searches for is *more* likely to still exist than §7 assumed, so the "guard text vanished → silent no-op" failure mode is less likely — but the required action is unchanged: **verify the patch against the actual 9.x `shadowsFragmentFunctions` source and smoke-test shadows under SwiftShader.** Do not assume it's dead; do not assume it works.
2. **"Custom GLSL is WGSL-only / inert under WebGPU."** (§7.) **Partially corrected by §8** — custom GLSL *is* still supported under WebGPU (no forced rewrite). The nuance holds, though: the app's *specific* patch mutates the GLSL includes store, which the WebGPU WGSL pipeline doesn't read, so that patch remains irrelevant on the WebGPU path. Net: on WebGPU, skip the patch; general GLSL is fine.
3. **ImageProcessing default tonemapping operator change.** (§2 flagged "verify", §8 "could not confirm".) Treat as **unconfirmed → verify visually** in Phase 2, folded into the broader visual-drift QA below.

### Risk register (highest first)

| # | Risk | Where | Severity | Detector / mitigation |
|---|---|---|---|---|
| R1 | **Silent visual drift** — sRGB/gamma-buffer + material default changes shift the whole look; the game hand-tunes contrast/exposure/vignette/glow, so it *will* look different | §8; `BABYLONRenderer.js:102-112` (imageProcessing), `:444` (glow) | **High** | Side-by-side visual QA in Phase 2; expect to re-tune exposure/contrast/vignette/glow numbers. Restoration flags (`supportSRGBBuffers`, `PBRBRDFConfiguration.DEFAULT_*`) available if needed. Capture before/after screenshots via existing `shot-*.mjs`. |
| R2 | **Client/server collision desync** — Vite client and tsx server resolve different `@babylonjs/core` versions, OR register different collision side-effect sets → `moveWithCollisions`/`intersectsMesh` diverge → reconciliation snapping, hitscan disagreeing with crosshair | §5; `applyCommand.js:158` | **High** | Pin ONE exact 9.x version for both. Put the entire collision side-effect block in ONE shared module both entrypoints import. Detector: `verify-map.ts` + `verify:movement` + `verify:1v1`. |
| R3 | **Missing side-effect import → silent runtime break** — scoped imports need explicit registration; a missing one fails at runtime for that feature only (black render / no shadows / players fall through map / no meshes / `CreateBox is not a function`) | §3, §5 | **High** | The exhaustive checklist in §3/§5. Detectors: `verify:anim` (loader throws, Node), `verify:scifi`/`verify:viewmodel` (silent-zero-meshes, browser), shadows-present visual check. |
| R4 | **Collision solver math changed 4→9** — even in lockstep, resting-Y/wall-slide/jump-pad ballistics shift vs 4.0.3-calibrated tuning (`mapMesh.js` spawns/killY, `JUMP_PADS`, movement consts) | §5; `applyCommand.js` jump-pad block, `mapMesh.js` | **Med-High** | Re-run `verify-map.ts`, `_sweep-pad.ts`, `verify-meshmap.ts` post-bump; re-tune spawns/killY/launch vectors before shipping. |
| R5 | **`ImportMeshAsync` deprecation + loader registration** — 9 client + 1 server call sites; loaders now register differently; if registration fails, ALL mesh loading rejects | §2, §3, §5; 9 sites + `GameInstance.js:613` | **Med-High** | Old static still works in 9 (warnings) → can defer the signature rewrite. But loader *registration* (`@babylonjs/loaders/glTF` + `/OBJ`) is mandatory day one. Detector: `verify:anim`. |
| R6 | **`window.BABYLON` disappears** under scoped imports → 3 in-page harness scripts break (`probe-anim.mjs:97`, `verify-fire-attachment.mjs:92`, `verify-helmet-anims.mjs:27`) | §3, §6 | **Med** | Dev-only barrel assigns `window.BABYLON` from the curated re-exports (NOT `import * as from '@babylonjs/core'` — that un-shakes the bundle). Already partly unreliable (`verify-scifi-skin.mjs:90` works around it). |
| R7 | **patch-package + Vite/scoped-import collision** — the current GLSL patch lives near `BABYLON.Effect`/ShadersStore; under ES6 the node_modules paths change, and Vite's esbuild pre-bundle can serve a cached copy that bypasses the patch | §8; `BABYLONRenderer.js:55-64` | **Med** | **Replace the node_modules string-patch with Babylon's supported shader-store injection API** (or delete if obsolete per R-shader). If any Babylon patch is kept, `optimizeDeps.exclude` it or clear `.vite` cache. |
| R8 | **`public/` collision in Vite** — `public/` is web root + hand-authored shell + build output at once; Vite's default publicDir would copy/empty the live web root | §4 | **Med** | `publicDir: false` + `build.emptyOutDir: false` + `outDir: public/js`. Non-negotiable config. |
| R9 | **nengi server-transport leaks into client bundle** — Vite doesn't polyfill Node built-ins; if nengi's server path (`ws`/`@clusterws/cws` → `net`/`tls`) reaches the client build, the browser build breaks | §5 | **Med** | Verify nengi resolves a browser-safe entry; if not, alias `ws`/`@clusterws/cws` to an empty stub in the client Vite config. Keep the nengi ESM patch (Vite prerequisite). |
| R10 | **Shader-store patch is stale** — targets a 4.x-era internal GLSL include; may be a silent no-op or a compile break on 9.x strict drivers | §2, §7; `BABYLONRenderer.js:55-64` | **Med** | Grep 9.x `shadowsFragmentFunctions` for `sampler2DShadow`+precision. Delete if upstream-handled; else re-derive anchor. SwiftShader smoke-test (the existing headless harness is the exact env). |
| R11 | **`process.env.NODE_ENV` not shimmed by Vite** — `Simulator.js:185` throws `ReferenceError: process is not defined` | §4 | **Low-Med** | `define: { 'process.env.NODE_ENV': … }` in vite.config, or change the one line to `import.meta.env.PROD`. |
| R12 | **Instances now created with a parent (8.0 change)** — could shift viewmodel/mesh hierarchy | §8; `arenaDressing.js:171` | **Low-Med** | Verify arena-dressing instance transforms + viewmodel hierarchy unchanged. Detector: `verify:scifi`, `verify:viewmodel`. |
| R13 | **Harness port/URL contract** — scripts hardcode `:8080` (and some `:8081`/`:8180`) | §6 | **Low** | Pin Vite dev to `:8080`. For `:8081`/`:8180` scripts, serve those instances or update the scripts. |
| R14 | **Bundle gets BIGGER if you stop at UMD 9.x** (~4–5 MiB) | §3 | Low (avoidable) | UMD is only an intermediate checkpoint; the scoped rewrite (Phase 3) is what shrinks it. Validate with `rollup-plugin-visualizer`. |
| R15 | **WebGPU mid-frame depth clear + effect-layer glow** — uncertain on WebGPU | §7; `BABYLONRenderer.js:130`, `:444` | Deferred (Phase 4 only) | Keep WebGL2 the default; WebGPU behind a flag with fallback. Test the depth clear first. |

### Open questions for the executor
- Confirm the exact 9.x `latest` at execution time and pin it (client == server).
- Does any weapon GLB use Draco/KTX2 compression? (Changes Vite wasm/worker config + decoder self-hosting.) Grep the GLBs / check the loader logs.
- Should the shader-store patch be **deleted** or **reworked**? Decide after grepping 9.x `shadowsFragmentFunctions`.
- Keep hand-authored `index.html` + fixed output name (Option B, recommended) vs let Vite own it (Option A)? Doc assumes Option B.
- Is `AnimPlayground.js` (dev-only) bundled into prod? Excluding it drops the ArcRotateCamera input side-effects and shrinks the bundle.


---

## 10. Execution order for the next engineer

Concrete, ordered steps. Each phase is independently shippable and must pass its §6 checklist gate before the next. Work on a branch; keep the current webpack build runnable until Phase 1 is proven.

### Pre-flight (before any code change)
0. **⭐ DAY-1 SPIKE (do this FIRST — per §11 consult, the #1 blindspot): boot Babylon 9 `NullEngine` headless under Node.** Write a throwaway script that imports the server netcode (`common/applyCommand.js` path) and stands up a Babylon 9 `NullEngine` scene. Babylon 5+ modules may touch `window`/`document`/`navigator` at init → `ReferenceError` under Node; plus ESM/CJS resolution pain for `common/` importing Babylon. **If this won't boot/resolve, the migration is blocked — solve it before touching the client.** Also stand up the millimeter **collision-regression harness** now: record `(x,y,z)` after a fixed input sequence (jump / walk-into-wall / jump-pad) on 4.0.3 as the golden baseline, so Phase 2 can diff against it (R2/R4).
1. `npm view @babylonjs/core version` → note the current 9.x `latest`; **pin that exact version** for the whole migration (client == server, R2).
2. Grep the weapon GLBs / watch loader logs for `KHR_draco_mesh_compression` / KTX2 (decides wasm/worker config, R-open-Q).
3. Capture a **visual baseline**: run `shot-map.mjs`, `shot-visage.mjs`, `verify:fx`, `verify:viewmodel`, `verify:scifi` on the current build; archive screenshots for the R1 side-by-side.
4. Snapshot backups (the perf pass used `backups/perf-<TS>/`; do the same per phase).

### Phase 1 — Vite, still Babylon 4.0.3 (prove the toolchain)
5. Add `vite@^7`; write `vite.config.js` per §4 (Option B: `root` dev=`public/`, `publicDir:false`, `outDir:public/js`, `emptyOutDir:false`, fixed `app-v0.0.1.js`, iife, the `transformIndexHtml` dev-source plugin, `optimizeDeps.include:['babylonjs','babylonjs-loaders']`, `define` for `process.env.NODE_ENV`).
6. Rewrite `package.json` scripts (§4): `client:"vite"`, `build:"vite build && node scripts/stamp-build.mjs"`, add `preview`; remove `cross-env`/webpack devDeps; keep `tsx`/`npm-run-all`/`patch-package`.
7. Verify nengi bundles for the browser (R9); alias `ws`/`@clusterws/cws` to a stub if the server transport leaks in.
8. `stamp-build.mjs` unchanged under Option B — confirm its regex still matches `app-v0.0.1.js`.
9. **Gate:** §6 Phase 1 (netcode canary `npm run verify`, then movement/1v1/bots). Then Phase 2 checklist renderer scripts to confirm no visual/behavior change from the bundler swap alone. Ship if desired.

### Phase 2 — Babylon 9.x on the UMD package (modern engine, minimal churn)
10. `package.json`: `babylonjs`/`babylonjs-loaders` → the pinned `^9`. `npm i`. Keep every `import * as BABYLON`.
11. **Shader-store patch (R10):** grep 9.x `shadowsFragmentFunctions` for `sampler2DShadow`+precision. **Delete the `BABYLONRenderer.js:55-64` block if upstream-handled**; else rework against the real 9.x source. Do NOT leave it as an unverified string-match.
12. `PhotoDome` (§2 R): replace `scene.getMeshByName('sky_mesh')` (`BABYLONRenderer.js:226-229`) with the public `this.skydome.mesh` handle.
13. Leave `SceneLoader.ImportMeshAsync` as-is for now (works with warnings, R5) — defer the signature swap to Phase 3 or later.
14. **Re-tune pass (R1, R4):** run the full renderer + physics checklist; do side-by-side visual QA vs the Phase-0 baseline; re-tune exposure/contrast/vignette/glow (`BABYLONRenderer.js:102-112,:444`) and re-run `verify-map.ts`/`_sweep-pad.ts` and re-tune spawns/killY/jump-pad vectors if collision shifted.
15. **Gate:** entire §6 checklist (Phase 0 offline + Phase 1 sim + Phase 2 renderer). This is the big visual/behavioral gate. Ship 9.x on UMD.

### Phase 3 — scoped `@babylonjs/core` imports + tree-shaking (the bundle win)
16. Swap deps: remove `babylonjs`/`babylonjs-loaders`, add pinned `@babylonjs/core`+`@babylonjs/loaders` (§3). Confirm `package-lock.json` resolves a **single** `@babylonjs/core` (R2).
17. Author **two barrels** (§3, §5): `client/babylon.js` (full render feature set) and a slim `common/babylon.node.js` (nullEngine + collisionCoordinator + Culling/ray + box/sphere builders + OBJ loader + math + meshes — NO render-only modules). Include the **exhaustive side-effect imports** from §3/§5; put `Materials/effect` first (before materials). Assign `window.BABYLON` from the curated re-exports (R6).
18. Re-point all 23 files' imports from `'babylonjs'`/`'babylonjs-loaders'` to the appropriate barrel (client files → client barrel; `common`/`server`/scripts → node barrel; §3 table). Convert `Projectile/Grenade/MegaHealthPickup` to named imports so material modules drop from the Node build (§5). Convert `require('babylonjs')` scripts to ESM `import`.
19. Replace the shader injection (if kept) with Babylon's supported shader-store API rather than a node_modules patch (R7); `optimizeDeps.exclude` any still-patched Babylon package.
20. Ensure the project `package.json` does NOT set `"sideEffects": false` (or whitelists the barrels) so the bare side-effect imports survive minification (R3, §8).
21. Add `rollup-plugin-visualizer`; confirm the bundle actually shrank toward ~1.4–1.8 MiB and that PBR/GUI/physics/XR/etc. are gone.
22. Fix the 3 in-page `window.BABYLON` harness scripts (R6) — either the barrel global or rewrite them to reach math via `gameClient`.
23. **Gate:** FULL §6 checklist, with extra attention to the silent-break detectors — `verify:anim` (loader), `verify:scifi`/`verify:viewmodel` (zero-meshes), shadows-present, players-don't-fall-through (`verify:movement`/`verify-map.ts`). Any single missing side-effect import surfaces here. Ship the tree-shaken build.

### Phase 4 (optional, later) — WebGPU opt-in
24. Restructure boot to the async factory (`BABYLONRenderer.create()` + `await initAsync()`, cascading async `Simulator`/`GameClient` factories, gated RAF in `clientMain.js`); fix `window.gameClient` timing for the harnesses (§7).
25. Runtime-detect WebGPU with **WebGL2 as the default/fallback**; put both behind a `?webgpu`/stored flag. Do NOT let `EngineFactory.CreateAsync` silently pick WebGPU in prod (R15, §8).
26. Test in this order: mid-frame depth clear (`BABYLONRenderer.js:130`, viewmodel z-clip) → GlowLayer selective bloom → shadow fidelity → image-processing parity → forceCompilation first-shot warm. Skip snapshot rendering (scene mutates every frame).

### Deploy (each shippable phase)
27. Follow the existing EchoPrime→zec-sol flow (build → stamp-build → rsync → pm2 restart → verify app.js size + `probe-live.mjs`). Confirm `window.__BUILD_ID__` present and GLB/mp3 fetches carry `?v=<id>` (§6). Because the client is bundled and the server runs `common/` under tsx, **rebuild the client AND restart the server together** on any phase that touches `common/` or the pinned Babylon version (R2).

### One-glance summary
Phase 1 = bundler only (low risk). Phase 2 = engine bump + the visual re-tune (medium; the look changes). Phase 3 = scoped imports + tree-shaking (the payoff + the silent-break minefield). Phase 4 = WebGPU (optional). Gates are the §6 verify scripts; the three things that will actually bite are **visual drift (R1)**, **collision desync (R2/R4)**, and **missing side-effect imports (R3)**.


---

## 11. Senior game-programmer consult (Gemini 3.5 Flash, 2026-07-19)

External gut-check from a "senior game programmer / engine-migration veteran" persona. It broadly endorsed the plan but pushed back hard in three places. Verbatim script: `scripts/gemini-consult-migration.mjs`.

### Where it AGREES with this doc
- **Phase 1 (Vite on old Babylon 4.0.3) first — yes.** Isolate bundler bugs from engine bugs; if both change at once and it black-screens you can't tell which. Ship it to prod first. (Trap it flagged: Vite 7 is ESM-only; the 2019 UMD `babylonjs` may need `@rollup/plugin-commonjs` or `optimizeDeps` include/exclude tuning — matches §4.)
- **Phase 2 (Babylon 9 on UMD) is the REAL milestone and is fully shippable** — do not treat it as throwaway intermediate.
- **WebGPU (Phase 4): kill it.** Static-ish scene + frozen shadows = zero player-visible win; WebGPU helps high draw-call CPU overhead, which isn't the bottleneck here. `initAsync` also risks a boot/WebSocket race. Keep WebGL2 — "bulletproof." (Matches §7's "WebGL2 first"; the consult is more absolute — treat Phase 4 as parked, not planned.)

### Where it CHANGES / sharpens the plan (act on these)

**A. Phase 3 (tree-shaking) — it says NOT worth it for a live game.** The 2.62 MiB → ~1.5 MiB win is **uncompressed**; over the wire with gzip/brotli it's roughly **~600 KB → ~350 KB — a ~250 KB saving** — while a single map GLTF or weapon texture is 5–20 MiB. Risking a whole class of *silent* runtime breaks (fall-through-floor, no-loader, no-shadows) to shave 250 KB off a desktop FPS is a bad trade. **Recommendation: ship UMD 9.x (Phase 2) and STOP there** unless analytics show JS-download drop-off on mobile, or you have 100% automated coverage of every subsystem. → *This directly tempers §0/§3's enthusiasm; the bundle number in isolation oversold it. Treat Phase 3 as conditional, gated on real load-time data, not a default.*

**B. Q2 determinism — it pushes option (c): rip collision OUT of Babylon.** Leaning on a general-purpose engine's `moveWithCollisions` for authoritative deterministic netcode is called "a fundamental architectural liability" — 5 majors of epsilon/slide/gravity optimizations mean drift is likely, causing reconciliation snapping and missed jump-pad landings. Its long-term fix: a **pure-JS capsule-vs-AABB (or AABB-vs-AABB) deterministic solver** shared client+server, with Babylon used ONLY to render at the computed position — "100% deterministic, 10× faster, immune to future engine upgrades." → *Bigger than a migration task, but the right north star. Minimum viable version for THIS migration: keep Babylon collision for now BUT add a millimeter-level position-regression gate (below) so the bump can't silently change gameplay; schedule the custom solver as a follow-up. This elevates §5/§9-R2+R4 from "re-tune" to "consider owning the sim."*

**C. Q6 blindspot — the #1 risk is the server-side NullEngine boot on Babylon 9, not the client.** Babylon 5+ modularized heavily; 9.x modules may touch `window`/`document`/`navigator` at init and throw `ReferenceError: window is not defined` under Node, plus ESM(Vite)/CJS(Node) resolution pain for `common/` importing Babylon. → **Day-1 spike (do before touching the client):** write a bare Node script that imports the server netcode and boots the Babylon 9 `NullEngine` headless. If that won't boot/resolve, the migration is dead in the water — solve it first. *This sharpens §5 into a concrete first action; added to §10 pre-flight.*

**D. Q4 visual drift — concrete method, not eyeballing.** Build a static "calibration scene" (viewmodel + primary wall/floor materials + one shadow-casting light + GlowLayer), capture a 4.0.3 golden screenshot, then **pixel-diff (`pixelmatch`) 4.x vs 9.x from the headless runner** and adjust global ImageProcessing until the diff is minimal. Try legacy "cheat-code" flags first before re-authoring values: `engine.useExactSrgbConversions = false`, `scene.imageProcessingConfiguration.colorCurvesEnabled = false`, `light.falloffType = Light.FALLOFF_STANDARD`. → *Folds into §9-R1; the existing `shot-*.mjs` scripts already produce the screenshots — just add `pixelmatch`.*

### Net effect on the plan
The consult **validates the phasing** but **downgrades two of its later phases**: Phase 3 becomes conditional (ship on UMD unless data justifies the churn), Phase 4 is parked. It **upgrades two risks to first-actions**: the Day-1 Node/NullEngine-9 boot spike (§10 pre-flight), and a millimeter-level collision-position regression gate before/after the bump (§9-R2/R4) — with "own the collision sim" as the strategic follow-up. Visual drift gets a concrete golden-image + legacy-flag workflow.


---

## 12. Next project (AFTER this migration)

The §11 consult's "own the collision sim" recommendation is now a scoped follow-up spec: **`upgrade/deterministic-collision-sim.md`** — replace Babylon's `moveWithCollisions` with a purpose-built deterministic collide-and-slide solver so gameplay physics stops depending on the renderer version. **It is explicitly sequenced AFTER this migration ships**, and it reuses this migration's collision-regression gate as its test fixture. Do the migration first.

---
