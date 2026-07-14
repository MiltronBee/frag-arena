# Frag Arena — First-Person Weapon Foundation: Verified Report

Date: 2026-07-13 · Scope: holding, shooting, held-auto fire, reload, reload
interruption/cancel, swapping, draw/hide, death/respawn, disposal/async-load, and
every overlap between them, for **Rifle, SMG, Shotgun, Pistol, Plasma (rifle reuse)**.

Verification is behavioral, against the real Babylon 4.0.3 runtime — both the live
browser (Puppeteer) and a deterministic headless Babylon `NullEngine` harness that
loads the shipped GLBs and evaluates their skeletal animation exactly as the client
does. Nothing here rests on "looks okay."

---

## 1. Outcome

All local gates are **double-green** (two full clean runs). Fixed and verified:

| Area | Before | After |
|---|---|---|
| Viewmodel state control | booleans + `observable.clear()`, race-prone | explicit FSM + generation tokens |
| Shotgun fire (expanded) | left hand rode the pump-rack **~29 cm** off the gun | see §6 — expanded blocked on a pose defect; **ships the original, correct-pose shotgun** |
| Rifle reload-cancel test | failed at 0.066 (a breathing-sway artifact) | rigorous envelope+not-frozen assertion, passes |
| Projectile factory | `factory.create/.delete is not a function` on every bolt | registered as an object; late/dup deletes guarded |
| Projectile material | leaked one `StandardMaterial` per plasma shot | disposed on delete; count returns to baseline |
| Texture leak check | flaked on a one-time lazy shadow RTT | warms lazy resources before baseline (no weaker) |
| Cache/version | JS + GLB URLs never changed across deploys | single content-hashed `BUILD_ID` on JS+CSS+GLB |
| Structural GLB verifier | false-positived a static-gun clip | defers arms-only verdict to the geometric grip-slip |
| Tests | swap-lifecycle only | + offline per-weapon anim + browser race/soak(200) |

---

## 2. The state model (client/graphics/Viewmodel.js)

The rig is now an explicit finite-state controller. States:
`LOADING · HIDDEN · DRAWING · IDLE · FIRING · RELOADING · DISPOSED`.

Legal transitions:

```
LOADING  --load ok, want active-->  DRAWING (if draw clip) | IDLE
LOADING  --load ok, want hidden-->  HIDDEN
LOADING  --disposed mid-import-->   DISPOSED (resources cleaned when import settles)
HIDDEN   --setActive(true)------->  DRAWING | IDLE
DRAWING  --draw clip ends--------->  IDLE
IDLE     --kick()---------------->   FIRING
FIRING   --kick() (auto/semi)---->   FIRING      (restart the fire clip)
FIRING   --fire clip ends-------->   IDLE
IDLE/FIRING --reload()----------->   RELOADING
RELOADING --reload clip ends----->   IDLE
RELOADING --cancelReload()------->   IDLE         (base pose restored first)
any live --setActive(false)/death-> HIDDEN        (mid clips rewound to base)
any --dispose()------------------>  DISPOSED
```

**Generation tokens.** Every state-changing call increments `_gen` and captures it.
Animation end-callbacks (`addOnce`) no-op if a newer transition has superseded them.
Because Babylon 4.0.3 `AnimationGroup.stop()` fires the end observable synchronously,
a superseded one-shot self-removes the instant the next clip starts — so no
`onAnimationGroupEndObservable.clear()` (which would also drop other code's observers)
is needed, and a stale "fire ended → restart idle" can never fire under a fresh clip.

**Base-pose restoration.** Interrupting a clip (`cancelReload`, hide/death) calls
`_rewindStop(group)`: `goToFrame(group.from)` while it is still playing, then `stop()`.
In 4.0.3 `goToFrame` applies the sampled value to the target immediately
(`RuntimeAnimation.setValue`), so gun-only bones the clip solely drives (slide,
magazine, weapon root) deterministically snap back to the rest pose rather than
freezing mid-swing. Verified offline: every weapon's fire and reload rewind to the
idle base pose with **0.0000 model-unit** deviation (§5).

**Auto vs semi fire.** `kick()` is called once per shot the gameplay layer actually
fires (cooldown-gated in `common/weapon.js`, unchanged). Rapid auto-fire restarts the
fire clip each kick; the older token makes the previous clip's end a no-op so idle
never flickers underneath. The last shot's clip completes and settles to IDLE, so
semi-auto stays edge-correct. Gameplay authority/cadence is untouched — the viewmodel
is presentation only.

Public API preserved: `setActive · reload · cancelReload · kick · update ·
muzzleWorldPos · isReloading · dispose` and `.ready/.spec/.holder/.muzzle/._result/
._reloading`.

---

## 3. Root causes & fixes

### 3.1 Projectile factory — `factory.create/.delete is not a function`
`createFactories.js` registered `'Projectile'` as an **uninvoked arrow function**,
while nengi (`niceClientExtension`) calls `factory.create({...})` / `factory.delete`.
Every replicated Plasma bolt threw. Fix: register the factory **object** directly.
Also hardened the `delete` handler to check entity existence *before* dereferencing
`entity.protocol` (a late/duplicate delete of a short-lived projectile was a null
deref) and to tolerate a missing factory.

### 3.2 Projectile material leak
`Projectile` builds a fresh `StandardMaterial` per bolt; the factory's `mesh.dispose()`
used default args (materials **not** disposed), leaking one material per shot
(measured 9→16 over 2 s of fire, staying at 16 after all bolts expired). Fix:
`mesh.dispose(false, /*disposeMaterialAndTextures*/ true)`. Measured after fix: 9→11
during fire, back to **9** once bolts expire.

### 3.3 Rifle reload-cancel "0.066 off rest"
Not a freeze. The rifle's authored idle **breathes the weapon-root object ±0.066**
(Y axis only; X/Z constant), and the reload clip's start frame equals idle frame 0
exactly — so cancel already restores correctly. The old test compared two breathing
phases against a 0.05 snapshot threshold, which is physically impossible to pass. The
test now measures the idle breathing envelope over a full ~6.7 s cycle and asserts the
post-cancel root sits back inside it, is still breathing (not frozen at the reload
pose), and the flag is clear — **stronger** than the snapshot (it also catches a
freeze). No tolerance was loosened.

### 3.4 Viewmodel texture-leak flake
`sun_shadowMap2` (the sun shadow generator's second RTT) is allocated lazily on the
first shadow renders. Capturing baseline before that one-time allocation read as a
per-swap leak. Fix: wait for the scene texture count to stabilize before baseline.
Detection is unchanged — a real leak still adds a texture on **every** swap, which the
post-swap comparisons catch.

### 3.5 Cache/version strategy
Bundle (`app-v0.0.1.js`) and GLB URLs never changed across deploys, so phones kept
stale caches (and a new GLB at the same URL would never be re-fetched). Added
`scripts/stamp-build.mjs` (runs in `npm run build`): it hashes the JS bundle + CSS +
every weapon GLB into one content-derived `BUILD_ID`, then stamps `public/index.html`
with `window.__BUILD_ID__` and a `?v=<BUILD_ID>` query on the app `<script>` and the
stylesheet. `Viewmodel._load` appends the same `?v=` to GLB URLs. Because the id is
content-derived and shared, a deploy's code and its assets are always fetched as one
matched set — a phone can never mix a new bundle with a stale GLB. (index.html is the
bootstrap carrying the id and must be served without a hard cache — standard for HTML.)

### 3.6 Structural verifier false-positive
`verify-retro-glb.py` failed any clip that animates the arms but not the gun
("detachment risk"). That contradicts its own geometric ground-truth: a clip may hold
the gun static at bind while the baked arms grip it. The rule now **defers to the
measured grip-slip** — fail only if the grip actually slips (> tol) or cannot be
measured. Real detachments (large slip) still fail; the historical draw-detachment
still fails.

---

## 4. Per-weapon matrix (shipped assets)

Grip = support-hand↔gun spread through the fire clip (offline, cm). Pose = held
orientation on screen. FSM = all race scenarios in §5.

| Weapon | Idx | GLB | Fire grip | Idle | Pose | Draw | Reload | FSM races |
|---|---|---|---|---|---|---|---|---|
| Rifle | 0 | expanded | 0.00 cm | 0.00 | ✅ forward hold | (n/a, spec) | ✅ | ✅ |
| SMG | 1 | expanded | 0.70 cm | 0.81 | ✅ | ✅ | ✅ | ✅ |
| Shotgun | 2 | **original 4-clip** | 3.16 cm (< 3.5) | static | ✅ (expanded pose bug — §6) | (n/a) | ✅ | ✅ |
| Pistol | 3 | expanded | 0.00 cm | 0.00 | ✅ | ✅ | ✅ | ✅ |
| Plasma | 4 | rifle reuse | 0.00 cm | 0.00 | ✅ | (n/a) | ✅ | ✅ + projectiles clean |

Captures: `/tmp/weapon-foundation/held-{rifle,smg,shotgun,pistol,plasma}.png`
(all pose forward), `desktop-*.png`, `portrait-*.png` (desktop+portrait smoke),
`held-shotgun-ORIGINAL.png` vs the expanded pose bug.

---

## 5. Tests & results (all double-green locally)

New:
- `scripts/verify-weapon-anim.mjs` (`npm run verify:anim`) — deterministic offline,
  all 5 weapons: clip presence, support hand rides the gun through fire, stable idle,
  and **fire+reload rewind to the idle base pose (0.0000 dev)**. 25/25.
- `scripts/verify-weapon-states.mjs` (`npm run verify:weapons`) — live browser, drives
  the real FSM: fire tap/hold/release, empty-mag, reload full/partial, held reload,
  fire-during-reload (reload-cancel-by-fire), swap during fire/reload/draw/import,
  rapid 1-2-3-1, repeated slot, death mid-animation + respawn, plasma projectile
  create/delete, and a **seeded 200-action randomized soak**. Invariants throughout:
  one holder+muzzle, visual==gameplay, no ghost, per-weapon leak-free, FSM settles,
  no console/server error. 21/21.

Existing (re-run, still green): structural-glb (rifle/smg/pistol expanded, 3/3;
shotgun ships legacy — validated by fire-attachment + anim + visual), netcode 9/9,
movement 8/8, touchlook 14/14, mobile 13/13, viewmodel-lifecycle 10/10,
fire-attachment 10/10. Production `npm run build` clean. Desktop + portrait smoke pass
(non-blank, weapon meshes enabled, visual==gameplay, zero errors).

**Final double-green (shipped assets), both runs identical:**

```
structural-glb (rifle/smg/pistol expanded)  3/3
netcode                                      9/9
movement                                     8/8
touchlook                                   14/14
mobile                                      13/13
viewmodel-lifecycle                         10/10
fire-attachment                             10/10
weapon-anim-offline (5 weapons)             25/25
weapon-states race+soak (200 actions)       21/21
production build + stamp                     clean
desktop + portrait smoke                     pass
```

**Live verification against https://sol-pkmn.fun (post-deploy):** index.html serves
the versioning (`__BUILD_ID__` + `?v=`), bundle sha256 matches the local build,
versioned GLB fetch → HTTP 200, and the browser gates (netcode over `/ws`, mobile,
viewmodel, fire-attachment, per-weapon anim over the live GLBs, and the race/soak)
were re-run green against the live site.

---

## 6. Remaining risk — the expanded Shotgun (precise blocker)

The **expanded** shotgun is not shipped. Two independent source-data defects:

1. **Fire pump-rack (fixed).** `ctrl_HandIK_l` is CHILD_OF-constrained to the gun
   Forearm bone; the `shotgun01_fire` action is a full 24-frame pump-rack that
   translates the Forearm ~11 cm, so the baked support hand rode it ~26–29 cm off the
   weapon every shot. Fixed in `retro-blend-actions.json` by exporting fire with
   `gun:[]` (gun held at bind, baked arms grip it rigidly + procedural recoil) →
   grip-slip **0.00 cm**. The source offers only glued-grip or full-pump for the left
   hand, no short recoil take; support-hand release is preserved where authored — the
   reload segments.
2. **Idle base orientation (blocker).** Even with fire fixed, the expanded build's
   gun object-family idle (`movement_breathing`) carries a base orientation that, under
   the shared camera-relative mount (yaw π/2 that aligns rifle/SMG/pistol/plasma),
   tilts the whole shotgun **up and out of frame**. Root cause is source-data: the
   shotgun splits gun motion into object (`movement_*`) + bone (`shotgun01_*`) families
   whose object base transform differs from the single-action rifle/SMG/pistol rigs
   (the exporter also reports `gun meshes added: []` / no CHECK GUN for it). Correcting
   it needs a per-weapon mount correction or a re-export that re-bases the shotgun
   object transform — neither cleanly available from the vendor source alongside the
   pump fix.

**Decision:** ship the **original committed 4-clip shotgun** (idle/fire/reload/draw) —
it poses correctly, its fire keeps the hand on the grip through recoil (support-hand
spread 3.16 cm < 3.5 cm), and it is the current live asset (no regression). The fire
fix and this blocker are recorded in `retro-blend-actions.json`
(`shotgunFireGrip`, `shotgunNotShippedBlocker`). Re-enable by rebuilding with
`scripts/build-retro-candidates.sh Shotgun` once the base orientation is corrected.

Other residual: the original shotgun's authored fire recoil moves the gun Main bone
~12 cm relative to the trigger hand (per the strict structural metric); visually the
hand stays on the grip (it is the recoil kick) and this is the unchanged live behavior.

---

## 7. Artifacts, hashes, rollback

**Deployed (https://sol-pkmn.fun), BUILD_ID `0.0.1-dde13b2090`:**

```
public/js/app-v0.0.1.js   sha256 6b3e17f12928d48f…   (FSM + projectile + versioning)
public/index.html         sha256 25ddf69ad5a3aa6f…   (stamped ?v= + __BUILD_ID__)
public/css/styles-…css     unchanged vs live
weapon GLBs (all == live, no change):
  retro_rifle_arms.glb    sha256 15eb425f33476ebf…   (expanded)
  retro_smg_arms.glb      sha256 9b497f49ce2eaaa3…   (expanded)
  retro_shotgun_arms.glb  sha256 f571461e3c7b280b…   (ORIGINAL 4-clip == git HEAD)
  retro_pistol_arms.glb   sha256 ce1097cd6239a065…   (expanded)
```

Deploy was scoped: only `public/index.html` + `public/js/app-v0.0.1.js` differed from
live and were rsynced; `common/` + `server/` already matched (nengi protocol in sync,
no server-code change); only the `frag-arena` pm2 process was restarted (mechs-api,
mechs-arena, tokidoki-web untouched).

Server backup (pre-deploy): `/var/www/frag-arena/backups/app-preweapon-20260713-182815.tgz`
(+ `weapons-preweapon-20260713-182815/`). Prior task backup
`app-pretest-20260713-062240.tgz` retained.

**Rollback.** Fresh dated server backup taken before deploy (see §deploy log). To
revert locally: the shotgun GLB already equals `git show HEAD:` (original); the client
changes are confined to `client/graphics/Viewmodel.js`, `client/factories/
createFactories.js`, `client/niceClientExtension.js`. All pre-existing uncommitted
mobile/arena/viewmodel/GLB work was preserved untouched.
