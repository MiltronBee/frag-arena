// Consult gemini-3.5-flash as a senior game engine/graphics programmer for advice
// on the Babylon 4.0.3 -> 9.x + webpack 4 -> Vite migration. Mirrors scripts/gemini-consult.mjs.
import fs from 'node:fs'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const PERSONA = `You are a SENIOR GAME PROGRAMMER with 20+ years shipping production games — engine and graphics side. You have personally led multiple large engine/renderer version migrations (major upgrades of Unity, Unreal, and web/WebGL engines) and rebuilt build pipelines (from Grunt/webpack to modern ESM bundlers). Deep expertise: real-time rendering (WebGL2/WebGPU, shaders, shadows, materials, glTF), deterministic simulation for netcode, JS/TS build tooling and tree-shaking, and — critically — the discipline of NOT breaking a live, shipping game while modernizing under it. You are blunt, specific, opinionated, and you optimize for RISK-ADJUSTED shipping, not for using the newest toys. You call out gold-plating and yak-shaving. When something is a trap, you say so and say why. You give concrete, code-level or process-level recommendations. You have no ego about the "right" way — you care about the game staying live and feeling good.`

const BRIEF = `
PROJECT: "Degen Tournament" (was Frag Arena) — a LIVE browser arena FPS (UT99 feel) at https://sol-pkmn.fun.
Stack: JavaScript. Node server + Babylon.js client. nengi netcode (authoritative server + client prediction).
The game is SHIPPING and being actively iterated (maps, weapons, FX). We do not want to break it.

We just finished a deep research pass and produced a migration plan. We want your gut-check on it before executing.

=== THE MIGRATION ===
FROM: Babylon.js 4.0.3 (2019) + webpack 4.41 (needs the --openssl-legacy-provider Node hack).
TO:   Babylon.js 9.x (the March-2026 major, latest 9.17.0) + Vite 7.
Bundle today: a single monolithic 2.62 MiB file (webpack can't tree-shake the 'babylonjs' UMD blob).

=== KEY FACTS FROM THE AUDIT ===
- ~90% of the BABYLON.* API surface is stable 4 -> 9. Only StandardMaterial (no PBR), stock shaders, GlowLayer, PhotoDome, ShadowGenerator (blur exponential, frozen to RENDER_ONCE for perf), material-level ImageProcessing (hand-tuned contrast/exposure/vignette). NO custom ShaderMaterial/NodeMaterial anywhere.
- One brittle hack: a string-patch that mutates a Babylon-INTERNAL GLSL shadow include (injects 'precision highp sampler2DShadow' after '#ifdef WEBGL2') to fix a 4.x strict-driver bug. Likely obsolete on 9.x.
- SceneLoader.ImportMeshAsync is deprecated in 9 (9 client call sites + 1 server) but still works with warnings.
- The bundle-size win REQUIRES moving from 'import * as BABYLON from "babylonjs"' (monolithic UMD, in ~23 files) to scoped '@babylonjs/core' deep imports + an EXHAUSTIVE list of side-effect registration imports (loaders, collisionCoordinator, shadow scene component, material modules, mesh builders...). A missing side-effect import fails SILENTLY at runtime (black screen / no shadows / players fall through the map / no meshes). Projected result: 2.62 MiB -> ~1.4-1.8 MiB.
- DETERMINISM RISK: the SAME shared module common/applyCommand.js calls mesh.moveWithCollisions() and runs on BOTH the client (prediction) and the Node server (authoritative, under Babylon NullEngine). nengi replays it for reconciliation. So client and server MUST use bit-identical Babylon collision math. The map's spawn points / killY / jump-pad launch vectors were CALIBRATED against 4.0.3's collision solver output.
- VISUAL DRIFT: Babylon changed sRGB/gamma buffer handling + material defaults across 4->9. Since we hand-tune contrast/exposure/vignette/glow, the look WILL shift and need re-tuning.
- ~30 headless puppeteer verify scripts (netcode, movement, hit-reg, FX, viewmodel) gate everything. They read window.gameClient / window.BABYLON.
- WebGPU is available in Babylon 9 (WebGL2 still supported, NOT dropped). Adopting it needs an async engine.initAsync() boot restructure across 4 files. Custom GLSL still works under WebGPU.

=== OUR PROPOSED 4-PHASE PLAN (each phase independently shippable, gated by the verify scripts) ===
Phase 1: Swap ONLY the bundler — Vite 7, keep Babylon 4.0.3 and the monolithic 'import * as BABYLON'. Prove build/dev/deploy.
Phase 2: Bump Babylon 4.0.3 -> 9.x on the UMD 'babylonjs' package (minimal import churn), fix the API breaks, do the visual re-tune. Ship.
Phase 3: Migrate to scoped @babylonjs/core imports + the side-effect-import list for the tree-shaking bundle win. Highest churn (23 files), highest silent-break risk.
Phase 4 (optional): WebGPU as a runtime-detected opt-in, WebGL2 stays the default.

=== QUESTIONS FOR YOU (be brutal, be specific) ===

Q1 — SEQUENCING: Is the 4-phase order right? Any phase a trap or in the wrong place? In particular: is "Vite first on the OLD engine" (Phase 1) smart de-risking, or a waste that should be folded into the engine bump? Would you ever ship Phase 2 (new engine, still-fat UMD bundle) to real users, or is an intermediate ship there pointless?

Q2 — THE DETERMINISM LANDMINE: We depend on Babylon's built-in moveWithCollisions() being bit-identical between the 4.0.3-calibrated tuning and 9.x, AND identical between client and server. Is leaning on a general-purpose 3D engine's collision solver for authoritative deterministic netcode a fundamental mistake? Would you (a) accept it and just re-tune after the bump, (b) pin/freeze the collision code, or (c) rip movement/collision OUT of Babylon into our own tiny deterministic capsule-vs-AABB sim so the renderer version can never affect gameplay again? How much does this matter for UT99 feel?

Q3 — IS THE TREE-SHAKING WORTH IT? Phase 3 touches 23 files and introduces a whole class of silent runtime-break bugs, to go from 2.62 MiB to ~1.5 MiB. For a live game, is chasing ~1 MiB worth that risk and effort, or should we ship UMD 9.x (Phase 2) and stop? What would change your answer (mobile %, load-time data, connection profiles)?

Q4 — VISUAL DRIFT DE-RISKING: A hand-tuned look across a 5-major-version jump. What's your process to make the re-tune fast and not a multi-day rabbit hole? Golden-image screenshot diffing? Lock specific restoration flags? Just eyeball it and move on?

Q5 — WEBGPU: For a browser FPS in mid-2026 with a static-ish scene and a frozen shadow map, is WebGPU worth the async-boot complexity, or a distraction? Skip it, or do it?

Q6 — WHAT ARE WE NOT ASKING? If you were tech-lead on this migration, what's the thing most likely to bite us that isn't in our plan, and what would you do in the FIRST DAY?
`

const body = {
  systemInstruction: { parts: [{ text: PERSONA }] },
  contents: [{ role: 'user', parts: [{ text: BRIEF }] }],
  generationConfig: { temperature: 0.35, maxOutputTokens: 8192 },
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.error('Gemini HTTP', res.status, await res.text())
  process.exit(1)
}
const json = await res.json()
const text =
  json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ??
  JSON.stringify(json, null, 2)
console.log(text)
