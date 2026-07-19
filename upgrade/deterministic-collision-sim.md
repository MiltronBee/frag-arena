# Roadmap: Own the collision/movement sim (deterministic, engine-independent)

> **Status:** PLANNED — the **next** major engineering project **AFTER** the Babylon 9 + Vite migration ships.
> **Do NOT start this before the migration.** Entry criteria at the bottom. Origin: the §11 senior-programmer consult in `upgrade/upgrade.md`.
> **Produced:** 2026-07-19.

## 1. One-line summary
Replace Babylon's `mesh.moveWithCollisions()` — currently the heart of our authoritative movement, shared by client prediction and server — with a small, purpose-built **collide-and-slide** solver we own, so gameplay physics is (a) independent of the renderer/its version, (b) identical code on both sides, and (c) cheaper.

## 2. Why (accurate framing — we are NOT broken today)
Our movement lives in `common/applyCommand.js` and runs on **both** the client (prediction) and the Node server (authoritative, under Babylon `NullEngine`); nengi replays it for reconciliation. Today it works — the verify suite reports **zero reconciliation errors** — precisely *because* both sides run the identical Babylon `moveWithCollisions`.

The problem isn't determinism-today; it's that **a general-purpose rendering engine's collision solver sits inside our authoritative simulation**, which creates two structural liabilities:
1. **Renderer upgrades are gameplay events.** Babylon 4→9 is five majors of collision epsilon/slide/gravity tweaks. Our map spawns / `killY` / jump-pad landings were calibrated against 4.0.3's solver output; any change shifts them (this is risk **R2/R4** in the migration doc — the reason we add a collision-regression gate). Every *future* Babylon bump carries the same risk. Physics should not be hostage to renderer release notes.
2. **We don't control or fully understand the collision math** — epsilons, slide behavior, step handling are Babylon's, tuned for editor convenience, not for our netcode.

**The win is control + stability, not fixing a live bug.** (This is server-authoritative-with-prediction, not lockstep — we don't need bit-perfect cross-machine floats; we need *stable, identical, ours* so reconciliation stays sub-perceptual and never drifts under an upgrade.)

## 3. Goals / non-goals
**Goals**
- A pure-JS `collideAndSlide(pos, vel, dt, world) -> { pos, vel, grounded }` shared verbatim by client + server, with **no Babylon dependency in the movement path**.
- Preserve the current UT99 feel bit-for-bit *by tuning*, not by accident: Quake friction/accel, `JUMP_SPEED 7.2`, `GRAVITY 18`, air control, dodge burst, jump pads — all unchanged; only the collision primitive underneath swaps.
- Faster than `moveWithCollisions` (headroom for higher tick rate / player count).

**Non-goals**
- Not a physics engine. No rigid bodies, stacking, ragdolls, or mesh-vs-mesh. Player-vs-world only. (Projectiles/hitscan stay on their current `Ray` path for now — separate concern.)
- Not perfect cross-architecture float lockstep (unnecessary for our netcode model; see §2).
- Not replacing the renderer's own collision for non-gameplay visuals.

## 4. Current state (what we're replacing)
- **The call:** `applyCommand.js:158` — `entity.mesh.moveWithCollisions(new Vector3(velX*delta, velY*delta, velZ*delta))`.
- **Player shape:** an ellipsoid (`PlayerCharacter.js` `mesh.ellipsoid` + `checkCollisions`). We'd model this as a **vertical capsule** (or AABB) — see §5.
- **Grounded detection:** `applyCommand.js:177` — grounded = a downward move got cut short (`velY<=0 && movedY - velY*delta > 0.001`). Our solver must return the **actual** moved delta so this exact logic keeps working.
- **Jump pads:** `applyCommand.js:131-147` set `velY` from `JUMP_PADS` before gravity integrates — pure state math, already engine-independent; untouched.
- **World geometry, two regimes:**
  - **Box arena** (`arenaConfig.js` `OBSTACLE_SPECS`): already a list of `{x, z, width, height, depth}` — **these ARE AABBs.** A custom AABB solver is nearly free here.
  - **Mesh maps** (`mapMesh.js`, `USE_MESH_MAP=true`, active = CTF-Visage / Facing Worlds): the artist OBJ is loaded into the server's NullEngine and collided against as **real triangle geometry**, scaled 0.65. This is the hard case (§7).

## 5. Design — collide-and-slide
**Player shape:** vertical **capsule** (radius + height) is the closest match to today's ellipsoid and the FPS standard; an **AABB** is simpler and often good enough for a boxy arena. Start with capsule-vs-AABB (world boxes), or AABB-vs-AABB if capsule sweep proves fiddly — decide during the box-arena spike.

**Per-tick algorithm** (the Quake/UT technique):
```
remaining = velocity * dt
for iter in 0..MAX_ITERS (3–4):
    hit = sweep(capsule, pos, pos + remaining, worldBoxes)   // earliest TOI
    if !hit: pos += remaining; break
    pos += remaining * hit.t                                 // advance to contact
    n = hit.normal
    remaining = (remaining * (1 - hit.t))                    // leftover this tick
    remaining -= n * dot(remaining, n)                       // clip INTO-surface component -> slide
    velocity  -= n * dot(velocity, n)                        // so next tick keeps the slide
return { pos, vel: velocity, actualMovedY: pos.y - startY }
```
- **Slide** = removing the into-surface velocity component while keeping the tangential part (the `-= n*dot` step). That single line is wall-sliding, ramp-walking, and ceiling-stop.
- **Grounded** = a hit whose normal points up-ish (`n.y > ~0.7`) OR the existing "downward move cut short" test on `actualMovedY`. Keep the existing test to minimize feel change.
- **Step-up** (curbs/small ledges): optional — if a forward sweep is blocked but a point one step-height higher is clear, snap up. UT/Quake do this; add only if the maps need it.
- **Skin width / epsilon:** keep a small gap off surfaces to avoid re-penetration jitter; *this* epsilon becomes ours to tune (the whole point).

## 6. Integration points
- **`applyCommand.js:158`** — swap the single `moveWithCollisions(...)` call for `collideAndSlide(...)`; write the result back to `entity.x/y/z` and `entity.velY`. Everything above it (friction, accel, jump, dodge, jump-pads, gravity) is unchanged.
- **`applyCommand.js:177`** grounded logic — feed it the solver's returned `actualMovedY`.
- **Server** (`GameInstance.js`) — no `entity.mesh` collision setup needed once the sim owns collision; the NullEngine can stop being the collision authority (big server simplification; keep NullEngine only if still used for hitscan `Ray`). Remove `xhr2`/OBJ-into-NullEngine collision load if the sim replaces it (mesh-map path, §7).
- **World build** — one function turns the active map into the solver's `worldBoxes` (trivial for `OBSTACLE_SPECS`; the design question for mesh maps is §7).
- **Verify harness** — `verify-map.ts` / `_sweep-pad.ts` already build a headless collision scene and assert pad landings/spawns; repoint them at the new solver.

## 7. The mesh-map collision-geometry question (the real design decision)
A custom AABB/capsule solver is trivial for the box arena but **cannot cheaply collide against an arbitrary art mesh** (Facing Worlds towers/ramps/terrain). Two options, mirroring how real FPS engines work:
- **(A) Collision hulls / brushes (recommended, the industry norm):** author a *simplified* collision proxy per map — a set of boxes/ramps/convex volumes approximating the walkable space — **separate from the render mesh** (Quake/UT do exactly this; collision geometry ≠ visual geometry). Cheapest at runtime, fully deterministic, gives us clean control. Cost: a per-map authoring step (could be hand-placed volumes, or a tool that voxelizes/box-decomposes the OBJ).
- **(B) Deterministic triangle collision:** keep colliding against the real mesh triangles but with **our own** swept-capsule-vs-triangle routine (so it's still engine-independent). More code, slower, but no per-map authoring. Viable because our meshes aren't huge; a broadphase (grid/BVH over triangles) keeps it fast.

**Recommendation:** ship **(A) for the box arena immediately** (it's free), then decide (A-brushes vs B-triangles) for mesh maps based on how many maps we'll ship and whether we want a collision-authoring tool. Brushes are the durable answer if the map count grows.

## 8. Phasing
1. **Box-arena solver behind a flag.** Implement capsule-vs-AABB collide-and-slide; drive it from `OBSTACLE_SPECS`; gate with a `USE_CUSTOM_COLLISION` flag so we can A/B against `moveWithCollisions`. Tune epsilon/step until feel + `verify-map.ts` match the Babylon baseline. **This alone proves the architecture and de-risks everything.**
2. **Server simplification.** Once the box arena is solid on the custom sim, drop Babylon collision from the server path there (NullEngine kept only if hitscan `Ray` still needs it).
3. **Mesh-map collision.** Pick (A) brushes or (B) triangle-sweep per §7; build the map→world converter; migrate CTF-Visage; re-run `probe-visage`/`verify-meshmap` and re-tune spawns/killY.
4. **Retire `moveWithCollisions`** everywhere; remove the flag; delete the OBJ-into-NullEngine collision load + `xhr2` if unused.

## 9. Testing (reuse what exists)
- **Golden A/B:** run the *same* input sequences through Babylon `moveWithCollisions` and the new solver; assert final `(x,y,z)` within a tight tolerance, then intentionally diverge only where we *choose* to (better slide, step-up). The migration's **collision-regression harness** (record positions after jump / wall / jump-pad) is exactly this fixture — reuse it.
- **`verify-map.ts` + `_sweep-pad.ts`:** pad-lands-on-deck, spawns-on-open-floor, no-fall-through — the existing acceptance gates.
- **`verify:movement` / `verify:1v1`:** reconciliation-spam and hit-reg in the live client.
- **New invariant test:** feed identical inputs to two solver instances (simulated client + server) and assert byte-identical trajectories — the property the whole design exists to guarantee.

## 10. Risks & effort
- **Feel regression** — the #1 risk. Mitigate with the golden A/B fixture and tune to match before flipping the flag. Players notice a changed jump arc instantly.
- **Mesh-map collision fidelity** (§7) — the real work and the real cost; box arena is easy, Facing Worlds is not. Don't underestimate the authoring/tooling for option (A).
- **Step/edge cases** — getting caught on box seams, jitter on ramps; standard collide-and-slide pitfalls, solved by skin-width + multi-iteration + careful normals.
- **Effort:** box-arena solver + A/B harness ≈ a few days. Mesh-map collision (option A or B) is the larger, open-ended chunk — scope it separately after phase 1 proves out.

## 11. Sequencing & entry criteria (READ THIS)
**Migration first. This project starts only when:**
- Babylon 9 + Vite migration has **shipped and been stable in production** (through at least Phase 2 of `upgrade/upgrade.md`).
- The migration's **collision-regression gate** has run — its output (did `moveWithCollisions` drift 4→9, and by how much?) directly informs urgency here: small drift → this stays a planned improvement; large drift → fast-track phase 1.
- We are not mid-way through any other netcode change (e.g. the late-joiner bug or a transport swap) that would confound trajectory diffs.

Rationale: doing both at once makes it impossible to tell whether a trajectory change came from the engine bump or the new solver. Land the migration, measure the drift, *then* build the sim — with the migration's own regression harness as this project's ready-made test fixture.
