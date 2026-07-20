# Probe this for each map

Checklist for bringing a new mesh map online. Every item here exists because
something was **actually broken** on CTF-Visage — the box-arena → mesh-map
migration left ~11 subsystems assuming a floor at y=0 and a ~60-unit arena, and
each one failed silently. Silently is the important word: none of these threw an
error, they just made the game wrong.

Work top to bottom. Items marked **BLOCKER** make the map unplayable in
multiplayer; the rest degrade it.

---

## 0. Before anything: confirm the scale

Maps are authored on an **inch grid** and the world is **metric** (1 unit = 1 m).
Confirmed three ways: DM-W-Grove's step rises quantise to exact multiples of
0.0762 = 3 inches; `GROUND_SPEED` 7.6 = UT99's 400 uu/s ÷ 52.5; `JUMP_SPEED` 7.2
gives apex v²/2g = 1.44 m, matching the comment in `applyCommand.js`.

If a new map's geometry does **not** quantise to a sane real-world grid at your
chosen `scale`, stop and fix `scale` first. Every number below depends on it.

> Note the collider is a **1 m sphere** — roughly half human height. The collider
> is out of scale with the world, not the other way round. Size step heights and
> gaps to the *world*, and treat the collider as a separate known issue.

---

## 1. Register the map (`common/mapMesh.js` → `MAPS`)

```js
mymap: {
  obj: 'public/assets/maps/MyMap/MyMap.obj',
  scale: 0.65,
  rotationX: -Math.PI / 2,
  yOffset: 0,
  killY: -65,          // NATIVE units — multiplied by scale at runtime
  spawns: [ /* native {x, z, y} */ ],
  // per-map data added because global constants broke on Visage:
  bounds:   { /* see §4 */ },
  megaHealth: { /* see §6 */ },
  navPoints:  [ /* see §7 */ ],
}
```

**Put new per-map values HERE, not in a global constant.** Every bug in this
document is a global constant that was correct for the box arena. A one-line
"fix the number for this map" is how you get nine broken maps.

`OBJFileLoader.USE_LEGACY_BEHAVIOR` must stay `true`. If it ever flips, every
world-x coordinate you derive inverts sign.

---

## 2. Spawn points — BLOCKER

For each spawn, probe straight down and confirm:

- it sits **just above** walkable floor (~0.5–1.5 m), not inside geometry, not
  in void
- the surface normal is walkable: `normal.y >= 0.7` (`MIN_WALK_NORMAL`)
- **the column above it is clear** — on Visage, columns over two spawns reach
  y +3.2 and +12.7. A player placed at the wrong height there lands *inside* a
  collider that `moveWithCollisions` cannot escape.

*Breaks if skipped:* players spawn inside walls, or fall on every respawn.

---

## 3. Kill plane (`killY`) — BLOCKER

`KILL_Y` world = `killY × scale`. Then:

- probe every **walkable** surface (normal-filtered, `normal.y >= 0.7`) and
  confirm **none** is below the kill plane. Geometry below it is fine — tower
  hulls and undersides are expected — but *walkable* geometry below it kills a
  player standing on solid floor.
- report the **margin** between the lowest walkable surface and the kill plane.
  A small margin is dangerous: a hard landing, a mesh seam, or the sim's own
  hover-gap can dip the collision point under for a single tick, and the fall
  check is a per-tick comparison — one bad tick kills.

*Breaks if skipped:* players die suddenly on solid ground with no explanation.

> Do a normal-filtered probe, not a min/max-y column probe. A column probe
> cannot tell an up-facing walkable surface from a down-facing hull.

> **Gate on the nav graph, not raw floor.** Some up-facing geometry is not
> reachable — tower undersides and roof panels face up but nobody stands on
> them. CTF-Visage's raw walkable geometry reaches native **-78.42**, but its
> *reachable* floor stops at **-39.01**. Deriving `killY` from raw floor puts the
> kill plane ~40 m too low; gating on nav reproduces the shipped `killY = -65`
> exactly. A working rule:
> `killY = floor((lowest_reachable_floor - 15) / 5) * 5`, which yields ~10-17 m
> of margin across the map set.

Also check **headroom at every spawn**. A spawn with under ~1 m of clearance
puts the player's head in geometry. Four spawns on CTF-Dismal (0.74-0.94 m) and
one on CTF-Torix (0.25 m) had to be dropped for this — measure it rather than
trusting the original author.

---

## 4. Network view bounds — BLOCKER

The nengi view is an AABB. nengi **hard-culls** on it — `BasicSpace.js`
`queryAreaEMap3D`, strict test, `DIMENSIONALITY: 3`.

Compute the map's real walkable extent and confirm the bounds cover **all** of
it, with margin. On Visage the old fixed ±64 box left two spawn points outside:
players there were never replicated to anyone — no model, no nametag, no corpse
— while still able to shoot everyone.

- confirm every spawn is inside the bounds
- confirm the **furthest walkable point** is inside, not just the spawns
- the victim sees nothing wrong locally (their own entity is on a private
  channel), so this reads as "the enemy is a ghost", never as an error

*Breaks if skipped:* part of your map is populated by invisible players.

*Latency note:* widening the view replicates more entities to more clients.
State the bytes/tick cost when you size it.

---

## 5. Floor-height constants

Anything that assumes where the floor is. On Visage the deck is at y ≈ **−25.3**
and every one of these was set for a floor at −1:

| System | Symptom if wrong |
|---|---|
| Grenade ground plane | grenades teleport skyward, detonate in the air, zero damage |
| Blood ground pools | no blood physics; red quads float 23 m up |
| Gib floor | gibs teleport into the sky and rattle around |
| Shell casing floor | casings follow them up |
| Box-arena ground plane mesh | opaque 60×60 plane hangs over the deck as a black ceiling |

Prefer deriving the surface from the **event that spawned the effect** (the
impact point, the entity's own y) over any global floor.

---

## 6. Pickups

Probe the intended position and confirm a player can physically get within
`RADIUS` of it. On Visage the mega-health sat at y +1.0 with a 2.2 radius while
the nearest reachable surface was 17.5 m below — the proximity test could never
pass, so the whole mechanic was dead while a glowing box hung in the sky.

Put the position in the `MAPS` entry. Pick somewhere **contested** — that is a
design decision, not a placement detail.

---

## 7. Bot navigation

Bots steer toward a point; there is **no pathfinding**. So every wander/nav
target must be:

- on walkable floor (`normal.y >= 0.7`)
- **reachable by walking** — a point across a gap is as bad as a point over void
- spread across the **whole** play area

On Visage the old hardcoded ±32/±15 rectangle put ~1 in 7 targets over open void
(bots walked off and died) and could never reach the east base at all.

Also confirm bot line-of-sight uses the **same** occlusion query as shot
resolution. Two independent LoS implementations drift, and then bots shoot at
things they can't see — which looks like bad AI tuning and isn't.

---

## 8. Movement geometry

Run the slope/step probes against the real mesh:

- **Slopes.** Every intended-walkable surface should read `normal.y >= 0.7`.
  Watch for surfaces *near* the limit — Visage's steepest real floor is 0.915
  and its steepest non-floor is 0.648, a comfortable gap. A map with ramps at
  ~0.70 will feel arbitrary about what you can stand on.
- **Steps.** Extract real step rise/run from triangle topology (a flat tread,
  a near-vertical riser, a flat floor below). Confirm the tallest step players
  are expected to walk up is under `MAX_STEP_HEIGHT`, and that ledges you want
  to require a jump are **above** it. Jump apex is 1.44 m.
- **Standing drift.** On walkable ground a stationary player must drift
  **0.000 m** over 3 s at 100% grounded.

> Do **not** measure slope with a 3-point plane fit. It straddles discontinuities
> and lies — that method classified a 49.6° edge bevel as a 25.9° walkable ramp
> on Visage. Use real triangle normals as ground truth.

---

## 9. Occlusion meshes

Confirm the map's collision geometry is registered as occluders for hitscan and
projectiles, and that it is **subdivided**.

OBJ exporters group faces by *material*, so one "mesh" can span the entire map
and its bounding volume culls nothing — on Visage, 18 of 36 meshes had bounding
spheres enclosing the shooter. Subdividing into ~12-triangle submeshes took the
raycast from 227 µs to 34 µs per pellet, a 6.7× win. An octree on top was worth
only 4% and was rejected.

*Breaks if skipped:* players take damage through solid walls; projectiles fly
through the level.

---

## 10. Presentation

- **Fog.** `fogDensity` is tuned per arena size. EXP2 factor is
  `exp(-(distance × density)²)`. Check it against the map's longest intended
  sightline — 0.008 fogs a 105 m cross-map shot by 51%, which ruins a sniping
  map.
- **Skybox / vista.** Positioned for the old arena. Check it reads correctly
  from the new map's viewpoints.
- **Character model offset.** Confirm feet sit on the deck — not sunk, not
  floating. Check the local player, a remote player, **and a corpse** (the
  corpse path is a separate early return).

---

## Quick pass

```sh
npx tsx scripts/verify-map.ts        # map/spawn/pad sanity, all maps
npx tsx scripts/verify-meshmap.ts    # drop-probe walkability grid
npx tsx scripts/probe-clean-NEW.ts   # slope + standing drift on the real mesh
SPOT_X=.. SPOT_Y=.. SPOT_Z=.. npx tsx scripts/trace-spot.ts   # ground truth at one point
```

`trace-spot.ts` prints the real triangle normal plus a 5×5 neighbourhood with
`void` where there is no floor. It answers "is this a surface or an edge?" in one
glance.

---

## Traps

- **`scripts/golden-collision.ts` defaults its output path to the committed
  baseline.** Running it bare destroys your reference. Always pass an explicit
  output path. Baseline md5: `0ca42aaeb38d151a4d8287a1a9dc9624`.
- **`scripts/probe-slope-slide.ts` leaks meshes.** It never disposes its
  `PlayerCharacter`, and those have `checkCollisions = true`, so repeated runs
  collide with ghosts of earlier runs. Use `probe-clean-NEW.ts`. Make sure any
  harness *you* write disposes too.
- **`collider.slidePlaneNormal` is not a unit normal.** It is a
  residual-penetration vector whose length scales with the unconsumed move.
  Normalize before comparing to any cosine threshold. Raw, it measures impact
  speed, not slope.
- **`collider.collisionFound` reads `false` on sloped surfaces** even when the
  sweep was plainly blocked. Detect contact by travel shortfall instead. On the
  horizontal walking move it reads `false` *always*. Working substitute:
  `slidePlaneNormal` is zero before the move and non-zero after.
- **Winding: keep the defensive test, but the "Grove is inverted" warning is
  retired.** An earlier probe reported DM-W-Grove's floors as `normal.y = -1.000`.
  Re-measured through the exact `_loadMapMesh` path (Babylon 9,
  `USE_LEGACY_BEHAVIOR = true`, `rotationX = -PI/2`), Grove reads **+1.000** under
  all 16 spawns, by face *and* vertex normals, and **all 84 maps read +1**. The
  earlier result came from a different load path. Still test
  `Math.abs(n.y) >= 0.7` when you only need walkability — it costs nothing and
  survives a pipeline change — but do not expect per-map winding variation.
  Note walkable x/z *extents* are sign-independent either way.
- **Two exporters exist and their conventions differ.** The raw exporter under
  `/mnt/echostore` emits **z negated** relative to the live assets. The live
  convention is the one in `maps/improved/`. Mixing them **mirrors the map** —
  spawns, pickups and objectives will land on the wrong side and nothing will
  look obviously broken. Always take geometry from `maps/improved/`.
- **The player collider is a 1 m sphere** (`ellipsoid = 0.5, 0.5, 0.5`), roughly
  half human height, in a metric world. It lands *tangent* to a step's top edge,
  so the contact normal there depends on approach speed — which makes stair
  climbing speed-dependent. Babylon also tolerates ~0.03 of interpenetration
  silently and then stops resisting entirely, which lets a player end up inside
  geometry and walk metres through solid while `grounded` reads true. Both are
  open issues, not map faults — do not tune a map around them.
- Several probes above currently live in `_work/` rather than `scripts/`.
  Promote the ones you rely on, or they will rot.
