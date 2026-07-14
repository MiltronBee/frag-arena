# Mobile FPS Touch Controls — Research & Implementation Design for Frag Arena

**Date:** 2026-07-12 · **Repo:** `/home/miltron/unreal` (working tree, incl. uncommitted changes) · **Author:** Claude research agent
**Scope:** research + design only — no source files were modified.

---

## 0. Executive recommendation

Frag Arena already ships the *skeleton* of the correct genre-standard layout (floating left joystick, right-half drag-look, thumb-cluster buttons, safe-area-aware CSS, a puppeteer verification harness). What it lacks is exactly the set of things that make a touch shooter feel *fast* instead of generic:

1. **The fire button is not a look surface.** Holding fire freezes your aim — the single biggest feel-killer in the current build. The genre leaders let the fire-button thumb keep steering the camera (PUBG Mobile's right fire button doubles as a camera surface; CoD Mobile exposes the same coupling as a settings toggle — §2.1). This is a ~30-line change in `client/TouchControls.js` and is the highest-leverage fix in this entire report.
2. **UT dodge does not exist on touch.** Double-tap dodge is wired for keyboard only (`client/InputSystem.js:70-79`); the defining UT99 movement verb is unreachable for the platform this design targets. Add a joystick double-flick gesture plus a dedicated dodge button.
3. **Look is too slow and has no acceleration.** At the current fixed scale, a 180° turn needs ~1,050 px of swipe — more than a full screen width on every phone. UT pacing demands a dual-zone velocity curve (precise when slow, up to ~2.2× gain on flicks) and a separate touch sensitivity setting.
4. **Weapon switching is a one-way cycle button** for 5 weapons (up to 4 taps to reach a weapon). UT play is weapon-combo play; replace with a direct-select weapon bar.

**Recommended path:** a three-phase plan (§6): Phase 0 fixes the four issues above plus button repositioning and PWA/orientation hygiene (~1 day, all quick wins); Phase 1 migrates to Pointer Events, adds the response curve, left-handed mirror, customization and onboarding; Phase 2 adds touch-only aim-slowdown assist, optional gyro aim, and a layout editor. Acceptance criteria and an automated + on-device test matrix are in §7, building on the existing `scripts/verify-mobile.mjs`.

**What to protect:** always-run movement, manual fire (no auto-fire by default), hard-capped mild aim assist (slowdown only, no magnetism), and dodge as a first-class, teachable gesture. These preserve the violent, twitchy UT99 identity on phones (§8).

---

## 1. Current-state audit (what exists and where it breaks down)

### 1.1 Architecture overview

Input flows through three layers, all client-side, then into the shared deterministic simulation:

```
TouchControls.js ──writes──▶ InputSystem state ──read per rAF──▶ Simulator.update()
  (touch events)              (_currentState /                     │
InputSystem.js  ──writes──▶    frameState booleans)                ├─▶ MoveCommand (per frame) ──▶ nengi ──▶ server GameInstance
  (keyboard/mouse/lock)                                            ├─▶ applyCommand() local prediction
                                                                   └─▶ fire() gate ──▶ FireCommand + predicted tracer
```

- `client/TouchControls.js` (223 lines) — mounted only when `isTouchDevice()` is true (`pointer: coarse` + touch points, `TouchControls.js:14-16`), instantiated in `Simulator` constructor (`Simulator.js:53-56`).
- `client/InputSystem.js` — owns the canonical input state objects. Touch writes into `input._currentState` / `input.frameState` directly, so **prediction/netcode is identical for touch and desktop** (a genuinely good property of the current design).
- `client/Simulator.js:184-288` — per-rAF `update()`: reads `frameState`, builds a `MoveCommand` (digital booleans + camera ray + delta), predicts via `common/applyCommand.js`, gates firing via `common/weapon.js` `fire()`, sends `FireCommand` when the client-side cooldown/ammo gate passes.
- Server `server/GameInstance.js:109-120` applies each received `MoveCommand` with the same `applyCommand`; `FireCommand` re-fires on server state with lag-compensated hitscan (`timeAgo = client.latency + 100`, `GameInstance.js:166`).

### 1.2 What exists today (touch)

| Feature | Implementation | Location |
|---|---|---|
| Floating movement joystick | left 50% of screen; base appears under thumb; knob clamps to 60 px | `TouchControls.js:87-139`, CSS `styles-v0.0.1.css:559-602` |
| Movement mapping | **digital 8-way**: 22.5° sector edges set WASD booleans; 12 px dead zone; analog magnitude discarded | `TouchControls.js:7-10,129-139` |
| Drag look | right 50%; per-move deltas × `TOUCH_LOOK_SCALE = 3` fed into the mouse path (`0.001 rad/px × sensitivity`) | `TouchControls.js:141-177`, `Simulator.js:107-120` |
| Fire | dedicated 92 px hold button, bottom-right; sets `mouseDown`; 8 ms vibration on press | `TouchControls.js:198-202`, CSS `:630-643` |
| Jump | 64 px hold button above the right edge | `TouchControls.js:204-207`, CSS `:645-650` |
| Reload | 56 px hold button (edge-triggered in `Simulator.js:210,247`) | `TouchControls.js:209-211` |
| Weapon switch | 58 px button, cycles `weaponIndex + 1` only | `TouchControls.js:213-215` |
| Settings | 42 px gear, top-right → same settings menu as desktop (FOV, one shared sensitivity slider) | `TouchControls.js:217-219`, `index.html:71-83` |
| Fullscreen/orientation | `requestFullscreen` + `screen.orientation.lock('landscape')` on first touch, failures swallowed | `TouchControls.js:66-78` |
| Gesture suppression | `touch-action: none`, `user-select: none`, tap-highlight off, `overscroll-behavior: none`, `preventDefault` on non-passive `touchstart/touchmove`; `viewport-fit=cover` + `user-scalable=no` meta | CSS `:537-543,20-28`, `index.html:7` |
| Safe areas | every button/zone offset by `env(safe-area-inset-*)` | CSS `:630-673` |
| Mobile HUD | health/ammo panels move to the **top** on coarse pointers, freeing the bottom for thumbs | CSS `:675-752` |
| Multi-touch ownership | joystick and look each track one `touch.identifier`; extra touches in a zone are ignored; buttons are sibling elements above the zones so their touches never double as look input | `TouchControls.js:31-32,98,151`, CSS z-index 500/510/520 |
| State visibility | overlay hidden (`opacity:0`, `pointer-events:none`) before arena entry, while menu open, and **while dead** | CSS `:552-557` |
| Verification | headless puppeteer harness: overlay mounts, joystick moves player, look rotates camera, fire consumes ammo, jump leaves ground, no page errors, clean harness completion | `scripts/verify-mobile.mjs` (7 checks) |

### 1.3 Where it breaks down for fast arena FPS play

Ranked by impact on UT-style play:

**B1. Firing freezes aiming (critical).** The fire button is a sibling *above* the look zone, and its touches never reach the look logic (`TouchControls.js:50-51` comment states this as intent). The right thumb is the aiming thumb; the moment it holds fire, camera control stops. In a hitscan-dominant arena game, tracking a strafing enemy *while* holding fire is the core combat verb — currently impossible without a third finger on a claw grip. Genre convention (PUBG Mobile, CoD Mobile — evidence in §2.1) is that the right-thumb fire button itself is a drag-look surface.

**B2. No dodge on touch (critical for UT identity).** `frameState.dodge` is only ever set by keyboard double-taps (`InputSystem.js:70-79`); `MoveCommand.dodge` (`MoveCommand.js:16`) is always 0 from phones. The dodge system — `applyCommand.js:88-102`, 11.4 m/s burst, cooldown, air-launch — is the most UT-specific movement feature in the codebase and mobile players can't use it.

**B3. Look tuning fights the genre's pace.** Effective yaw is `dx_px × 3 × 0.001 × sens` = **0.172°/px** at the default `sens = 1.0`:
- A 180° flick needs ~1,047 px of thumb travel — wider than the viewport of every mainstream phone in landscape (e.g. 844 px on a 390-pt iPhone, ~915 px on many Androids). Fast turns require 2–3 "ratcheting" swipes.
- There is **no response curve** — slow precision drags and fast flicks get identical gain, so any sensitivity high enough for 180s ruins micro-aim, and vice versa.
- One slider (`sens`, 0.1–5.0, `index.html:80`) serves both mouse and touch; the touch multiplier is a hard-coded constant (`TOUCH_LOOK_SCALE`, `TouchControls.js:7`).
- Vertical and horizontal gain are identical (most shooters ship reduced vertical gain).
- No invert-Y, no gyro, no assist of any kind.

**B4. Weapon switching is 1-way cycle across 5 weapons.** `weaponsConfig.js` defines 5 weapons; reaching the previous weapon costs 4 taps of `⇄` with a viewmodel GLB dispose+reload on *every step* (`Simulator.js:142-165` serializes swaps, so intermediate weapons each load). Desktop has direct-select (1–4 keys... which themselves only cover 4 of 5 weapons, `Simulator.js:170-171`) and wheel. UT pacing is weapon-combo driven (shotgun poke → SMG chase); mobile needs direct selection.

**B5. Buttons squat in the prime aim-swipe arc.** The 92 px fire button at `right:110/bottom:54`, switch at `right:32/bottom:47`, reload at `right:214/bottom:30` (CSS `:630-665`) occupy the bottom-right band where aim drags naturally start/pass. A look drag that *begins* on any button is eaten by that button (B1 makes this worse: starting on fire = accidental shot + zero aim). There is no visual affordance for zone boundaries, and no way to move/resize/fade anything.

**B6. Portrait/PWA/fullscreen gaps.** `requestFullscreen` on `documentElement` silently fails on iOS Safari (unsupported), so iPhones play with browser chrome and live edge-swipe hazards; there is **no web app manifest and no `apple-mobile-web-app-capable` meta** — the head (lines 3-12) carries only the unprefixed `mobile-web-app-capable` meta (`index.html:9`) — so "Add to Home Screen" standalone mode — the only real fullscreen path on iOS (§2.2) — is unconfigured. No portrait-orientation overlay exists; the landscape-tuned layout simply renders sideways-cramped in portrait.

**B7. Dead-state lockout.** `body.player-dead` hides the entire touch overlay (CSS `:552-557`) — a dead phone player can't look around, open settings, or (once implemented) request respawn. Note the server currently has no respawn at all (`GameInstance.js:186-205` sets `isAlive = false` terminally), so this will collide with respawn work regardless of platform.

**B8. Touch Events, not Pointer Events.** Works, but: no `setPointerCapture` semantics (currently relying on Touch Events' implicit capture-to-start-target), no `getCoalescedEvents` (look deltas quantize to event dispatch rate), and desktop-with-touchscreen edge cases are handled by a heuristic (`isTouchDevice`, `TouchControls.js:14-16`) that a `pointerType`-based system gets for free. Migration is contained entirely in `TouchControls.js`.

**B9. Small correctness/robustness nits.**
- `_bindHold` buttons don't guard against a *second* concurrent touch on the same button; a second finger's `touchend` releases a button the first finger still holds (minor).
- Joystick/look `touchend` handlers don't `preventDefault`, leaving theoretical double-tap-zoom residue on iOS (touchstart's preventDefault likely suffices; verify on-device).
- `navigator.vibrate` is called unguarded-but-`if`-checked (fine); iOS Safari has never shipped it — haptics are Android-only and undocumented to the user.
- `client/InputSystem.js.orig` is a stray backup file in the repo root of the client tree.
- The joystick clears all four WASD booleans every move (`_applyJoy`, `TouchControls.js:130-131`), so a Bluetooth-keyboard + touch hybrid user gets their keys clobbered (exotic; note only).
- `isTouchDevice()` correctly excludes touch-screen laptops (primary pointer must be coarse) but then `TouchControls` is never mounted if a tablet attaches a mouse later — acceptable.

### 1.4 Netcode facts relevant to touch input (verified against nengi 1.18 source)

- **Client tick = rAF frame.** `nengi/core/client/Outbound.js:15-24` increments `clientTick` and flushes the send queue on *every* `client.update()` call, which `GameClient.update()` runs per animation frame. One WebSocket packet of commands per frame: 60 Hz displays → 60 packets/s; **120 Hz displays → 120 packets/s and double the server-side `applyCommand` (collision) work per client**.
- **Server consumes at 20 Hz.** `nengiConfig.js UPDATE_RATE: 20`; `serverMain.js` loops at 50 ms; `instance.emitCommands()` drains all queued commands each tick. Input therefore sits in the server queue for 0–50 ms (mean ~25 ms) — this, plus network RTT, dominates end-to-end latency. Touch handling adds at most one rAF frame (≤16.7 ms at 60 Hz) over the desktop path because button state is set in the `touchstart` handler and read at the next frame; the `frameState` same-frame latch (`TouchControls.js:200,206`) already catches sub-frame taps.
- **Fire timing.** `FireCommand` carries no payload (`FireCommand.js:5`); the server re-runs the cooldown/ammo gate on its own state and rewinds hit checks by `client.latency + 100` ms (`GameInstance.js:166`) — the constant matching the client's 100 ms interp delay (`GameClient.js:8`). Touch does not change any of this; there is no touch-specific mis-timing today. (A non-touch improvement — rewinding by the command's actual client tick instead of a constant — is noted in §5 but out of scope.)
- **Prediction symmetry.** Because touch writes the same `frameState` booleans, `applyCommand` prediction and `reconcilePlayer.js` replay are input-source-agnostic. Any new touch feature that goes through `MoveCommand` fields (e.g. dodge) inherits correct prediction for free; any feature that *bypasses* it (e.g. a client-only look modifier like aim-slowdown or gyro) never touches the wire and is automatically safe.
- **Movement wire format is digital.** `MoveCommand.protocol` has four direction booleans — there is no analog field. The joystick's analog magnitude is discarded *by design of the protocol*, not just the touch layer. For UT99 (always-run, digital WASD) this is authentic and should be kept; it also means "walk speed" style analog is a protocol change, not a controls change.

---

## 2. External research findings

Method: three research passes (genre conventions; web-platform APIs; ergonomics/accessibility + UT99 primary sources), all run 2026-07-12. Every cited URL was fetched and content-checked on that date; the handful that bot-wall automated fetchers are flagged in §9. Each finding is labeled **EVIDENCE** (directly supported by the cited source, with the source's actual strength noted) or **INFERENCE** (design judgment built on the evidence plus the §1 audit). Bracketed numbers refer to §9.

### 2.1 Genre conventions in shipped mobile shooters

**A fire button that keeps aiming (validates the B1 fix).**
- EVIDENCE: PUBG Mobile's official controls FAQ defines look as "drag anywhere … on your screen where there are no icons" [5]; that the *right* fire button additionally steers the camera while held (while the optional left fire button stays fixed) is confirmed by a helper answer on the official PUBG Mobile Discord (public mirror) [9] — forum-grade, labeled as such.
- EVIDENCE: CoD Mobile ships a Basic-settings toggle named "Right Fire Button For Fixed Perspective," described in-client as "this will combine the function of shooting and aiming" [4]; settings guides list the same toggle family ("Fixed R-Fire BTN") [3]. Activision's own controls post documents right-half drag-look and the dual/left fire button options but does not describe the fire-button-as-look-surface coupling in prose [1] — do not over-attribute it to Activision.
- INFERENCE: no primary source states the behavior in a sentence, but the official settings names, layouts, and community documentation converge: in the dominant mobile shooters the right-thumb fire control does not forfeit camera control. Adopting this for Frag Arena (§4.5) is the evidence-aligned choice; the current build's fire-freezes-aim behavior is the outlier.

**Manual fire is the competitive mode; auto-fire is onboarding/accessibility.**
- EVIDENCE: CoD Mobile ships two fire modes — "Simple" (fires automatically when the crosshair covers an enemy, no fire button) and "Advanced" (manual fire button, per-weapon-class hip/ADS behavior) [1][2]. Esports-focused guidance recommends Advanced [3] (secondary source; Activision itself stays neutral [1]).
- EVIDENCE: Critical Ops — the touch-first competitive shooter closest in spirit to arena play — documents no auto-fire mode anywhere in its official materials, and its official esports allows touch input only [10].
- Supports §4.5's default (manual, hold-to-auto paced by weapon cooldowns) and design trap #1 (§8).

**Aim-assist taxonomy and touch policy.**
- EVIDENCE: the standard taxonomy — friction (turn-speed slowdown near targets), snap/centering, and magnetism — is the subject of Nick Weihs' (Insomniac Games) GDC 2013 talk "Techniques for Building Aim Assist in Console Shooters" [12]. Halo community documentation gives the cleanest published split between reticle friction (turn slowdown) and bullet magnetism (shot bending) [13] — wiki-grade, labeled.
- EVIDENCE: Critical Ops runs *subtle* aim assist at "standard values" for touch, stronger assist for controllers, and none for mouse+keyboard — explicitly framed as cross-input fairness [10][11]. This corrects a common assumption: the competitive-mobile baseline is small-but-nonzero touch assist, not zero.
- Supports §4.6: friction-only, touch-only, small — the same envelope the shipped touch-competitive title uses. The specific constants (3.0° cone, ×0.72 floor) remain INFERENCE to be playtested.

**Layout customization is table stakes.** EVIDENCE: CoD Mobile's layout editor lets players "drag, drop, and change the size and opacity of everything on-screen" (called out as serving left-handed players) [1]; PUBG Mobile's Customize editor repositions every control, per game mode [6][7]. Supports §4.2 and Phase 2.4 — and means shipping *without* at least scale/opacity/mirror options reads as below genre baseline.

**Gyro aim is an established precision option, not a gimmick.** EVIDENCE: CoD Mobile ships gyroscope aiming including an ADS-only activation mode [1]; PUBG Mobile ships a gyroscope-for-aiming setting [8]; Epic brought gyro + flick stick to Fortnite across platforms in v19.30, built with input specialist Jibb Smart, positioned as a precision upgrade over stick aim [14][15]. Supports §4.7, including the "While-firing" on-ramp (mirroring the scope-on/ADS-only convention).

**Sensitivity conventions.** EVIDENCE: shipped games expose *per-context* sensitivity sliders (camera vs. firing vs. gyro; per-scope tiers in PUBG Mobile) [1][3][7]. No major mobile-shooter developer publishes its touch response-curve internals — searched for and not found; the closest academic work found touch aiming beats tilt aiming on phones and explicitly recommends nonlinear gain transfer functions in the style of desktop pointer acceleration [16]. The dual-zone curve in §4.3 is therefore INFERENCE: the *mechanism* is validated by universal desktop pointer-acceleration practice and [16]'s recommendation; the *constants* (0.22°/px base, ×2.2 cap at ≥2.5 px/ms) get final values on-device (§7.3). The separate `touchSens` slider, however, is directly evidence-backed [1][3].

### 2.2 Web-platform facts that shape the implementation

| Fact (status as of 2026-07-12) | Sources | Consequence for Frag Arena |
|---|---|---|
| Pointer Events Level 3 is a W3C Recommendation (2026-06-30); touch pointers receive **implicit pointer capture** on `pointerdown` | [17] | Migration (Phase 1.1) keeps Touch Events' capture-to-start-target semantics for free; `setPointerCapture` calls make it explicit |
| `setPointerCapture` retargets subsequent events to the capturing element; `pointercancel` fires when the browser takes over (pan/zoom, app switch, palm rejection) | [18][19] | Clean mid-drag release paths become first-class (test A15) — Touch Events' `touchcancel` handling today is implicit |
| `getCoalescedEvents()` / `getPredictedEvents()` recover full-frequency input; Chrome aligns `pointermove` dispatch to rAF | [20][21][27] | After 1.1, look deltas must read coalesced events or they stay quantized to frame rate (the B8 fix's payoff) |
| Touch Events spec: `touchmove`/`touchend` always target the element where the touch *started* | [23] | Explains why today's sibling-button isolation works at all — and why the fire button currently swallows aim drags (B1) |
| `touch-action: none` disables browser pan/zoom gestures; `overscroll-behavior: none` stops pull-to-refresh/scroll chaining; `touchstart`/`touchmove` listeners are passive **by default** on window/document/body — `preventDefault` requires explicit `{passive:false}` | [24][25][26] | The current suppression stack is correct; keep non-passive listeners through the Pointer Events rewrite |
| iOS ignores `user-scalable=no` by default since iOS 10 (and MDN flags zoom-disabling as an accessibility harm) | [42] | The meta in `index.html:7` is a no-op on iOS; real zoom suppression already comes from `touch-action` + `preventDefault` |
| Fullscreen API on iPhone: still unsupported through iOS Safari 26.5 (iPad-only, with a non-dismissable overlay button); only `<video>` gets `webkitEnterFullscreen` | [29][30][31] | `requestFullscreen` in `TouchControls.js:66-78` will never fire on iPhone → Home-Screen PWA is the only chrome-free path (Phase 0.6); B6 confirmed |
| Manifest `display: fullscreen/standalone` works on iOS (since 11.3); manifest `orientation` is **not** supported on iOS; `apple-mobile-web-app-capable` is Apple's legacy standalone switch (detect via `navigator.standalone`) | [32][33][34] | Ship manifest + Apple meta (0.6); the rotate-device overlay (§4.9) is the *only* iOS orientation mechanism |
| `screen.orientation.lock()`: Chrome/Android only, and only in fullscreen; rejects on iOS Safari (the API object exists — compat tables that show iOS "support" reflect the object, not `lock()`) | [35] | The lock call at `TouchControls.js:73-74` silently fails on iOS by design; keep the try/catch, don't chase it |
| `DeviceOrientationEvent.requestPermission()`: iOS 13+, requires HTTPS + a user gesture (transient activation) | [36][37] | Gyro enable must be a button tap inside settings (§4.7); production is already HTTPS |
| `navigator.vibrate()`: Chrome/Android yes; never shipped in any Safari (iOS or macOS) | [38][39] | Haptics are Android-only (§4.8); hide the toggle where unsupported |
| `viewport-fit=cover` + `env(safe-area-inset-*)` is the sanctioned notch/home-indicator model | [40][41] | Current CSS already conforms; extend to every new element (weapon bar, dodge) |
| rAF fires at display refresh rate (60/120/144 Hz are all common) | [28] | Confirms §1.4's packet-rate math and motivates the Phase 2.3 cadence cap |

### 2.3 Ergonomics & accessibility

- **Touch-target sizes.** EVIDENCE: Apple HIG requires a ≥ 44×44 pt hit region for buttons [43][44]; Material/Android guidance says ≥ 48×48 dp with ≥ 8 dp separation [45]; WCAG 2.1 SC 2.5.5 sets 44 CSS px at AAA and WCAG 2.2 SC 2.5.8 sets 24 CSS px at AA [46][47]. Consequence: §4.1's sizes (44–96 px, ≥ 12 px gaps) clear AAA; today's 42 px gear is the only sub-44 target in the build (fixed in Phase 0.5).
- **Grip and thumb reach.** EVIDENCE: Hoober's 1,333-user field observation study: 49% used phones one-handed, 36% cradled, 15% two-thumbed, with reach maps grading screen regions easy/stretch/regrip [50]. The landscape two-thumb *gaming* grip is not directly in that dataset — INFERENCE by extrapolation: thumbs anchor at the lower corners with comfortable arcs along the screen edges, which is exactly why §4.1 stacks jump/dodge on the right edge, floats the stick in the lower-left, and keeps the center (worst reach + the aim-read region) empty.
- **Latency perception.** EVIDENCE: for direct-touch *dragging*, users' just-noticeable difference in latency averaged ~6 ms (range 2.4–11.4 ms) [51]; for *tapping*, JND is far higher (~69 ms) [52]. Consequence: skilled players can plausibly feel even one added frame on the look path — §4.3's zero-smoothing stance and §5.3's no-debounce-on-fire rule are evidence-backed, while the ≤ 16.7 ms rAF latch on button taps sits comfortably under the tap JND.
- **Gesture accessibility.** EVIDENCE: WCAG 2.5.1 (Pointer Gestures, Level A) requires single-pointer, non-path-based alternatives to path-based gestures [48] — the dodge double-flick is path-based, so the dodge *button* (§4.4) is simultaneously the accessibility alternative and the sweaty-hands fallback. WCAG 2.5.4 (Motion Actuation, Level A) requires motion-operated functions to be disableable with UI equivalents [49] — gyro aim (§4.7) is additive, optional, and off by default. Zoom suppression during play is a genre necessity; menus remain ordinary scrollable DOM [24][42].

### 2.4 UT99 authenticity anchors (primary sources)

- **Dodge is double-tap, canonically.** The official UT manual: "you can dodge by tapping a movement key twice in any direction… many great players who learn this technique become Unreal masters" [53]; community wiki corroborates the small vertical + medium horizontal momentum profile [54]. EVIDENCE.
- **The repo already mirrors UT99's dodge math.** UT99's own script source: `Dodge()` sets `Velocity = 1.5 * GroundSpeed` horizontally plus a 160 UU/s vertical pop, with `GroundSpeed=400` for tournament players; the engine caps the double-tap window at 0.3 s (`DodgeClickTime = FMin(0.3, …)`) [56]. Frag Arena: `GROUND_SPEED 7.6`, `DODGE_SPEED 11.4` — **exactly the 1.5× UT ratio** (7.6 × 1.5 = 11.4) — and a 250 ms double-tap window (`InputSystem.js:34`) inside UT's 0.3 s cap. EVIDENCE that the movement core is already authentic; the touch layer's only job is to expose it (B2), reusing the same 250 ms window for the stick double-flick (§4.4).
- **Always-run, no ADS, direct weapon selection.** The manual's default binds make running the base state (Walk is the held modifier, Shift) [53] — EVIDENCE. Every weapon is described solely as Fire/Alt-Fire; no aim-down-sights mechanic appears anywhere in the manual — INFERENCE from absence (no source states "UT99 has no ADS" outright). Weapons map to number keys for direct selection [53], and period strategy guides single out frequent weapon switching as the expert skill [55]. All three underpin §3 (don't import tactical-shooter buttons) and §4.5 (direct-select weapon bar).

---

## 3. Adapting the findings to UT99 pacing

The reference implementations above are dominated by military/tactical shooters (ADS-centric, sprint-gated, low mobility). Frag Arena is the opposite: hitscan duels at 7.6 m/s ground speed with air control and dodge bursts. The genre conventions need these UT-specific bends — each item below is design judgment grounded in the audit (§1) and evidence (§2):

1. **No ADS, no sprint, no crouch on touch.** The game has none of these mechanics (`applyCommand.js` — always-run at `GROUND_SPEED 7.6`), which is a *gift* on mobile: it deletes the three buttons that crowd every CoD-style layout. Do not add them for conformity. Total in-combat buttons: fire, jump, dodge — three, plus passive weapon bar. Fewer, bigger, better-placed buttons is the win condition for touch UT.
2. **Movement stays digital 8-way.** Keep the 22.5° sector mapping — it matches the wire protocol, UT99's own digital heritage, and full-speed-always gameplay. The joystick's job is *direction*, not throttle. (Do lower the dead zone and add the dodge gesture — §4.)
3. **Look must be flick-capable.** UT fights happen at 360°; a phone player who cannot 180° in ≤2 swipes is dead to anyone who can. Hence the dual-zone velocity curve with ~2.2× flick gain (§4.3) rather than the flat gain tactical shooters tolerate — their engagements are frontal; UT's are not.
4. **Dodge is a first-class input, not a buried gesture.** Two redundant paths (stick double-flick for authenticity; a physical dodge button for reliability under sweat/haste), both writing the same `MoveCommand.dodge` field the keyboard path uses. Onboarding must teach it in the first minute — dodge *is* the UT feel.
5. **Fire is manual and hold-to-auto.** Weapon cooldowns (`fireCooldown` 0.08–0.8 s) already govern rate; hold-to-fire maps perfectly. Auto-fire-on-target (CoD Mobile "Simple mode" [1][2]) is an accessibility option only, default off — UT's identity is that landing shots is the player's achievement.
6. **Aim assist: friction only, touch only, small.** Cross-input fairness matters (phones share servers with mice). Slowdown-on-target compensates the fat-finger precision gap without granting tracking the player didn't perform; no rotational drag, no magnetism (§4.6).
7. **Weapon combos need direct select.** The five-slot bar (§4.5) exists to make shotgun→SMG swaps a single tap mid-dodge — the mobile equivalent of UT's number-key piano.

---

## 4. Concrete control specification (proposed defaults)

All coordinates are CSS pixels in **landscape**, offset by `env(safe-area-inset-*)` exactly as the current stylesheet does. "vmin"-relative sizes scale between phone classes; fixed px values assume the ~640–950 px-wide landscape viewports of current phones.

### 4.1 Region map (default right-handed layout)

```
┌────────────────────────────────────────────────────────────────────┐
│ [FA] [status]                 (HUD, pointer-events:none)  [⚙ 44px] │
│ [HP panel]                                              [AMMO]    │
│                                                                    │
│                    · · · look zone = everything on the             │
│                          right 55% not covered by a button        │
│   MOVE ZONE                                            [JUMP 64]  │
│   (left 45%,                                                       │
│    floating stick)                       [FIRE 96px]   [DODGE 60] │
│        ◯                                 (also drags               │
│                                           look)                    │
│              [ weapon bar: 5 × 48px ]              [RELOAD 52]     │
└────────────────────────────────────────────────────────────────────┘
```

| Element | Placement (CSS, + safe-area) | Size | Behavior |
|---|---|---|---|
| Move zone | `left:0; width:45%; top:15%; bottom:0` | — | floating joystick spawns at touch point |
| Joystick base / knob | at touch point | base `clamp(112px, 16vmin, 140px)`, knob 46% of base | knob clamps to radius = base/2; base stays fixed (no chase) in v1 |
| Look zone | `right:0; width:55%; top:0; bottom:0` (buttons sit above it) | — | relative drag → camera; **fire button also forwards drags here** |
| Fire | `right: 118px; bottom: 96px` | **96 px** ∅ | touchstart = fire down (+ 8 ms haptic); moves while held = look; release = fire up |
| Jump | `right: 26px; bottom: 196px` | 64 px ∅ | hold = held jump (bunny-friendly since `applyCommand` re-jumps on landing while held) |
| Dodge | `right: 26px; bottom: 112px` | 60 px ∅ | tap = dodge in current stick direction (forward if stick neutral); writes `frameState.dodge` |
| Reload | `right: 232px; bottom: 28px` | 52 px ∅ | tap (edge-triggered downstream already) |
| Weapon bar | centered: `left:50%; transform:translateX(-50%); bottom: 20px` | 5 slots × 48 px, 10 px gaps | tap slot = `switchWeapon(i)`; active slot highlighted; shows ammo pips (later) |
| Gear | `top: 12px; right: 12px` | **44 px** ∅ (up from 42) | toggle settings |
| Optional left-fire pad | `left: 18px; top: 18%` | 72 px ∅ | settings toggle, default **off**; for claw/index-finger players |

Spacing rule: ≥ 12 px between any two interactive bounding circles; nothing interactive within the central 50% × 40% of the screen (the aim-read region).

Rationale for the cluster shape: fire sits at the center of the right-thumb arc; jump and dodge stack on the *edge* (thumb-roll targets that don't require leaving fire); reload is deliberately low-value real estate (auto-reload on empty already exists, `applyCommand.js:178-181`). This clears the mid-height right band — the natural start of aim swipes — of everything except the (drag-transparent) fire button.

### 4.2 Left-handed + customization

- `.touch-lefty` body class mirrors every placement (`left ↔ right`), swaps zone widths, and flips the joystick to the right — one CSS class, persisted as `touchLefty` in localStorage.
- Settings sliders: **button scale** ×0.8–1.4 (CSS var `--touch-scale`), **overlay opacity** 15–80% (default: idle 35%, pressed 70%), applied via CSS vars on `#touch-controls`.
- Phase 2: drag-to-place layout editor writing `{id: {right, bottom, size}}` JSON to localStorage; "Reset layout" button.

### 4.3 Look model (the core of the feel)

Definitions: `dx, dy` = per-event finger deltas in CSS px; `dt` = ms between events; camera applies radians.

| Parameter | Default | Notes |
|---|---|---|
| Base gain (yaw) | **0.22°/px** (0.00384 rad/px) | full-width swipe ≈ 186° on an 844 px viewport; ≈ 30% up from today's 0.172°/px |
| Vertical gain | 0.80 × horizontal | pitch already clamped ±89.8° (`Simulator.js:113-119`) |
| Touch sensitivity slider | ×0.4 – ×3.0, default ×1.0, step 0.05 | new `touchSens` localStorage key; the desktop `sens` slider stops affecting touch |
| Dual-zone acceleration | v ≤ 0.4 px/ms → gain ×1.0; linear ramp to **×2.2** at v ≥ 2.5 px/ms; hard cap ×2.2 | velocity measured per event (`dx/dt`), no history; "Look acceleration" toggle, default **on** |
| Smoothing | **none** on touch path | filtering adds latency; precision comes from the low-speed zone, not smoothing |
| Look dead zone | none | first event after touchstart uses distance-from-start (as today) |
| Invert Y | toggle, default off | |
| Effect | slow drag = today's precision or better; a fast 500 px flick ≈ 0.22 × 2.2 × 500 ≈ **242°** | restores UT 180s as a single thumb motion |

Implementation shape: a pure function `applyTouchLook(dx, dy, dt) → {yawRad, pitchRad}` in a new `client/TouchLook.js` (trivially unit-testable), consumed by `TouchControls`; the existing `onmousemove` mouse path is untouched.

### 4.4 Joystick + movement gestures

| Parameter | Current | Proposed | Why |
|---|---|---|---|
| Mode | floating (spawn under thumb) | keep floating; add "fixed position" toggle later | floating self-corrects grip drift |
| Radius | 60 px fixed | `clamp(56, 8vmin, 70)` px | scales small phones ↔ tablets |
| Dead zone | 12 px (20% of radius) | **8 px (~13%)** | faster movement onset; digital output tolerates a small dead zone |
| Direction mapping | 8-way, 22.5° sector edges | keep | matches wire protocol + UT digital feel |
| **Dodge gesture** | — | sector engaged → stick returns below dead zone → same sector re-engaged within **250 ms** → `frameState.dodge = direction` | mirrors keyboard `DOUBLE_TAP_MS = 250` (`InputSystem.js:34`); one consume per re-press, exactly like the key path |
| Out-of-range behavior | knob clamps, tracking continues anywhere (good) | keep | "forgiveness" prevents mid-fight dropouts |

The dodge **button** (§4.1) is the redundant, always-works path: on tap, dodge in the joystick's current sector direction; if the stick is neutral, dodge forward. Both paths feed the same `MoveCommand.dodge` codes (`applyCommand.js DODGE_DIRS`), so server behavior, cooldown (0.35 s) and prediction are already correct.

### 4.5 Fire, weapons, interaction

- **Fire = hold-to-auto** (cooldowns already pace it), fires on `touchstart` (zero added latency), **and forwards its drags to the look model** (B1 fix). No slop radius: firing is intended even for micro-taps.
- **Tap-anywhere-to-fire / auto-fire:** both OFF by default. Auto-fire (fires when crosshair overlaps an enemy) ships as an *accessibility* setting only.
- **Weapon bar:** direct-select tap targets (48 px) for all 5 weapons; active weapon highlighted; keep `⇄` semantics available as a swipe on the bar (left/right = prev/next) for eyes-free cycling. Selecting the already-equipped weapon does nothing (`switchWeapon` already guards, `Simulator.js:127`).
- **Reload:** unchanged semantics (edge-triggered, auto-reload-on-empty stays).
- **No interaction/use key exists in the game** — no button reserved. If pickups arrive later, prefer walk-over auto-pickup (UT99 convention) over a new button.

### 4.6 Aim assist (Phase 2, touch clients only)

- **Type: friction/slowdown only.** When the camera forward ray passes within **3.0°** of the capsule of a *visible, alive* enemy (`client.entities` smooth entities) within 40 m, multiply look gain by **0.72**. Ramp the multiplier linearly from 1.0 at 4.5° to 0.72 at 3.0° (no hard edge). Applies to drag and gyro alike; never to mouse.
- **Explicitly rejected:** rotational assist (tracks for you — antithetical to UT aim pride) and bullet magnetism (server-side fairness violation; server code stays input-agnostic). Taxonomy per Insomniac's GDC 2013 aim-assist talk [12]; friction-only-on-touch matches Critical Ops' shipped policy [10][11].
- Numbers are design judgment to be tuned in playtests; the mechanism (gain multiplier inside `TouchLook`) is the commitment.

### 4.7 Gyro aim (Phase 2/3, optional, off by default)

- `deviceorientation`-rate integration: additive yaw/pitch on top of drag look, `gyroSens` default 1.0 (1° device = 1° camera), slider 0.5–4.0.
- Modes: Off / Always / While-firing (the "while-firing" mode is the low-commitment on-ramp).
- iOS requires a user-gesture permission request (`DeviceOrientationEvent.requestPermission()`, iOS 13+ [36][37]) — wire it to an "Enable gyro" button inside settings; HTTPS already satisfied in production.
- No drift correction needed for rate-based integration; apply the same aim-assist friction multiplier.

### 4.8 Haptics (Android; iOS Safari lacks `navigator.vibrate`)

`vibrate(8)` on fire press exists. Add: dodge launch 12 ms, damage taken 25 ms, death `[40,60,40]`, weapon switch 5 ms, all behind a "Haptics" toggle (default on where supported, hidden where `!navigator.vibrate`).

### 4.9 Visibility & onboarding

- Zones stay invisible; joystick renders only while touched (current behavior — keep).
- Buttons at 35% idle opacity via the opacity setting (§4.2); pressed state 70% + color accent (current active classes already do this).
- First-run overlay (localStorage `touchHintsSeen`): three ghost annotations — "LEFT: MOVE · double-flick = DODGE", "RIGHT: AIM · hold ◉ = FIRE (keep dragging to aim)", "TAP BAR: SWITCH WEAPON" — dismissed by performing each action once or tapping through; never shown again.
- Portrait: full-screen "ROTATE YOUR PHONE 🔄" overlay whenever `(orientation: portrait)` and body has `arena-entered`.

---

## 5. Networking implications of touch input

The command pipeline is already input-source-agnostic (§1.4); the touch redesign requires **zero wire-protocol changes** — dodge, fire, movement all use existing `MoveCommand` fields. Specific implications and recommendations:

1. **Input sampling vs command cadence.** Touch state mutates in event handlers; `Simulator.update()` samples it per rAF and stamps `delta` per command. This is correct and matches desktop. Look rotation applied at event time (not frame time) is fine: the camera ray is snapshotted when the command is built.
2. **120 Hz devices double packet + server-apply rate** (one packet per rAF, §1.4). Recommendation (Phase 2, optional): cap command dispatch at ~60/s — when `delta < 12 ms`, accumulate into the next frame's command (`delta` sums; `applyCommand` clamps at `MAX_DELTA = 1/20` so determinism is unaffected). Halves server collision work for ProMotion iPhones/high-Hz Androids at an imperceptible input cost (≤8.3 ms). Must re-run `verify-netcode.mjs` (10/10) after — prediction ticks still align because predictions are keyed to `client.tick`, which advances per `update()` regardless.
3. **Fire latency budget (tap → server hit check):** touch handler (≈0 ms, `touchstart` latch) → next rAF (≤16.7/8.3 ms) → same-frame packet → RTT/2 → server queue (0–50 ms @ 20 Hz tick) → lag-comp rewind `latency + 100 ms`. Touch parity with mouse is within one frame; the dominant terms (server tick quantization + fixed 100 ms interp assumption) are platform-independent. **Do not add any touch-side debouncing, smoothing, or gesture-recognition delay on the fire path** — every ms there is pure feel damage.
4. **Prediction/reconciliation:** unchanged. The dodge gesture writes the same command field as keyboard; `reconcilePlayer.js` replays are identical. Client-only look modifiers (curve, assist friction, gyro) never reach the wire and cannot desync.
5. **Timestamping note (not touch-specific):** `FireCommand` is empty; the server rewinds by a constant. If hit-reg fairness complaints appear later, carry the firing client tick in `FireCommand` and rewind by measured command age — flagged for the netcode backlog, not this workstream.
6. **Connection-quality UX:** phones roam networks; the existing `connection-*` body classes and entry overlay already handle disconnects. Consider (backlog) a small ping/jitter readout in the mobile HUD (`match-strip`), since touch players can't hover a scoreboard.

---

## 6. Staged implementation plan (repo-specific)

> Effort labels: **QW** = quick win (≤ ~2 h each), **D** = deeper work. No wire-protocol changes anywhere in Phases 0–1; Phase 2 items are also client-only.

### Phase 0 — "Make it UT" (≈ 1 day, all QW)

| # | Change | Files / anchors | Acceptance criteria |
|---|---|---|---|
| 0.1 | **Fire button forwards drags to look.** Extract look-start/move into helpers; call them from the fire button's touch handlers alongside `mouseDown` | `client/TouchControls.js` (`_bindLook`, `_bindButtons`) | Hold fire + drag ≥ 40 px → `camera.rotation.y` changes while `magazineAmmo` decreases; new `verify-mobile` check passes |
| 0.2 | **Touch look retune + separate slider.** Base gain 0.22°/px; `touchSens` localStorage; settings row visible only when `simulator.isTouch`; desktop `sens` no longer multiplies touch | `client/TouchControls.js` (`TOUCH_LOOK_SCALE` → gain fn), `client/Simulator.js:463-493` (`_setupSettingsUI`), `public/index.html:71-83` | scripted 400 px swipe rotates 88° ± 8%; slider persists across reload; mouse path unchanged (`verify-netcode` still green) |
| 0.3 | **Dodge: stick double-flick + button.** Gesture per §4.4 in `_applyJoy`; new button writes `input.frameState.dodge` | `client/TouchControls.js`, CSS `#touch-dodge` | double-flick left within 250 ms → horizontal speed ≥ 10 m/s burst (DODGE_SPEED 11.4 − ε) and `dodgeTimer` cooldown enforced; button dodges in stick direction; keyboard dodge unaffected |
| 0.4 | **Weapon bar (direct select).** 5 slots built in `_buildDom`; taps call `simulator.switchWeapon(i)`; highlight synced in `Simulator._updateHud` (`weaponIndex`); remove/repurpose `⇄` | `client/TouchControls.js`, `client/Simulator.js:407-461`, CSS | tap slot 2 while slot 0 equipped → `currentWeaponIndex === 2` after ≤ 1 gesture; active-slot class matches `weaponIndex`; swap hitch unchanged (GLB cache) |
| 0.5 | **Button geometry per §4.1** (fire 96 px moved up, jump/dodge edge stack, reload demoted, gear 44 px) | `public/css/styles-v0.0.1.css:604-673` | bounding rects: no interactive element intersects the central 50%×40% region; all pairwise gaps ≥ 12 px (assert via puppeteer `getBoundingClientRect`) |
| 0.6 | **Portrait overlay + PWA shell.** `manifest.json` (`display: fullscreen`, `orientation: landscape`), `apple-mobile-web-app-capable` meta, rotate-device overlay. Note: iOS ignores manifest `orientation` (§2.2) — the rotate overlay *is* the iOS orientation story | `public/index.html`, new `public/manifest.json`, CSS | Lighthouse "installable" passes; portrait shows overlay, landscape hides it; standalone launch on iOS home-screen has no browser chrome (manual) |
| 0.7 | **Dead-state fix:** keep look zone + gear interactive while dead (drop `player-dead` from the hide rule; optionally dim buttons) | `public/css/styles-v0.0.1.css:552-557` | while `player-dead`, look drag still rotates camera; settings reachable |

### Phase 1 — "Make it feel right" (1–2 days, D)

| # | Change | Files / anchors | Acceptance criteria |
|---|---|---|---|
| 1.1 | **Pointer Events migration**: `pointerdown/move/up/cancel` + `setPointerCapture`, `getCoalescedEvents` for look deltas; delete Touch Events code; keep `isTouchDevice` mount gate but branch per-pointer on `pointerType` | `client/TouchControls.js` (full rewrite of bindings), `client/InputSystem.js:109-124` (already `pointerType`-aware — verify no double-handling) | all `verify-mobile` checks green (puppeteer touch emits pointer events); mid-drag `pointercancel` (simulated) releases stick/fire cleanly; desktop mouse unaffected |
| 1.2 | **`TouchLook.js` module**: dual-zone curve (§4.3), invert-Y, accel toggle; unit-testable pure function | new `client/TouchLook.js`, `client/TouchControls.js` | fast-swipe (2.5 px/ms) total rotation ≥ 1.9× slow-swipe (0.3 px/ms) same-distance rotation; toggle off → ratio 1.0 ± 5% |
| 1.3 | **Left-handed mirror + scale/opacity settings** (§4.2) | CSS (`.touch-lefty`, CSS vars), `client/Simulator.js` settings UI, `client/TouchControls.js` | lefty flips zones & cluster (rect assertions); vars persist; WCAG-ish: all targets ≥ 44 px at min scale |
| 1.4 | **Haptics set + toggle** (§4.8) | `client/TouchControls.js`, `client/Simulator.js:431-447` (hit/death hooks) | vibrate called with expected patterns (spy in harness); toggle suppresses all |
| 1.5 | **Onboarding hints** (§4.9) | `client/TouchControls.js` DOM, CSS | shows once per fresh localStorage; each hint dismisses on its action; never blocks input |
| 1.6 | **Test-harness expansion** (matrix §7) | `scripts/verify-mobile.mjs` | new checks all pass headlessly in CI-ish run |

### Phase 2 — "Competitive polish" (2–4 days, D)

| # | Change | Files / anchors | Acceptance criteria |
|---|---|---|---|
| 2.1 | **Aim-slowdown assist** (§4.6): enemy angular proximity from `client.entities` smooth entities; gain multiplier into `TouchLook`; touch-only | `client/TouchLook.js`, `client/Simulator.js` (expose enemy iterator) | scripted strafing-bot test: crosshair-within-3° frame count improves ≥ 20% vs assist-off; zero effect when `!isTouch` |
| 2.2 | **Gyro aim** (§4.7) with iOS permission flow | new `client/GyroLook.js`, settings UI | on-device: enabling prompts once, camera follows device rotation additively; Off/Always/While-firing honored; no effect where API unavailable |
| 2.3 | **Command cadence cap for >60 Hz** (§5.2) | `client/Simulator.js:184-215` | at emulated 120 Hz, packets/s ≤ 65 while `verify-netcode` 10/10 and `verify-movement` stay green |
| 2.4 | **Layout editor** (drag buttons in settings mode; localStorage JSON; reset) | `client/TouchControls.js`, CSS | positions persist & clamp to safe areas; reset restores §4.1 defaults |

Dependencies: 1.2 before 2.1/2.2 (both consume the look pipeline); 1.1 before 2.4 (capture semantics). Everything in Phase 0 is independent and shippable piecemeal.

---

## 7. Test matrix

### 7.1 Automated (extend `scripts/verify-mobile.mjs`; run against dev server, and `FRAG_URL` for prod smoke)

| # | Check | Pass criterion | Phase |
|---|---|---|---|
| A1 | overlay mounts on coarse-pointer touch device | existing | — |
| A2 | joystick drag moves predicted player | existing (`moved > 1`) | — |
| A3 | look drag rotates camera | existing (`dRot > 0.05`) | — |
| A4 | fire tap consumes ammo | existing | — |
| A5 | jump leaves ground | existing (`apexY > 0.3`) | — |
| A6 | no uncaught page errors + clean harness completion | existing (2 checks; 7 total today) | — |
| A7 | **fire-drag aims**: hold fire, drag 120 px → ammo down AND `|Δrotation.y| > 0.2` | new | 0.1 |
| A8 | **look calibration**: 400 px horizontal swipe → 88° ± 8% yaw at default `touchSens` | new | 0.2 |
| A9 | **dodge gesture**: push-release-push left ≤ 250 ms → horizontal speed ≥ 10 m/s within 3 ticks; repeat within 0.35 s does NOT re-dodge | new | 0.3 |
| A10 | **dodge button**: stick held right + dodge tap → velX burst sign matches right | new | 0.3 |
| A11 | **weapon bar**: tap slot k → `currentWeaponIndex === k`; highlighted slot matches | new | 0.4 |
| A12 | **geometry**: pairwise button gaps ≥ 12 px; nothing interactive in central 50%×40%; all targets ≥ 44 px | new | 0.5 |
| A13 | **portrait overlay** visible at 375×812, hidden at 812×375 | new | 0.6 |
| A14 | **dead-state**: force `player-dead` → look drag still rotates | new | 0.7 |
| A15 | **pointercancel** mid-drag → stick releases (player decelerates), no stuck fire | new | 1.1 |
| A16 | **curve ratio**: fast vs slow same-distance swipe ≥ 1.9×; toggle off → ≈ 1.0 | new | 1.2 |
| A17 | **lefty mirror**: rects flip across vertical centerline | new | 1.3 |
| A18 | **sens persistence**: set `touchSens`, reload, value retained & applied | new | 0.2 |
| A19 | **assist**: strafing-target script, assist on vs off crosshair-on-target frames ≥ +20% | new | 2.1 |
| A20 | **packets/s ≤ 65** under 120 Hz emulation (count `websocket.send` via page hook) | new | 2.3 |
| A21 | regression: `verify-netcode.mjs` 10/10, `verify-movement.mjs`, `verify-viewmodel.mjs` all green after each phase | gate | all |

### 7.2 Manual on-device matrix (each cell: core loop = move+aim+fire+dodge+switch for 5 min)

| Device class | Example | Browser(s) | Special checks |
|---|---|---|---|
| Small iPhone | SE 3rd gen (667×375 pts) | Safari | reachability at min sizes; weapon bar fits between clusters |
| Notched 120 Hz iPhone | 15/16 Pro | Safari + installed PWA | safe-area insets; ProMotion input smoothness; standalone fullscreen; edge-swipe interference in-browser vs PWA |
| Mid Android | Pixel 7a / Galaxy A-series | Chrome | `navigator.vibrate` patterns; orientation lock actually engages in fullscreen |
| Flagship Android high-Hz | Galaxy S24/S25 | Chrome + Samsung Internet | 120 Hz cadence cap (2.3); Samsung Internet quirks |
| Tablet | iPad / mid Android tablet | Safari / Chrome | zone proportions at ≥ 1000 px width; button scale slider utility |

Per-device checklist: (a) 4 simultaneous touches (stick + look + jump + fire) all register; (b) no browser gesture (back-swipe, pull-refresh, double-tap zoom, long-press menu) triggers during 5 min of violent play; (c) fullscreen/PWA path; (d) thermal/perf after 15 min (input stays responsive); (e) haptics where supported; (f) gyro flow incl. iOS permission (Phase 2).

### 7.3 Feel acceptance (human, definition of "UT on a phone")

- 180° turn in **≤ 2 thumb swipes** (target: 1 flick) at default settings.
- Dodge success ≥ **9/10** deliberate attempts by a first-session player after onboarding.
- Simultaneously strafe + track a moving target + hold fire + jump — sustained for 10 s without finger reset.
- Zero accidental weapon discharges or menu opens in a 5-minute session.
- A competent touch player kills a stationary-target course within ~1.5× of their own desktop time (aspirational parity metric).

---

## 8. Design traps (how this stays UT99 and not a generic mobile shooter)

1. **Shipping auto-fire as default.** Instantly converts aim-duels into positioning-only play and cheapens every frag. Keep it an accessibility opt-in. (CoD Mobile isolates auto-fire in "Simple mode"; competitive guidance uniformly points players to manual "Advanced mode" [1][3].)
2. **Fixing sluggish aim with more sensitivity instead of a curve.** Flat high gain destroys micro-aim; flat low gain destroys 180s. The dual-zone curve is the only way to get both; smoothing is *not* — it converts precision loss into latency loss.
3. **Adding buttons for mechanics the game doesn't have** (ADS, sprint, crouch, prone). Every extra button shrinks and displaces the three that matter. UT's no-ADS always-run design is a mobile *advantage* — guard it.
4. **Burying dodge in settings or making it gesture-only.** If dodge is unreliable or undiscovered, mobile players are playing a slower game than desktop players on the same server. Two input paths + onboarding, or the UT identity is desktop-only.
5. **Aim assist creep.** Rotational assist or magnetism makes tracking feel authored and poisons cross-input trust. Friction-only, small, touch-only, and *published* in the settings copy ("slows your aim over enemies — never aims for you").
6. **Letting the fire button eat aim** (status quo) — or its inverse trap, tap-anywhere-fire as default, which turns every aim adjustment into a gunshot. Fire button = look surface is the narrow correct path.
7. **Designing for the browser tab instead of the PWA** on iOS: no element fullscreen exists there; edge swipes and the home indicator will always menace a browser-tab session. Inset interactive elements from screen edges (safe-area + ≥ 12 px), and make Add-to-Home-Screen a promoted, rewarded path — not a footnote.
8. **Trusting emulated touch for feel decisions.** Puppeteer validates logic, not latency or thumb ergonomics. Every tuning number in §4 gets final values only from on-device play (§7.2/7.3).
9. **Smoothing/deferring fire input** (gesture recognizers, debounce, "confirm" animations). The fire path must stay `touchstart → state latch → next frame command`. Any added stage is directly visible as hit-reg feel damage on a 20 Hz-tick server.
10. **HUD/controls clutter erasing the game's violence.** The arena, tracers and gore are the product; controls idle at ≤ 35% opacity, zones stay invisible, and nothing interactive enters the central sightline. If a screenshot reads "mobile UI demo" instead of "gunfight", back up.

---

## 9. Sources

All URLs below were fetched and content-verified on **2026-07-12** unless flagged otherwise. Labels: **PRIMARY** = official vendor/spec/original publication; **SECONDARY** = reputable third party; **WIKI/FORUM** = community sources, used only where explicitly labeled in §2; **ACADEMIC** = peer-reviewed or university-published research.

### Genre conventions & aim assist

1. Activision, "Getting a Grip on the Call of Duty: Mobile Controls" (official blog, Oct 2019) — https://blog.activision.com/call-of-duty/2019-10/Getting-a-Grip-on-the-Call-of-Duty-Mobile-Controls — PRIMARY. Simple vs Advanced fire modes; layout editor (drag/drop/size/opacity); gyroscope incl. ADS-only mode; sensitivity submenu.
2. Gamepressure, "Call of Duty Mobile: Controls" — https://www.gamepressure.com/call-of-duty-mobile/controls/zbcb15 — SECONDARY. Simple mode auto-fires when crosshair covers an enemy; Advanced adds a manual fire button.
3. Dot Esports, "The best Call of Duty: Mobile settings" (updated Nov 2023) — https://dotesports.com/call-of-duty/news/the-best-call-of-duty-mobile-settings — SECONDARY. Recommends Advanced mode; lists "Fixed R-Fire BTN" toggle, camera vs firing vs gyro sensitivity split. (Bot-walled to fetchers; content verified via reader proxy.)
4. HardReset.info, "Enable Right Fire Button For Fixed Perspective — CoD Mobile" — https://www.hardreset.info/devices/apps/apps-call-of-duty/enable-right-fire-button-for-fixed-perspective/ — SECONDARY. Documents the in-game toggle described as "combine the function of shooting and aiming," with settings screenshots.
5. PUBG Mobile Help Center (Krafton), "What are the controls?" — https://pubgmobile.helpshift.com/hc/en/3-pubg-mobile/faq/37-what-are-the-controls/ — PRIMARY. Drag-anywhere-without-icons look; tap-to-fire; Customize Buttons entry point.
6. PUBG Mobile Help Center (Krafton), "I want to change the location of the control key" — https://pubgmobile.helpshift.com/hc/en/3-pubg-mobile/faq/280-i-want-to-change-the-location-of-the-control-key/?l=en — PRIMARY. Full control-relocation editor, per-mode layouts.
7. Google Play editorial, "PUBG Mobile: improve your controls" — https://play.google.com/store/apps/editorial?id=mc_editorial_evergreen_post_install_pubg_mobile_improve_your_controls_now_fcp — SECONDARY. Default fire buttons on both sides of the screen; drag-and-drop customization.
8. Google Play editorial, "PUBG Mobile: how to customize your settings" — https://play.google.com/store/apps/editorial?id=mc_games_editorialevergreen_pubg_mobile_how_to_customize_your_settings_postinstall_fcp&hl=en_US — SECONDARY. Tap-vs-release fire option; gyroscope-for-aiming setting; sensitivity guidance.
9. AnswerOverflow (public mirror of the official PUBG Mobile Discord) — https://www.answeroverflow.com/m/1233309586065195009 — FORUM. "Left is always fixed, not affecting the camera. Right is always camera control as well." Sole explicit statement found of the hold-fire-and-drag behavior; weighted accordingly in §2.1.
10. Critical Force, "Input Method Feature Announcement" — https://criticalopsgame.com/news/input-method-feature-announcement/ — PRIMARY. Aim assist disabled for KB+M, increased for controller; official esports touch-only.
11. Critical Ops Support, "Aim Assist" — https://critical-force.theymes.com/hc/en/critical-ops/articles/aim-assist-98 — PRIMARY. "Subtle assistance"; touch assist stays at standard values.
12. Nick Weihs (Insomniac Games), "Techniques for Building Aim Assist in Console Shooters," GDC 2013 — https://www.gdcvault.com/play/1017942/Techniques-for-Building-Aim-Assist (free recording mirror: https://archive.org/details/GDC2013Weihs) — PRIMARY. Camera acceleration/dead zones plus magnetism, centering, and friction assist systems.
13. Halopedia, "Aim assist" — https://www.halopedia.org/Aim_assist — WIKI. Cleanest published distinction between reticle friction (turn-speed slowdown) and bullet magnetism (shot bending).
14. Epic Games, "Gyro aiming and flick stick come to Fortnite in v19.30" — https://www.fortnite.com/news/gyro-aiming-and-flick-stick-come-to-fortnite-in-v19-30-more-controller-options?lang=en-US — PRIMARY. (Bot-walls automated fetchers; content corroborated via [15].)
15. EarlyGame, "Fortnite: gyroscope aim & flick stick explained" — https://earlygame.com/fortnite/gyroscope-aim-flick-stick-enable-explanation — SECONDARY. Gyro as precision layer over stick aim; developed with Jibb Smart; v19.30 platform expansion.
16. I. S. MacKenzie et al. (York University), touch- vs tilt-input study for dual-analog mobile games — https://www.yorku.ca/mack/ec2017.html — ACADEMIC. Touch aiming outperformed tilt; recommends nonlinear gain transfer functions akin to desktop pointer acceleration.

### Web platform

17. W3C, "Pointer Events Level 3" (Recommendation, 30 June 2026) — https://www.w3.org/TR/pointerevents3/ — PRIMARY. Implicit pointer capture for direct-manipulation (touch) pointers; pointerType; capture model.
18. MDN, "Element.setPointerCapture()" — https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture — PRIMARY.
19. MDN, "pointercancel event" — https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event — PRIMARY.
20. MDN, "PointerEvent.getCoalescedEvents()" — https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents — PRIMARY.
21. MDN, "PointerEvent.getPredictedEvents()" — https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getPredictedEvents — PRIMARY.
22. MDN, "PointerEvent.pointerType" — https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pointerType — PRIMARY.
23. W3C, "Touch Events" — https://www.w3.org/TR/touch-events/ — PRIMARY. `touchmove`/`touchend` target the element where the touch started (cite the spec, not MDN's guide, for this).
24. MDN, "touch-action" — https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action — PRIMARY. `none` disables all browser panning/zooming; accessibility warning noted.
25. MDN, "overscroll-behavior" — https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior — PRIMARY.
26. MDN, "EventTarget.addEventListener()" — https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener — PRIMARY. Default-passive `touchstart`/`touchmove` on window/document/body; `{passive:false}` required to `preventDefault`.
27. Chrome for Developers, "Aligning input events" — https://developer.chrome.com/blog/aligning-input-events — PRIMARY. Touch input at 60–120 Hz vs display refresh; `pointermove` aligned to rAF; coalesced events expose full history.
28. MDN, "Window.requestAnimationFrame()" — https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame — PRIMARY. Callback frequency matches display refresh (60/75/120/144 Hz cited).
29. caniuse, "Fullscreen API" — https://caniuse.com/fullscreen — SECONDARY. iOS Safari 12.0–26.5 partial: iPad only, not iPhone; non-disableable overlay button.
30. Apple Developer Forums, thread 770080 (Dec 2024) — https://developer.apple.com/forums/thread/770080 — SECONDARY (Apple-hosted). No supported Fullscreen API path on iPhone Safari.
31. Apple Developer, "HTMLVideoElement.webkitEnterFullscreen" — https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1633500-webkitenterfullscreen — PRIMARY. The video-only fullscreen escape hatch on iPhone.
32. MDN, "Web app manifest: display" — https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display — PRIMARY. `fullscreen` and `standalone` semantics; iOS support per MDN browser-compat-data (Safari iOS 11.3+).
33. MDN, "Web app manifest: orientation" — https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/orientation — PRIMARY. Limited availability; MDN browser-compat-data records Safari/iOS as never supporting it.
34. Apple Developer (archive), "Configuring Web Applications" — https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html — PRIMARY. `apple-mobile-web-app-capable`, `navigator.standalone`, status-bar styling.
35. MDN, "ScreenOrientation.lock()" — https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock — PRIMARY. Mobile + fullscreen requirement; MDN browser-compat-data: `lock()` unsupported in Safari/iOS (caniuse's screen-orientation "supported" reflects the API object only), Chrome Android 38+.
36. MDN, "DeviceOrientationEvent.requestPermission()" — https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static — PRIMARY. Transient-activation (user gesture) + secure context required.
37. WebKit blog, "New WebKit Features in Safari 13" — https://webkit.org/blog/9674/new-webkit-features-in-safari-13/ — PRIMARY. Permission requirement introduced for device orientation/motion on iOS 13.
38. MDN, "Navigator.vibrate()" — https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate — PRIMARY. Sticky-activation requirement; limited availability.
39. caniuse, "Vibration API" — https://caniuse.com/vibration — SECONDARY. No Safari version (iOS 3.2–26.5, desktop through TP) has ever shipped it; Chrome for Android supported.
40. WebKit blog, "Designing Websites for iPhone X" — https://webkit.org/blog/7929/designing-websites-for-iphone-x/ — PRIMARY. `viewport-fit=cover` + `env(safe-area-inset-*)` model.
41. MDN, "env()" — https://developer.mozilla.org/en-US/docs/Web/CSS/env — PRIMARY.
42. MDN, "Viewport meta element" — https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Viewport_meta_element — PRIMARY. iOS 10+ ignores `user-scalable` by default; zoom-disabling accessibility warning.

### Ergonomics & accessibility

43. Apple, Human Interface Guidelines — "Buttons" — https://developer.apple.com/design/human-interface-guidelines/buttons — PRIMARY. "A button needs a hit region of at least 44x44 pt." (Verified via the page's JSON content endpoint; HTML shell is JS-rendered.)
44. Apple, "UI Design Dos and Don'ts" — https://developer.apple.com/design/tips/ — PRIMARY. "Create controls that measure at least 44 points x 44 points."
45. Google, Android Accessibility Help — "Touch target size" — https://support.google.com/accessibility/android/answer/7101858 — PRIMARY. "At least 48x48dp, separated by 8dp of space or more" (citing Material Design accessibility guidance; the m2.material.io page itself is JS-rendered and was not directly verifiable).
46. W3C, "Understanding SC 2.5.5: Target Size (Level AAA)," WCAG 2.1 — https://www.w3.org/WAI/WCAG21/Understanding/target-size.html — PRIMARY. 44×44 CSS px.
47. W3C, "Understanding SC 2.5.8: Target Size (Minimum) (Level AA)," WCAG 2.2 — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html — PRIMARY. 24×24 CSS px.
48. W3C, "Understanding SC 2.5.1: Pointer Gestures (Level A)," WCAG 2.1 — https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures.html — PRIMARY. Path-based gestures require single-pointer alternatives.
49. W3C, "Understanding SC 2.5.4: Motion Actuation (Level A)," WCAG 2.1 — https://www.w3.org/WAI/WCAG21/Understanding/motion-actuation.html — PRIMARY. Motion-operated functions must have UI equivalents and be disableable.
50. Steven Hoober, "How Do Users Really Hold Mobile Devices?", UXmatters, Feb 2013 — https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php — PRIMARY (original publication of the 1,333-observation field study). 49% one-handed / 36% cradled / 15% two-handed; thumb-reach maps.
51. A. Ng, J. Lepinski, D. Wigdor, S. Sanders, P. Dietz, "Designing for Low-Latency Direct-Touch Input," UIST 2012 — https://www.tactuallabs.com/papers/designingLowLatencyDirectTouchInputUIST12.pdf (author-hosted; ACM DOI 10.1145/2380116.2380174) — ACADEMIC/PRIMARY. Dragging latency JND mean 6.04 ms (2.38–11.36 ms); commodity devices respond in 50–200 ms.
52. J. Deber, R. Jota, C. Forlines, D. Wigdor, "How Much Faster is Fast Enough?", CHI 2015 — https://tactuallabs.com/papers/howMuchFasterIsFastEnoughCHI15.pdf — ACADEMIC/PRIMARY. Tapping latency JND ≈ 69 ms (vs ~11 ms dragging in their measures) — taps tolerate far more latency than drags.

### Unreal Tournament 1999

53. Epic Games / GT Interactive, *Unreal Tournament* official manual (Internet Archive scan; full text available) — https://archive.org/details/manual_Unreal_Tournament — PRIMARY. "You can dodge by tapping a movement key twice in any direction"; Dodging toggle in Options; Walk as held modifier (Shift); weapons on number keys.
54. Unreal Wiki (Fandom), "Dodging" — https://unreal.fandom.com/wiki/Dodging — WIKI. Double-press movement key; small upward + medium horizontal momentum. (Verified via the MediaWiki API; page HTML is bot-walled. beyondunreal.com wikis were Cloudflare-blocked and are not cited.)
55. GameSpot, *Unreal Tournament* Game Guide (Internet Archive — note: archived under the item name "Unreal_Tournament_Manual" but is the GameSpot guide, not the manual) — https://archive.org/details/Unreal_Tournament_Manual — SECONDARY. Expert play "switches weapons frequently"; keybinds built for fast switching.
56. Slipyx/UT99 (GitHub), community mirror of the UT99 UnrealScript source — https://github.com/Slipyx/UT99 ; specifically `Botpack/TournamentPlayer.uc` (`GroundSpeed=400`) and `Engine/PlayerPawn.uc` (`Dodge()`: `Velocity = 1.5*GroundSpeed*X`, `Velocity.Z = 160`; `DodgeClickTime = FMin(0.3, …)`) — SECONDARY (community-mirrored game source, not official Epic documentation).

**Source-verification notes.** One relevant official page went dead before access: PUBG Mobile's gyroscope FAQ (helpshift FAQ 486) now 404s; PUBG gyro claims in §2.1 rest on [8] instead. Bot-walled-but-corroborated URLs are flagged inline above ([3], [14], [43], [54]). No source in this list was cited beyond what its fetched content states.

---

*Report generated 2026-07-12. No game source files, package files, bundles, or production systems were modified in this task.*
