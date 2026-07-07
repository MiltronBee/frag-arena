# Frag Arena — Browser Arena Shooter (Project Notes)

> Goal: A fast, low-latency, multiplayer arena FPS for the browser — Unreal Tournament *in feel*,
> but original branding and original/CC0 assets. Working title: **Frag Arena** (not "Unreal Tournament").

Last updated: 2026-07-06 · Status: **running** — forked template up on Node 24, two-capsule netcode milestone verified.

## Current state (what exists now)
Decisions locked: **Babylon.js** renderer · **forked** `timetocode/nengi-babylon-3d-shooter` (Apache-2.0)
as the base, promoted to repo root · first milestone = **two capsules shooting** — DONE.

Run it: `npm install` then `npm start` → http://localhost:8080 (open two windows).
Verify netcode headlessly: `npm run verify` (needs `npm start` running).

What was required to run the 2020-era template on Node v24 (see git log for details):
- Dropped the abandoned `esm` package; run the server through **tsx** (`npm run server`), which
  handles the template's ESM-syntax `.js` + extensionless imports and gives watch/reload.
- `nengi@1.18` bootstrapped itself via `esm` → **patch-package** patch re-exports its real ESM source.
- `@clusterws/cws` (nengi's native WS transport) has no Node 24 binary and is abandoned → **patch-package**
  shim over the pure-JS **`ws`** package (echoes the `nengi-protocol` subprotocol so browsers accept it).
  This is a stopgap; the geckos.io/WebTransport (UDP) move below replaces it.
- webpack 4 needs `NODE_OPTIONS=--openssl-legacy-provider` (md4 hashing vs OpenSSL 3) — wired into the scripts.
- Fixed a real template bug: the server's `disconnect` handler crashed the whole process on any
  half-open connection (unguarded `client.rawEntity.mesh`); now null-safe.

Verified working (via `npm run verify`, 9/9): handshake over ws · client-side prediction · server-authoritative
movement replication + interpolation (client A sees client B move) · lag-compensated hitscan (server logs hits) ·
reconciliation path · no client errors.

---

## TL;DR — the plan taking shape
**Babylon.js + nengi.js netcode + geckos.io/WebTransport transport + CC0 assets (Quaternius/KayKit) + modular sci-fi arena kits**, original branding.

Netcode-first: get two capsules shooting each other with working prediction + lag compensation
*before* touching art. A crisp ugly game is fun; a laggy pretty one is dead.

---

## 1. The "no latency" reality
You can't remove latency (physics). Every good twitch shooter (UT, Quake, Valorant, CS) *hides* it
with the same four techniques — these matter more than the renderer:

- **Client-side prediction** — move immediately on input, don't wait for the server.
- **Server reconciliation** — server is authoritative (anti-cheat); corrects the client when wrong.
- **Entity interpolation** — render *other* players slightly in the past, smoothly.
- **Lag compensation** — server rewinds time to validate shots ("favor the shooter").

**Must-read before writing code:** Gabriel Gambetta, *Fast-Paced Multiplayer* (with live demo):
https://www.gabrielgambetta.com/client-side-prediction-live-demo.html

---

## 2. Recommended stack

| Layer | Pick | Why |
|---|---|---|
| Rendering | **Babylon.js** (Three.js = alt) | Batteries-included: physics, collision, animation, inspector. Less glue for a movement-heavy shooter. Matches the best netcode template. |
| Netcode | **nengi.js** | Purpose-built for fast-paced *authoritative* games — prediction, reconciliation, lag-comp collisions. (Colyseus = gentler alt for slower/room games + matchmaking.) |
| Transport | **geckos.io** (WebRTC/UDP) now; **WebTransport** (HTTP/3+QUIC) as it matures | Want unreliable/unordered UDP-like delivery. **Avoid plain WebSockets for gameplay** — TCP head-of-line blocking spikes latency under packet loss. |
| Physics | Rapier (Rust/WASM) or Babylon built-in (Havok) | Fast, WASM speed. |
| Language | **TypeScript** end-to-end | Share movement/collision code between client & server — essential so prediction matches server. |

Environment already present: Node v24.10.0, npm 11.6.1. Working dir: `/home/miltron/unreal` (empty, not a git repo yet).

### Renderer decision — STILL OPEN (user wanted to keep chatting)
- **Babylon.js**: batteries-included (physics/collision/animation/editor), first-class glTF w/ skeletal
  animation, the one good FPS+netcode template is Babylon-based. Slightly heavier, smaller ecosystem.
  → **Current recommendation** for netcode-first shooter.
- **Three.js**: bigger ecosystem, best WebGPU, more tutorials — but it's a *rendering library, not an
  engine*; you bolt on physics + character controller + animation state machine yourself.

---

## 3. Boilerplate to fork
- **⭐ timetocode/nengi-babylon-3d-shooter** — nengi + Babylon 3D shooter template with client-side
  prediction and lag compensation ALREADY wired. Same author as nengi. Closest starting point.
  https://github.com/timetocode/nengi-babylon-3d-shooter
- mohsenheydari/three-fps — solid Three.js single-player FPS (movement/weapons/AI) to lift feel from.
  https://github.com/mohsenheydari/three-fps
- colyseus/colyseus — fallback framework (matchmaking, well-documented) if trading twitch for ease.
  https://github.com/colyseus/colyseus
- miwarnec/Game-Networking-Resources — curated deep-dive list.
  https://github.com/miwarnec/Game-Networking-Resources
- nengi: https://github.com/timetocode/nengi · docs https://timetocode.com/nengi (nengi 2 = alpha, no
  default ws/buffer dep; you pick the transport tech).

---

## 4. Legal reality (READ)
**Cannot** ship actual Unreal Tournament content — models, textures, sounds, maps, announcer, or the
name. Epic retains all copyright; their license only covers mods *inside* their engine/official UT
project, not a standalone web game. Epic IP FAQ:
https://legal.epicgames.com/en-US/epicgames/intellectual-property-faq

**The move:** original arena shooter *inspired by* UT — same feel (fast movement, dodge-jump, hitscan
+ projectile weapons, powerups, frag arenas), own/CC0 assets, different name. Mechanics/feel aren't
copyrightable; assets and branding are.

---

## 5. Assets

### Free / CC0 (public domain, commercial-OK, usually no attribution)
- **Quaternius** — CC0 low-poly characters (rigged+animated), weapons, sci-fi modular kits. Backbone.
  https://quaternius.com/
- **KayKit / Kay Lousberg** — CC0 low-poly character & weapon packs. https://kaylousberg.com/
- **Kenney.nl** — CC0 everything (guns, UI, audio, prototype kits). The go-to for placeholders.
  https://kenney.nl/
- **itch.io free FPS** — https://itch.io/game-assets/free/tag-fps (check each license individually)
- **OpenGameArt CC0** — https://opengameart.org/content/cc0-assets-3d-low-poly
- **awesome-cc0** meta-list — https://github.com/madjin/awesome-cc0
- **PSX First Person Arms (CC0, FREE)** — animated 1st-person arms, FBX/GLB. Use to smoke-test the
  load→animate→shoot pipeline before spending money.
  https://drillimpact.itch.io/psx-first-person-arms-free

### Paid — recommended buy (~$10)
- **⭐ Low Poly FPS Weapons Pack — JustCreate3D (itch.io), ~$9.99** — 282 low-poly models, weapons in
  **separate parts** (riggable), itch license OK for commercial web. Convert to glTF/GLB.
  https://justcreate3d.itch.io/low-poly-fps-weapons-pack

### Art direction — DECIDED (2026-07-06)
- **Style/source: Synty POLYGON (paid, AAA-indie low-poly).** Coherent look across chars/env/weapons.
- **Buy: [POLYGON — Sci-Fi Space Pack](https://syntystore.com/products/polygon-sci-fi-space-pack) ~$74.99**
  (50% off $149.99). 660 assets = 20 characters (Space Soldiers, EVA, War Robot, aliens), 7 weapons
  (pistol/rifle/shotgun/melee), + environment/props/FX/ships. One buy ≈ all third-person art.
- **First-person viewmodel is NOT in Synty** (they're third-person). Cover with free
  [PSX First Person Arms](https://rbgr.itch.io/psx-assets-first-person-arms) now, or a ~$15–20 paid animated
  arms/rifle later.
- **Format reality:** Synty ships FBX → convert only the handful we use to **GLB** (Blender/gltf tools).
- **Pipeline built now with CC0 placeholders** so Synty is a drop-in swap. The ONE place art is wired is
  `client/assets/assetManifest.js` (role → {url, scale, yOffset, animClips}). Character rendering =
  `client/graphics/CharacterModel.js` + `createPlayerFactory` (attach visual to the invisible collision
  proxy, animate idle/run by velocity — other players only, self stays first-person).
  Placeholder character = RobotExpressive (CC0, Quaternius). Done + verified (client A sees client B as a robot).

### Skinning progress (placeholders; Synty swaps in via manifest)
- [x] **Characters** — other players render as animated GLB bodies (idle/run by velocity). `CharacterModel.js`.
- [x] **First-person viewmodel** — **animated FP arms holding an AR-style rifle** with idle + fire
      clips (pack also has reload + walk). `Viewmodel.js` drives skinned anim clips. Source: "Retro Weapon
      Pack" (free, commercial-OK, no attribution) — Unity FBX, converted to glTF in Blender.
      **FBX->glTF pipeline** (reusable for the Synty packs): `scripts/fbx-to-gltf.blender.py` runs headless
      Blender (`/tmp/blender-portable`) to import the arms mesh + rifle (parented to the `hand_item_r`
      socket bone) + merge the separate per-clip animation FBX as NLA tracks, recenter on the rig's
      `camera` bone, assign textures (nearest filter, roughness 1), and export one GLB.
      IQM (Xonotic) -> glTF converter also kept: `scripts/iqm-to-gltf.py`.
- [x] **Weapon switching** — 4-weapon loadout (Rifle / SMG / Shotgun / Pistol), all from the Retro pack,
      each its own converted GLB (gun + arms + idle/fire clips). Switch with **1-4 / Q / mouse-wheel**;
      HUD shows the weapon name. All viewmodels preloaded, only the equipped one shown. The converter now
      trims the upper-arm/shoulder geometry so the FP camera isn't inside the mesh, and a dedicated
      viewmodel light keeps arms/gun lit. Each weapon has a hand-tuned camera-local transform (their idle
      poses hold the arms at different distances). Pistol framing is the roughest (its idle swings a lot).
- [x] **Effects & lighting** — directional light, equirect skybox (fog-excluded), subtle fog, muted ground,
      crosshair, and **object-pooled** shot FX (tracer + muzzle flash + impact). `BABYLONRenderer.js`.
      NOTE: FX pooling is mandatory — creating meshes/materials mid-frame crashes the GL bind on strict
      drivers (SwiftShader). Dynamic **shadows dropped** for the same reason (skinned-mesh shadow depth);
      revisit with a pre-warmed shadow path.
- [ ] **Arena** — still placeholder white plane + yellow obstacle boxes. Next: modular environment GLB
      (visual, client-only) + simple invisible collision primitives mirrored server-side.
- [ ] Swap placeholders for real **Synty** GLBs once purchased (edit `assetManifest.js`).

### ⚠️ AVOID for web (Unreal Engine templates, not usable in Babylon/Three)
- Low Poly Shooter Pack v6.0 (Fab) — https://www.fab.com/listings/90ba076a-dc9a-4782-9ac8-dc2ed4f06405
- Low Poly Animated – Modern Guns Pack (Fab) — https://www.fab.com/listings/6914a185-4b14-475c-8f4f-cc0a6a3c589f
- These are `.uasset` UE projects; you'd only be ripping raw FBX meshes and throwing away the
  blueprint/multiplayer half you paid for.

### Asset pipeline notes
- Target **glTF/GLB** (web-native; Babylon & Three load natively). Quaternius/KayKit ship it.
- Build arenas from **modular sci-fi kit pieces**, not hand-authored whole maps.
- Powerups, muzzle flashes, hit sparks = cheap to make yourself.
- **Scarcest free asset:** great *animated first-person weapon viewmodels* (arms + gun bob). Expect to
  buy (~$10–30) or make/commission these; everything else can be CC0.

---

## 6. Open decisions / next steps
- [x] **Lock renderer**: Babylon.js.
- [x] Start mode: forked `nengi-babylon-3d-shooter`, promoted to repo root, `git init` done.
- [x] First milestone: two capsules shooting (prediction + lag comp) — verified via `npm run verify`.
- [ ] Nail netcode *feel*: dodge-jump, air control, tighter hit reg — tune movement in `common/applyCommand.js`
      + `common/weapon.js`. (The template's movement is placeholder-basic.)
- [ ] Replace the `ws` transport shim with **geckos.io / WebTransport (UDP)** — the whole reason to avoid
      TCP for gameplay; the current WS path is fine only for localhost/dev.
- [ ] Consider migrating server+shared to real ESM or TS (currently run via tsx) for a cleaner monorepo.
- [ ] Smoke test: wire FREE PSX arms into a Babylon scene, prove load→animate→shoot before buying.
- [ ] Buy JustCreate3D weapons pack (~$10) once pipeline proven.
- [ ] Give the arena real materials/lighting — right now it's white capsules on a white plane.
