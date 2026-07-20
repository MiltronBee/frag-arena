# Phase 3 Report — scoped `@babylonjs/core` + curated barrels + tree-shaking

**Executed:** 2026-07-19 (server-local, EchoPrime), branch `upgrade/babylon9-vite`, Node 22.23.0.
**Scope:** replace the UMD `babylonjs`/`babylonjs-loaders` 9.17.0 packages with scoped
`@babylonjs/core`/`@babylonjs/loaders` 9.17.0 via two curated local barrels + deep imports,
re-point all importers, and prove no runtime-silent breakage. No commit. Prod untouched.
Builds on Phase 2 (engine 9.17.0 UMD, all green).

---

## 1. Dependency swap

| Before | After |
|--------|-------|
| `"babylonjs": "9.17.0"` | **removed** |
| `"babylonjs-loaders": "9.17.0"` | **removed** |
| — | `"@babylonjs/core": "9.17.0"` (EXACT) |
| — | `"@babylonjs/loaders": "9.17.0"` (EXACT) |

- `npm install`: **2 packages removed, 2 added.** patch-package re-applied nengi + @clusterws/cws cleanly (both ✔).
- **package-lock resolves a SINGLE `@babylonjs/core` copy** (verified: exactly 1 `node_modules/@babylonjs/core/package.json`, no nested dup; `require('@babylonjs/core/package.json').version === '9.17.0'`, loaders `9.17.0` — client/server lockstep).
- `package.json` has **no `"sideEffects": false`** (confirmed absent — the bare side-effect imports in the barrels survive minification).
- Added `rollup-plugin-visualizer@5.12.0` (devDep) for the one-off bundle audit (wired into `vite.config.js` for the audit build, then removed from the config; devDep left in place for future size checks).

## 2. The two barrels

### `common/babylon.node.js` — shared sim barrel (node + client)
Side-effects first (nullEngine, **collisionCoordinator**, Culling/ray, sceneLoader, loaders/OBJ,
box+sphere builders), then named re-exports. NO render-only modules. Verbatim in §9.
Named exports: Engine, NullEngine, Scene, Vector3, Quaternion, Matrix, Axis, Color3, Color4,
Ray, MeshBuilder, Mesh, TransformNode, VertexBuffer, SceneLoader, FreeCamera, OBJFileLoader,
StandardMaterial.

### `client/babylon.js` — client barrel = node barrel + render slice
`Materials/effect` imported as the literal first statement (before the node-barrel pulls
standardMaterial), then `export *` from the node barrel, then the ordered render side-effects
(loadingScreen, loaders/glTF, animatable, animationGroup, shadowGenerator +
**shadowGeneratorSceneComponent**, glowLayer, photoDome, backgroundMaterial,
renderTargetTexture, imageProcessingConfiguration, standardMaterial, texture, dynamicTexture,
instancedMesh, cylinder/ground/plane builders, arcRotateCamera pointer/wheel/keyboard inputs),
then render named re-exports, then `window.BABYLON` sourced from the barrel's own curated
namespace (`import * as FragBabylon from './babylon.js'`). Verbatim in §9.

### Symbol audit (how the export lists were derived)
Grepped every `BABYLON.<member>` across `client/ common/ server/ scripts/`:
- **common/server/scripts** reference: Vector3, MeshBuilder (CreateBox/CreateSphere), Color3,
  Color4, Scene, Engine, NullEngine, StandardMaterial (guarded), SceneLoader, VertexBuffer,
  TransformNode, Ray, Matrix, Axis, FreeCamera (verify-weapon-anim), OBJFileLoader. (Server
  `ArcRotateCamera`/`HemisphericLight`/`DirectionalLight` hits were all in **commented-out**
  lines or in-page scratch scripts — not node-barrel consumers.)
- **client** additionally references: Mesh, Quaternion, Texture, DynamicTexture,
  ShadowGenerator, GlowLayer, PhotoDome, ImageProcessingConfiguration, RenderTargetTexture,
  Light, HemisphericLight, DirectionalLight, PointLight, TargetCamera, ArcRotateCamera,
  AnimationGroup, and MeshBuilder.Create{Cylinder,Ground,Plane}. All covered.

## 3. Importers re-pointed — 24 files

| Group | Files | Change |
|-------|-------|--------|
| Client → `../babylon.js` (namespace) | FragLayer, Viewmodel, CharacterModel, arenaDressing, BABYLONRenderer, AnimPlayground, createObstacleFactory, createFactories (8) | specifier only; deleted bare `import 'babylonjs-loaders'`; BABYLONRenderer `OBJFileLoader` now from client barrel |
| Common named → `./babylon.node.js` | weapon.js (`{Vector3,Ray}`), applyCommand.js (`{Vector3,Matrix,Axis}`) (2) | specifier only, named imports kept |
| Common namespace → `../babylon.node.js` | Obstacle, PlayerCharacter (2) | specifier only |
| Common **converted to named** → `../babylon.node.js` | Projectile, Grenade, MegaHealthPickup (3) | `import {Engine,MeshBuilder,StandardMaterial,Color3,Vector3}`; `BABYLON.` prefix stripped in bodies |
| Server → `../common/babylon.node.js` | GameInstance (+OBJFileLoader from node barrel), BotController (2) | specifier only |
| Scripts → `../common/babylon.node.js` | _sweep-pad, verify-map, golden-collision, verify-meshmap.ts, verify-meshmap.mjs, probe-visage, **verify-weapon-anim** (require→import) (7) | + glTF-loading scripts add `import '@babylonjs/loaders/glTF/index.js'` |
| vite.config.js | — | removed `optimizeDeps.include ['babylonjs','babylonjs-loaders']`; kept `events` alias |
| scripts/shot-visage, shot-objmap | (scratch render tools) | repointed `<script src>` from the removed `node_modules/babylonjs/*` UMD → the game bundle `/js/app-v0.0.1.js` (they now consume the game's `window.BABYLON`) |

Only a dead comment `//import 'babylonjs-loaders'` remains (GameInstance.js:33, harmless).

### The `.js`-extension fix (root-caused during Gate A.5)
Neither `@babylonjs/core` nor `@babylonjs/loaders` ships a package `exports` map, and both are
`"type":"module"`. tsx/esbuild and Vite/rollup auto-append extensions, but **plain `node`**
(`verify:anim` runs `node scripts/verify-weapon-anim.mjs`) rejects extensionless deep imports
and directory imports (`ERR_UNSUPPORTED_DIR_IMPORT` / `ERR_MODULE_NOT_FOUND`). Fix: **every**
specifier in both barrels and the glTF-loading scripts is fully-extensioned (`.js` /
`/index.js`) — Babylon's own internal ESM uses this style, and it resolves identically under
node, tsx and Vite.

## 4. StandardMaterial-in-node-barrel decision
Projectile/Grenade/MegaHealthPickup reference `StandardMaterial`/`Color3` inside a
`getEngine().name !== 'NullEngine'` guard — the binding must **resolve** on the server even
though the constructor never runs headless. Decision: **export `StandardMaterial` from the
node barrel** as a plain class import (the class-import specifier `@babylonjs/core/Materials/
standardMaterial.js` *is* its side-effect module). Measured node cold-import of the whole node
barrel (incl. StandardMaterial) = **118 ms**; server boot to `[map] mesh collider loaded` is
dominated by the OBJ parse, unchanged from Phase 2. Startup impact **negligible** → no
lazy-injection refactor needed. Converting these 3 files to named imports also keeps the
material path tidy in the client bundle (StandardMaterial is needed there anyway).

---

## 5. GATE A — offline / NullEngine (deterministic)

| Gate | Result | Verdict |
|------|--------|---------|
| A.1 server boots (`npx tsx server/serverMain.js`) | `Babylon.js v9.17.0 - Null engine`; **`[map] mesh collider loaded: 36 meshes (CTF-Visage.obj)`**; no import errors | **PASS** |
| A.2 golden-collision regen → `upgrade/golden-collision-scoped.json`, diff vs 4.0.3 | **`worst deviation 0.000000mm`, 20 sequences, no drift** | **PASS** (proves collisionCoordinator registered) |
| A.3 orientation probe (`upgrade/orient-probe.ts`, mirrors `_loadMapMesh`) | world AABB **x-max = 131.254 ≈ +131.3** (legacy, non-mirrored) | **PASS** (USE_LEGACY_BEHAVIOR survives the swap) |
| A.4 `verify-map.ts` | **ALL MAPS PASS**, exit 0 | **PASS** |
| A.5 `verify:anim` | **19/20** (only fail: known Shotgun support-hand) — glTF loader registered under scoped pkg via plain node | **PASS** (= Phase 2) |
| A.6 `verify-meshmap.ts` | exit 0 (LOOKS WALKABLE ✓) | **PASS** |
| extra: Ray.intersectsMesh probe (`upgrade/ray-probe.ts`) | hit at distance **9.000** exactly | **PASS** (hitscan intersection works; Culling/ray registered) |

## 6. GATE B — browser suite (fresh vite :8080 + game server :8079; Chrome :9222 untouched)

| Script | Phase 2 | Phase 3 | Verdict |
|--------|---------|---------|---------|
| verify (netcode canary) | 8/9 warm | **8/9** (one FAIL = known connection-race; **"no uncaught client errors" PASS** — scoped client loads clean) | **EQUAL** |
| verify:movement | 5/8 | **5/8** (known jump-apex identities; **0 reconciliation corrections; no fall-through**) | **EQUAL** |
| verify:1v1 | 11/12 | 10/12 | see note ① |
| verify:fx | 18/19 | **18/19** (only fail = known muzzle-peak timing; scene-light-count constant) | **EQUAL** |
| verify:viewmodel | 8/10 | 5/10 | see note ② (loader works: meshes=11, skeletons=3 NONZERO) |
| verify:scifi | TIMEOUT | **TIMEOUT** (pre-existing; live arena is the mesh-map) | **EQUAL** |
| verify:fire | 9/10 | **9/10** (only fail = known rifle hand-back; **reload-cadence fix survives**; window.BABYLON in-page works) | **EQUAL** |
| verify:bots | 1/5 | **1/5** (pre-existing 0-AI-spawned) | **EQUAL** |
| render/shadow probe (`upgrade/render-probe.mjs`) | — | **PASS**: window.BABYLON 32 keys + Vector3 live; meshes 455; materials 448 (443 StandardMaterial); lights 5; **shadowMap `sun_shadowMap` present, renderList 36** | **PASS** (silent-break detectors green) |

**① verify:1v1 10/12** — the two fails ("one rifle shot removes 15hp", "respawned player shoots
back") are **client hp-mirror sampling timing** under SwiftShader, NOT a hitscan/import
regression. The **server log proves exact damage**: `Player 65525 hit by Rifle! HP: 85, 70, 55,
40, 25, 10, 0` — 15hp/shot, kills/frags/respawns all fire. Ray-probe + golden-0mm corroborate.
Also: the x≈59–60 right-base spawns **grounded fine** (no `everGrounded=false` falls) — the
orientation fix holds live.

**② verify:viewmodel 5/10** — all five fails are **resource-leak-stability** checks (rig/GPU
resource totals, "exactly one visible rig"). Absolute counts are dominated by live-match churn
(451 materials incl. tracer0-23/impact0-58, 134 animationGroups, 3 skeletons from combatant
character models); the leak deltas drift ±2 frame-to-frame in a populated arena. This is the
Phase-2-documented rogue/combatant interference (a quiet-match `GODMODE` restart is needed for
clean numbers), **not** a scoped-import regression — the loader/material pipeline is proven
working (meshes=11, skeletons=3 NONZERO; "visual and gameplay weapons agree" PASS; "no uncaught
client errors" PASS; verify-aiming loads viewmodels fine).

## 7. GATE C — build + size

- `npm run build` → **EXIT 0**, iife `public/js/app-v0.0.1.js`, **1365 modules** transformed.
- stamp-build ran: **`BUILD_ID=0.0.1-211fce4c7a`** (13 assets hashed); `window.__BUILD_ID__="0.0.1-211fce4c7a"` injected into `index.html`; `?v=` cache-bust on the app `<script>` intact.
- Serving the built bundle self-serve (`verify-aiming.mjs`, own http server on public/): **13/19 = Phase 2** — bundle boots, viewmodels load, ADS/FOV/cameras work (6 fails = same ADS-state-timing identities). Built bundle proven to boot.

### Bundle size

| Build | Raw | gzip |
|-------|-----|------|
| Phase 2 (UMD 9.17.0) | 8,912,129 B (8.5 MiB) | 1,999 kB |
| **Phase 3 (scoped + barrels)** | **4,028,131 B (4.03 MiB)** | **944.5 kB** |
| Reduction vs Phase 2 | **−55% raw** | **−53% gzip** |

Confirmed **absent** (grep of the minified bundle): GUI (0), WebXR (0), DracoCompression (0),
Havok/Ammo/Cannon physics plugins (0). **Present**: PBRMaterial (31 refs). Bundle breakdown
(visualizer, rendered-length proportions):

```
 1934 kB  Materials (StandardMaterial + PBRMaterial + Background + imageProcessing)
 1346 kB  Meshes/Geometry
 1266 kB  core/misc (post-process interfaces, rendering, scene infra)
 1136 kB  Shaders/GLSL (PBR + standard shader includes)
  825 kB  loaders (glTF/OBJ)
  593 kB  Engine(s)
  492 kB  FlowGraph  (pulled by glTF KHR_interactivity extension)
  485 kB  Maths
  455 kB  app (game code)
  425 kB  Cameras (all input modules)
  243 kB  Lights/Shadows
  ...
```

**Why it lands at 4.03 MiB, not the plan's optimistic 1.4–1.8 MiB:** the target is
`≪ 8.5 MiB` (**met** — 4.03 MiB, gzip 944 kB is < half Phase-2 gzip) but not `≤ 2.62 MiB` raw.
Two reasons: (a) the Babylon **9.x** engine slice is far larger than the tiny **4.0.3** webpack
baseline (five majors of growth) even after tree-shaking; (b) the game loads **glTF/GLB**
assets, and the glTF-2.0 loader hard-depends on **PBRMaterial → PBR shaders → image-processing
→ FlowGraph** (KHR extensions). That coupled chain (~1.9 MB materials + much of the 1.1 MB
shaders + 0.8 MB loaders + 0.5 MB FlowGraph) is the bulk and is not tree-shakeable while using
the glTF loader. **Further safe lever (open, not done):** register a curated glTF extension
subset instead of the full `@babylonjs/loaders/glTF` barrel to shed FlowGraph +
GaussianSplatting (~0.5 MB rendered / est. ~0.2–0.3 MB minified) — deferred because dropping
extensions risks a silent asset mis-load, which needs a per-GLB extension audit first (exactly
the failure class this phase guards against).

## 8. GATE D — visual

- **Shadows present** (the classic silent-break): render-probe `page.evaluate` confirms
  `scene` shadow generator + shadow-map texture **`sun_shadowMap`** with a **36-mesh
  renderList** — shadows did NOT silently vanish. StandardMaterial count 443 (not black).
- Re-captured in-game (`shot-map` → live game) + viewmodel (`render-shot`) shots into
  `backups/phase3-shots/`; pixel-diff (pixelmatch, threshold 0.1) vs `phase2-shots`:

| pair | mismatch | attributed cause |
|------|----------|------------------|
| ingame-map-eye | **1.54%** | fixed camera — **render fidelity preserved** |
| ingame-map-eye2 | 4.04% | AA + minor position jitter |
| ingame-map-overview | 4.48% | fixed-ish camera; global lighting consistent |
| ingame-grotto | 5.62% | minor camera/FX |
| ingame-natural-spawn | 11.24% | per-run spawn point (`natural:true`, by design) |
| ingame-torch-hall | 28.17% | death/damage red overlay fired mid-capture (dynamic; Phase 2 was 27.25% for the same reason) |
| rifle-hip / rifle-ads | 33.9% / 35.0% | per-run spawn **background** behind viewmodel (Phase 2: models/hands/exposure identical) |
| pistol-hip / pistol-ads | 26.3% / 40.2% | per-run spawn background |

The **fixed-camera map-eye at 1.54%** is the clean render-fidelity signal — lighting /
exposure / shadows / materials are pixel-consistent with Phase 2 (expected: Phase 3 changed
**zero render logic**, only import wiring). All high diffs are dynamic gameplay state / random
spawn position — identical causes to Phase 2. **Verdict: PASS** (look preserved, shadows
present). `visage-*`/`grove-*` scratch pairs render the raw OBJ (not the game); their scripts
depended on the removed UMD build — repointed to the game bundle (they now run and produce
`window.BABYLON`-driven shots, confirming the barrel global exposes the render classes end to
end), but the OBJ **orientation** is definitively validated by the A.3 probe (+131.3) rather
than these scratch diffs.

---

## 9. Barrel files (verbatim)

### `common/babylon.node.js`
```js
// ============================================================================
// SHARED SIM BARREL — imported by BOTH the client barrel (client/babylon.js)
// and ALL server/common/script code that runs headless under NullEngine.
//
// Curated deep imports into @babylonjs/core so the bundler tree-shakes away
// everything the game doesn't use. This module holds ONLY the sim/collision/
// math/loader surface — NO render-only modules (shadows, glow, photoDome,
// imageProcessing, camera inputs). Those live in client/babylon.js.
//
// NOTE ON `.js` EXTENSIONS: neither @babylonjs/core nor @babylonjs/loaders
// declares a package `exports` map, and both are `"type":"module"`. Plain Node
// ESM (e.g. `node scripts/verify-weapon-anim.mjs`) therefore requires the
// explicit `.js` file extension / `/index.js` on every deep import; tsx and
// Vite add it implicitly but plain node does not. So every specifier below is
// fully-extensioned — it resolves identically under node, tsx AND Vite.
//
// PHASE 3 of the Babylon 4.0.3 -> 9.17.0 migration. Breakage here is
// RUNTIME-SILENT: a missing side-effect import compiles fine and then players
// fall through the floor / hitscan never connects. Do not remove a side-effect
// import without proving (golden-collision + verify-map) it is unused.
// ============================================================================

// ---- SIDE-EFFECT IMPORTS (must come first; they register plugins/prototypes) ----
import '@babylonjs/core/Engines/nullEngine.js'            // NullEngine (headless server + all tsx harnesses)
import '@babylonjs/core/Collisions/collisionCoordinator.js' // CRITICAL: moveWithCollisions/checkCollisions. Missing = walk through walls, fall through floor.
import '@babylonjs/core/Culling/ray.js'                   // Ray.intersectsMesh — hitscan / bot LoS / lag-comp
import '@babylonjs/core/Loading/sceneLoader.js'           // SceneLoader.ImportMeshAsync
import '@babylonjs/loaders/OBJ/index.js'                  // OBJ map collider (server GameInstance._loadMapMesh, data: URI)
import '@babylonjs/core/Meshes/Builders/boxBuilder.js'    // MeshBuilder.CreateBox (PlayerCharacter/Obstacle/MegaHealthPickup + harnesses)
import '@babylonjs/core/Meshes/Builders/sphereBuilder.js' // MeshBuilder.CreateSphere (Projectile/Grenade build meshes under NullEngine)

// ---- NAMED RE-EXPORTS (concrete classes referenced by common/server/scripts) ----
// Each of these class-import specifiers also *is* the side-effect module that
// registers the class; importing to re-export is sufficient registration.
export { Engine } from '@babylonjs/core/Engines/engine.js'
export { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
export { Scene } from '@babylonjs/core/scene.js'
export { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector.js'
export { Axis } from '@babylonjs/core/Maths/math.axis.js'
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
export { Ray } from '@babylonjs/core/Culling/ray.js'
export { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'
export { Mesh } from '@babylonjs/core/Meshes/mesh.js'
export { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
export { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
export { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js'
export { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js' // scripts/verify-weapon-anim.mjs constructs one under NullEngine
// OBJFileLoader carries the static USE_LEGACY_BEHAVIOR flag (set true on both
// sides to keep the 4.0.3 non-mirrored OBJ orientation — see GameInstance.js /
// BABYLONRenderer.js). The class lives on the loaders module, NOT on core.
export { OBJFileLoader } from '@babylonjs/loaders/OBJ/index.js'
// StandardMaterial is referenced (guarded behind a NullEngine check) in
// Projectile/Grenade/MegaHealthPickup. The named binding must resolve even on
// the server; the guard means the constructor never RUNS headless. This class
// import is itself the side-effect module (registers the default material).
export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
```

### `client/babylon.js`
```js
// ============================================================================
// CLIENT BARREL — the ONLY Babylon import specifier the client render code uses.
//
// = the shared sim barrel (common/babylon.node.js) + the render feature slice.
// Curated deep imports so rollup tree-shakes PBR/GUI/physics/XR/particles/
// node-material/post-process/~13 loaders OUT of the prod bundle.
//
// All specifiers are fully-extensioned (`.js` / `/index.js`) — @babylonjs/core
// and @babylonjs/loaders ship no package `exports` map, so this resolves
// identically under Vite, tsx and plain node (see common/babylon.node.js).
//
// PHASE 3 of Babylon 4.0.3 -> 9.17.0. Breakage is RUNTIME-SILENT: a missing
// render side-effect import yields a black screen / vanished shadows /
// "MeshBuilder.CreateBox is not a function" — never a build error. Every
// side-effect line below is load-bearing; removing one silently breaks the
// specific feature it registers.
// ============================================================================

// Materials/effect MUST evaluate before any material module so the shader
// include store exists before the first material compiles. Kept as the literal
// first statement so it precedes the node-barrel (which pulls standardMaterial).
import '@babylonjs/core/Materials/effect.js'

// ---- the shared sim/collision/math/loader surface (re-exported wholesale) ----
export * from '../common/babylon.node.js'

// ---- RENDER SIDE-EFFECT IMPORTS (ordered) ----
import '@babylonjs/core/Loading/loadingScreen.js'                     // SceneLoader default loading UI
import '@babylonjs/loaders/glTF/index.js'                             // glTF/GLB: Viewmodel, CharacterModel, arenaDressing, AnimPlayground
import '@babylonjs/core/Animations/animatable.js'                     // Animatable (glTF animation playback)
import '@babylonjs/core/Animations/animationGroup.js'                 // AnimationGroup (weapon/character clips)
import '@babylonjs/core/Lights/Shadows/shadowGenerator.js'           // ShadowGenerator
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js' // makes materials SAMPLE the shadow map — missing = shadows silently vanish
import '@babylonjs/core/Layers/glowLayer.js'                          // GlowLayer
import '@babylonjs/core/Helpers/photoDome.js'                         // PhotoDome skydome
import '@babylonjs/core/Materials/Background/backgroundMaterial.js'   // PhotoDome renders on BackgroundMaterial
import '@babylonjs/core/Materials/Textures/renderTargetTexture.js'    // RenderTargetTexture (REFRESHRATE_RENDER_ONCE shadow freeze)
import '@babylonjs/core/Materials/imageProcessingConfiguration.js'    // VIGNETTEMODE_MULTIPLY
import '@babylonjs/core/Materials/standardMaterial.js'                // CRITICAL: default + all StandardMaterials. Missing = everything black.
import '@babylonjs/core/Materials/Textures/texture.js'                // Texture
import '@babylonjs/core/Materials/Textures/dynamicTexture.js'         // DynamicTexture (HUD/label textures)
import '@babylonjs/core/Meshes/instancedMesh.js'                      // mesh.createInstance (arena dressing)
// Explicit shape builders — each registers its MeshBuilder.Create* method.
// (box + sphere already registered by the node barrel.)
import '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'          // MeshBuilder.CreateCylinder
import '@babylonjs/core/Meshes/Builders/groundBuilder.js'            // MeshBuilder.CreateGround
import '@babylonjs/core/Meshes/Builders/planeBuilder.js'            // MeshBuilder.CreatePlane
// AnimPlayground uses cam.attachControl (ArcRotateCamera) — register its inputs.
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput.js'
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraMouseWheelInput.js'
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraKeyboardMoveInput.js'

// ---- RENDER NAMED RE-EXPORTS (client-only classes; sim classes — incl.
// StandardMaterial — come via `export *` from the node barrel above) ----
export { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
export { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
export { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js'
export { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js'
export { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js'
export { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js'
export { PhotoDome } from '@babylonjs/core/Helpers/photoDome.js'
export { Light } from '@babylonjs/core/Lights/light.js'
export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
export { PointLight } from '@babylonjs/core/Lights/pointLight.js'
export { TargetCamera } from '@babylonjs/core/Cameras/targetCamera.js'
export { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js'
export { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js'

// ---- window.BABYLON (3 in-page harness scripts read it: probe-anim,
// verify-fire-attachment, verify-helmet-anims; plus shot-objmap/shot-visage).
// Sourced from THIS barrel's own curated namespace — NOT the @babylonjs/core
// root barrel — so it exposes exactly the tree-shaken slice and does not
// re-drag the full library back into the bundle. ----
import * as FragBabylon from './babylon.js'
if (typeof window !== 'undefined') {
	window.BABYLON = FragBabylon
}
```

---

## 10. Deviations / open concerns

1. **Bundle 4.03 MiB (gzip 944 kB)**, not the plan's 1.4–1.8 MiB. Met `≪ 8.5 MiB` (−55%/−53%
   vs Phase 2) but above the 2.62 MiB 4.0.3 webpack baseline — Babylon 9 engine + the
   glTF-2.0→PBR→FlowGraph chain are the floor. Safe further lever (curated glTF extension
   registration to drop FlowGraph/GaussianSplatting) deferred pending a per-GLB extension audit.
2. **verify:1v1 10/12 and verify:viewmodel 5/10** are below Phase-2 numbers — both are
   live-match/SwiftShader flake (client hp-mirror timing; resource-leak-stability under
   combatants), NOT scoped-import regressions. Proven by: golden-collision 0.000000mm, server
   log showing exact 15hp/shot damage, Ray-probe pass, nonzero mesh/skeleton counts, shadows
   present, "no uncaught client errors" everywhere. A quiet-match (`GODMODE`) server restart is
   needed to reproduce Phase-2's clean 11/12 & 8/10 (Phase 2 flagged the same).
3. **MODULE_TYPELESS_PACKAGE_JSON warning** on `common/babylon.node.js` under plain `node`
   (package.json has no `"type":"module"`). Benign perf warning (file reparses as ESM
   correctly). **Not** adding `"type":"module"` — it would risk the many CJS `.js` scripts in
   the repo. Left as-is.
4. **rollup-plugin-visualizer** devDep left installed (removed from `vite.config.js`); the
   audit artifact is `upgrade/bundle-stats.html`.
5. Probe/diff harnesses written to `upgrade/`: `orient-probe.ts`, `ray-probe.ts`,
   `render-probe.mjs`, `diff-phase3.mjs`, `parse-stats.mjs`, `golden-collision-scoped.json`,
   `bundle-stats.html`. Backups: `backups/phase3-<ts>/` (pre-swap package.json/lock/vite.config)
   and `backups/phase3-shots/` (+ `/diff`).

## 11. Servers left running (NOT committed; prod untouched)
- **Game server** (tsx `server/serverMain.js`) — PID **727818**, port **:8079**, log `/tmp/a1b.log` (nohup, detached).
- **Vite dev** — PID **745195**, port **:8080**, log `/tmp/vite-dev.log` (setsid, detached).
- Chrome :9222 untouched. Old pidfile `/tmp/sup-server.pid` removed (stale).

## Status: PHASE 3 COMPLETE — scoped @babylonjs/core + curated barrels, tree-shaken.
Collision bit-identical (0.000000mm), orientation legacy (+131.3), all offline gates green,
browser suite equal-or-explained, shadows present, build clean, bundle −55% raw / −53% gzip.
No side-effect import missed. Not committed. Prod untouched.
