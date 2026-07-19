# Pre-Migration BASELINE — Frag Arena

**Captured:** 2026-07-19 ~14:33–14:44 (server-local)
**Branch:** `upgrade/babylon9-vite` (no migration changes applied yet)
**Stack (baseline):** Babylon.js **4.0.3**, webpack **4.41.1**, no Vite. Node 22.23.0.
**Purpose:** Reference snapshot to diff post-migration phases against. Failures below are PRE-EXISTING on the current webpack + Babylon 4 build and MUST NOT be blamed on the migration.

## IMPORTANT environment note (how this baseline was run)
Ports 8080 and 8079 were **already occupied** by a dev environment another session started
(pid 413847 = `webpack-dev-server --config webpack.dev.js`, up ~11h; pid 527912 = `tsx server/serverMain.js`, up ~3h),
both cwd `~/unreal`, same branch. Per instructions I did **not** kill processes I did not start.
The browser verify + in-game screenshot scripts were therefore run **against that pre-existing dev environment**
(webpack-dev-server :8080, game server :8079). I started **no** long-lived servers of my own, so there was nothing of mine to kill at cleanup. The screenshot scripts that spin their own short-lived HTTP servers (ports 8095/8097) exited cleanly; no stray listeners remain.

Caveat: because the game server (:8079) runtime state was controlled by that other session, its **bot config is out of my control** — see `verify:bots`.

## Prod build
- `npm run build` (webpack.prod.js, openssl-legacy-provider) → **EXIT 0**, only standard webpack size-limit WARNINGS, no errors.
- **Bundle: `public/js/app-v0.0.1.js` = 2,746,581 bytes (2.62 MiB)** — byte-identical across two consecutive builds (deterministic).
- BUILD_ID stamped `0.0.1-9a93abfc8b` (13 assets hashed).

## Verify suite results

| # | Script | Result | Exit | Key line / failing checks |
|---|--------|--------|------|---------------------------|
| 1 | `verify` (netcode) | **FAIL 7/9** | 1 | FAIL: "A sees new player after B joins" (2->2); "A sees B move (replication + interpolation)" |
| 2 | `verify:movement` | **FAIL 5/8** | 1 | FAIL: "jump leaves the floor" (apex -23.12m); "jump apex is UT-ish (~1m)"; "dodge hops off the floor" (hop -24.20m) |
| 3 | `verify:1v1` | **FAIL 11/12** | 1 | FAIL: "respawned player shoots back and lands damage" (p1 hp 100, want 85) |
| 4 | `verify:bots` | **FAIL 1/5** | 1 | 0 AI player entities present ("0 other player entities"); bots move/fire/damage all fail. Likely no bots spawned on the pre-existing server (runtime state not controlled by me). |
| 5 | `verify:scifi` | **FAIL (TIMEOUT)** | 1 | TimeoutError 30000ms at waitForFunction `document.body.classList.contains("arena-entered")` after clicking #enter-arena. Earlier waits (connect, myRawEntity, enter-arena button enabled) PASSED. |
| 6 | `verify:viewmodel` | **FAIL 7/10** | 1 | FAIL: "rapid swaps do not leak GPU resources" (materials 413->414, textures 65->68); "interleaved mid-import swaps leave exactly one visible rig" (2 rigs); "random-cadence soak settles to one visible weapon-0 rig" |
| 7 | `verify:fx` | **FAIL 18/19** | 1 | FAIL: "rifle: muzzle light pulses when firing" (peak 1.94 over preset 1.7) |
| 8 | `verify:fire` | **FAIL 9/10** | 1 | FAIL: "rifle: hand back on the gun after the burst" (settled 32.25cm vs idle 65.92cm) |
| 9 | `verify:anim` | **FAIL 19/20** | 1 | FAIL: "Shotgun: support hand rides the gun through fire" (fire spread 13.92cm). (Ran fine; GLB/anim checks otherwise pass.) |
| 10 | `verify-map.ts` (offline) | **PASS** | 0 | "ALL MAPS PASS" — all 4 maps, 12/12 checks (view-box, spawns, jump pads) |
| 11 | `verify-meshmap.ts` (offline) | **PASS by exit (diagnostic ✗)** | 0 | Babylon v4.0.3 Null engine. Diagnostic prints "dominant floor ~y=6 (8 hits). sparse — probably wrong orientation ✗" but the script exits 0 (it's a probe, not a gated test). |

**Summary:** 2 of 11 pass by exit code (`verify-map.ts`, `verify-meshmap.ts`). The 9 browser verify scripts all exit non-zero today, each due to one or a few specific pre-existing check failures (not total breakage — most are 7/9…19/20). `verify:bots` (1/5) and `verify:scifi` (timeout) are the two systemic ones and are influenced by the pre-existing server's runtime state.

## Visual goldens

Saved to `backups/upgrade-20260719-1425/baseline-shots/` (14 PNGs, 1280x720 unless noted):

**Standalone OBJ-map renders (own Babylon 4.0.3 page, WebGL2/swiftshader):**
- `grove-persp.png`, `grove-top.png` — DM-W-Grove OBJ (from shot-objmap.mjs)
- `visage-persp.png`, `visage-top.png` — CTF-Visage OBJ (from shot-visage.mjs)

**Viewmodel renders (real client, public/ build, from render-shot.mjs):**
- `rifle-hip.png`, `rifle-ads.png`, `pistol-hip.png`, `pistol-ads.png`

**In-game arena renders (live :8080 real renderer, from shot-map.mjs):**
- `ingame-map-eye.png`, `ingame-map-eye2.png`, `ingame-map-overview.png`,
  `ingame-natural-spawn.png`, `ingame-grotto.png`, `ingame-torch-hall.png`

Note: the in-game renderer (shot-map.mjs) worked with **no errors**, confirming the live arena renders fine — so `verify:scifi`'s failure is specifically the `arena-entered` class not being set within 30s, not a general render failure.

## Logs (on server, /tmp)
Build: `/tmp/baseline-build.log`. Verify: `/tmp/v-*.log`. Screenshots: `/tmp/s-*.log`.
