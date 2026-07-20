# Slope-slide + sunken-body handoff (Visage "strong gravity")

**Status: fix implemented and measurably working, NOT verified against the regression
suite, NOT committed, NOT deployed.** Read "What's left" before touching anything.

Branch: `upgrade/babylon9-vite` @ `5be8390`. All work below is UNCOMMITTED working-tree
changes on EchoPrime in `~/unreal`.

---

## The two bugs

The user reported: *"Some maps like Visage have very strong gravity. You get pulled down
the slope and you kinda slide."* Then, while investigating: *"this actually hits another
bug where the player is knees deep into the floor of the map."*

They turned out to be independent bugs that happen to share the collision-anchor
convention (the sim anchors a player at the **centre** of a 1-unit box / r=0.5 ellipsoid,
so the collision bottom is `entity.y - 0.5`).

### Bug 1 — sunken bodies (client-visual only)

`client/assets/assetManifest.js` `playerBody.yOffset` was `-1.0`. That value was tuned
for the BOX ARENAS, where `arenaDressing.js:17` deliberately draws the visual floor at
`GROUND_Y = -1`, half a metre BELOW the collision bottom (-0.5). The extra -0.5 hid that
gap.

Mesh maps (CTF-Visage, DM-W-Grove) use ONE mesh as both visual and collision floor, and
`CharacterModel` applied `spec.yOffset` unconditionally — no `USE_MESH_MAP` branch existed
anywhere in the client. So on Visage: feet landed at `floorY + 0.5 - 1.0 = floorY - 0.5`,
and the body (~1.05 units tall) stood buried half a metre — knee/waist deep.

Worth knowing: this is not purely cosmetic in perception terms. The replicated hitbox
spans `floorY .. floorY+1` while the visible body spanned `floorY-0.5 .. floorY+0.55`, so
the top half of the real hitbox was empty air above the visible model and the visible legs
were unhittable.

### Bug 2 — the slope slide (shared sim)

Gravity is a single global `GRAVITY = 18`; there is no per-map gravity anywhere. The
"strong gravity" was emergent, from a feedback loop in `common/applyCommand.js`:

1. Gravity put -0.45 m/s into `velY` every tick **even while grounded**.
2. The single combined `moveWithCollisions(velX, velY, velZ)` let collide-and-slide
   project that downward move along the slope → downhill HORIZONTAL displacement.
3. `velX = (x - oldX) / delta` (the wall-absorption re-derivation) promoted that
   displacement into real, persistent horizontal momentum, which fed step 2 harder next
   tick.
4. Once downhill creep passed ~1.13 m/s, the old grounded test — which measured TOTAL y
   movement, so horizontal speed on a slope contaminated it — flipped to airborne,
   switching ground friction OFF entirely. Nothing was left to oppose the slide.

This was diagnosed by the id-persona consult (see below) and then confirmed with real
measurements on the real mesh.

---

## What was changed

### `common/applyCommand.js` — the real fix

Added two constants (`MIN_WALK_NORMAL = 0.7`, Quake III's value ≈45.6°; `STEP_DOWN = 0.35`)
and replaced the single combined move with **three phases**. All heavily commented in
place — read the code, it explains the mechanism.

- **Phase 1, horizontal.** `moveWithCollisions(velX*dt, 0, velZ*dt)`. Only this phase
  feeds the velocity re-derivation, so wall absorption behaves exactly as before but
  gravity's slope deflection can no longer be promoted into momentum.
- **Phase 2, vertical.** `moveWithCollisions(0, velY*dt, 0)`. If the move was cut short,
  ask `entity.mesh.collider.slidePlaneNormal` what we landed on:
  - `|normal.y| >= MIN_WALK_NORMAL` → **walkable floor**: restore pre-move x/z (discarding
    the sideways deflection, which IS the phantom slide), set grounded, zero velY.
  - below the limit → **steep face**: KEEP the deflection as momentum so steep faces shed
    you with real speed instead of sticking; stay airborne.
- **Phase 3, snap-to-ground.** If we entered the tick grounded, aren't jumping/dodging,
  and phase 2 left us airborne, probe down `STEP_DOWN`; glue to walkable floor if found,
  otherwise fully restore x/y/z and fall (Visage floats — walking off an edge MUST kill).

**Why not a raycast:** the consult prescribed `scene.pickWithRay` and an added `scene`
parameter. That would have broken determinism — `client/reconcilePlayer.js:18` calls
`applyCommand(entity, command)` with **no third argument**, so `scene` would be `undefined`
on every reconciliation replay and prediction would desync from the server. (The existing
third arg `obstacles` passed at `Simulator.js:985` / `GameInstance.js:225,827` is already
vestigial — `applyCommand` only declares `(entity, command)`.) `collider.slidePlaneNormal`
and `collider.collisionFound` are public getters in Babylon 9.17 and come from the
collision we already perform, so the function stays pure. **Keep it that way.**

Also touched: the `!USE_MESH_MAP` `GROUND_Y` clamp now sets `grounded`/zeroes `velY` when
it catches a falling player, since the clamp bypasses phase 2's grounding. **This is the
least-tested edit in the change — box arenas were not re-verified at all.**

### `client/assets/assetManifest.js` + `client/graphics/CharacterModel.js` — the sink fix

Manifest `playerBody` now carries both offsets, commented with the floor reasoning:
`yOffset: -1.0` (box arenas) and `yOffsetMeshMap: -0.5` (mesh maps).

`CharacterModel.js` imports `USE_MESH_MAP` from `common/mapMesh` and resolves via a
module-level helper `bodyYOffset(spec)`, used at both `holder.position.set` sites (the
corpse-mode early return and the normal path). Falls back to `spec.yOffset` when a spec
predates `yOffsetMeshMap`. The overhead nametag projects from `holder.position.y + 1.4` so
it follows automatically.

### New tooling (all new files, none committed)

- `scripts/gemini-id-movement.mjs` — sibling of `gemini-id.mjs`. Same fictional id
  engineer persona ("Randall 'Hitscan' Voss") but retooled from recoil to movement
  physics: ground traces, slope clipping, friction, snap-to-ground, and the determinism
  constraints of a predicted netcode sim. Same Gemini 3.5-flash call, same key loading
  from `~/solSoccer/.env`, same 503/429 retry. Usage:
  `node scripts/gemini-id-movement.mjs <brief.txt> [img.png ...]`
- `scripts/briefs/brief-visage-gravity.txt` — the brief that produced the diagnosis
  (real movement code + map facts + the determinism constraints + 5 specific questions).
- `scripts/probe-slope-slide.ts` — **the regression test.** Loads the real active
  `MAP_MESH` into a NullEngine scene exactly as the server does, finds standable spots
  around the map spawns, measures local slope by 3-probe plane fit, then runs the REAL
  `applyCommand` for 3s of stand-still and 2s of holding W. Reports drift, end speed,
  grounded duty cycle, airborne runs. Asserts only on walkable spots. Exit 0/1.
  `npx tsx scripts/probe-slope-slide.ts`
- `scripts/trace-spot.ts` — tick-by-tick trace of one spot, prints x/y/z, velocities,
  grounded, and the live collider normal.y.
  `SPOT_X=.. SPOT_Y=.. SPOT_Z=.. npx tsx scripts/trace-spot.ts`

---

## Measured results (real CTF-Visage mesh, 40Hz, stand still 3s)

| slope | normalY | drift BEFORE | drift AFTER | grounded% before → after |
|---|---|---|---|---|
| 15.3° | 0.964 | 0.175 m | **0.000 m** | 100% → 100% |
| 19.6° | 0.942 | 0.320 m | **0.000 m** | 100% → 100% |
| 20.5° | 0.937 | 0.251 m | **0.000 m** | 100% → 100% |
| 25.9°* | 0.899* | 3.093 m | 1.300 m | 33% → 13% |
| 60–80° (walls) | 0.16–0.50 | slides | slides | *correct — these are walls* |

Walkable ground is fixed: dead stop, no drift, no grounded flicker. Before the fix the
worst walkable case drifted 3.09 m in 3 s while grounded only 33% of ticks — exactly the
friction duty-cycling the consult predicted.

\* **This row is the open question — see below.**

---

## What's left

### 1. Resolve the one remaining spot @ `-31.13, -18.24, -2.01` (probably a probe bug)

`probe-slope-slide.ts` classifies it as 25.9° / normalY 0.899 → walkable → so it fails the
assertion. But `trace-spot.ts` at that exact spot shows the collider reporting
**`normal.y = 0.648` consistently**, which is BELOW `MIN_WALK_NORMAL = 0.7` — so the sim is
correctly treating it as a non-walkable face and sliding, and the *probe's* classification
is what's wrong.

The probe's `slopeAt()` fits a plane through three drop-probes 0.6 m apart; that triangle
almost certainly straddles a step or discontinuity there (the spot also "sank -22.61 m",
i.e. the player leaves the deck entirely). **Most likely fix is to the probe, not the sim:
take the slope from the collider normal like the sim does, rather than a 3-point fit.**

Verify that before changing any sim constant. But two things genuinely worth a look while
you're there:

- 0.648 is close enough to the 0.7 limit that this could be a real ramp players would be
  annoyed to slide down. Look at what that geometry actually is. If it's a legitimate
  walkable ramp, the lever is `MIN_WALK_NORMAL` (0.65 ≈ 49.5° would admit it) — but that
  loosens walkability everywhere, so confirm the geometry first.
- The trace shows a residual creep on that near-limit surface: ticks 22–24 hold a *constant*
  `velX=-0.076, velZ=0.131` (~0.15 m/s) while grounded, instead of decaying under
  `FRICTION = 8`. Cause: phase 1's horizontal move is itself deflected down-slope by
  collide-and-slide, and that deflection IS promoted by the re-derivation (by design — it's
  the wall-absorption path). It's negligible on gentle slopes (measured 0.000 m) but not
  near the walk limit. If it matters, the Quake answer is to clip phase 1's re-derived
  velocity against the ground plane normal too.

### 2. Regression suite — none of it has been run

- **`scripts/golden-collision.ts` is the important one.** It records full per-tick
  trajectories for every map as a bit-sensitive baseline, and the two-phase move
  *deliberately changes trajectories*, so it WILL diff. Someone has to run
  `golden-collision-diff.mjs` and confirm every difference is explained by this fix rather
  than by an unintended tunnelling/resting change. Do not blanket-regenerate the baseline
  without reading the diff.
- `scripts/verify-map.ts`, `scripts/verify-meshmap.ts`, `scripts/verify-movement.mjs`
  (needs `npm start` running in another terminal), `scripts/verify-bots.mjs`,
  `scripts/verify-netcode.mjs` — all unrun.
- **Box arenas are entirely unverified** (`USE_MESH_MAP` is currently `true`, so both the
  probe and every measurement above only exercised the mesh-map path). The `GROUND_Y`
  clamp edit specifically needs a box-arena run — flip `MAP_MESH` in `common/mapMesh.js`
  or use the box-arena maps in `common/maps/`.
- **Jump-pads**: `arenaConfig.JUMP_PADS` fire on a grounded check that now comes from the
  new grounding path. Facing Worlds tower lifts are a Visage feature — worth an explicit
  test that they still launch.
- **Dodge**: phase 3 is gated on `!command.dodge`, but dodge also sets `grounded = false`
  and `velY = DODGE_UP` before the move. Confirm dodges still clear the floor properly.

### 3. Client-visual confirmation of the sink fix

Not done. `scripts/shot-visage-ingame.mjs` and `scripts/shot-visage.mjs` exist for exactly
this. Feet should now sit ON the deck. Check corpses too (the corpse-mode early return uses
the same helper), and other players' bodies rather than just the local view.

### 4. Ship

Nothing committed. The working tree also carries unrelated in-flight work (texture
remaster, `maps/`, `public/dev/`, `upgrade/*` probes) — **stage selectively**, don't
`git add -A`. Deploy to `/var/www/frag-arena` on zec-sol goes through EchoPrime as usual.

---

## Notes for whoever picks this up

- The consult transcript is not saved to a file — only the brief is. Re-run
  `node scripts/gemini-id-movement.mjs scripts/briefs/brief-visage-gravity.txt` to
  regenerate it (non-deterministic, temperature 0.7). Its diagnosis was accurate; its
  prescribed *implementation* (scene raycast, added parameter) was not adopted, for the
  determinism reason above. If you consult it again, tell it `applyCommand` must stay
  `(entity, command)`.
- Determinism is the hard constraint on everything here: same entity state + same command
  in, same result out, on client prediction, server authority, AND reconciliation replay.
  No wall-clock, no randomness, no render-frame data, no scene handles.
- `MIN_WALK_NORMAL` and `STEP_DOWN` are the two tuning levers, both commented at their
  definitions with the arithmetic behind the chosen values.
