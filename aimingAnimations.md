# Aim-Down-Sights Animation Implementation Brief

## Goal

Add hold-to-aim / aim-down-sights (ADS) to Frag Arena by using the first-person aiming animations already included in the Retro Weapon Pack.

This must be a complete, tested gameplay-facing feature, not just a camera-FOV tween. It must work with firing, movement, reload, weapon switching, death/respawn, desktop input, and touch input without breaking the existing deterministic movement/fire pipeline.

## Repository facts (inspect before editing)

- Project root: `/home/miltron/unreal`
- Source archive: `/home/miltron/Downloads/RetroWeaponPack_V1.zip`
- Staged pack: `_incoming/retro/original-pack/Assets/RetroWeaponsPack`
- Candidate exporter: `scripts/build-retro-candidates.sh`
- Exporter: `scripts/blend-to-gltf.blender.py`
- Semantic source map: `scripts/retro-clip-mapping.json`
- Concrete Blender action map: `scripts/retro-blend-actions.json`
- Runtime viewmodel: `client/graphics/Viewmodel.js`
- Input: `client/InputSystem.js` and `client/TouchControls.js`
- Main update/fire/camera path: `client/Simulator.js`
- Weapon definitions: `common/weaponsConfig.js`
- Input protocol: `common/command/MoveCommand.js`
- Existing verification: `scripts/verify-retro-glb.py`, `scripts/verify-viewmodel.mjs`, `scripts/verify-weapon-states.mjs`, `scripts/verify-mobile.mjs`

Read these files and preserve their current invariants. The working tree may contain unrelated changes: do not reset, overwrite, or reformat unrelated work.

## What already exists

The vendor pack contains a complete first-person ADS set for Rifle, SMG, Shotgun, and Pistol:

- `AimStart` — transition from hip pose to sights
- `AimPose` — static sight-aligned reference pose
- `AimEnd` — transition from sights back to hip pose
- `Breathing_Aiming` — ADS idle/breathing loop
- `Walk_Aiming` — ADS movement loop
- `Fire_Aiming` — ADS fire one-shot

The source FBXs live below:

```text
_incoming/retro/original-pack/Assets/RetroWeaponsPack/FP_Arms/FBX_Files/Animations/<Weapon>_01_Animations/
  Cycles/*Breathing_Aiming.fbx
  Cycles/*Walk_Aiming.fbx
  OneTimeAnimations/*Fire_Aiming.fbx
  Poses/*AimPose.fbx
  TransitionAnimations/*AimStart.fbx
  TransitionAnimations/*AimEnd.fbx
```

The staged `.blend` files also contain concrete aiming actions. Names differ by weapon, so do not guess or apply one naming pattern to all four rigs.

| Runtime clip | Rifle actions | SMG actions | Pistol actions | Shotgun actions |
|---|---|---|---|---|
| `aim_start` | `Arms_AimStart` + `Rifle_AimStart` | arms hold/base + `AimStart` | arms hold/base + `Pistol_AimStart` | arms hold/base + `shotgun01_AimStart` |
| `aim_pose` | `Arms_AimPose` + `Rifle_AimPose` | arms hold/base + `AimPose` | `Arms_AimPose` + `Pistol_AimPose` | arms hold/base + `shotgun01_AimPose` |
| `aim_end` | `Arms_AimEnd` + `Rifle_AimEnd` | arms hold/base + `AimEnd` | arms hold/base + `Pistol_AimEnd` | arms hold/base + `shotgun01_AimEnd` |
| `fire_aiming` | `Arms_AimFireAiming` + `Rifle_AimFire` | `Arms_Fire` + `Smg_FireAiming` | `Arms_FireAiming` + `Pistol_Aiming_Fire` | `arms_Fire` + `movement_Fire_Aiming` + `shotgun01_fire_Aiming` |
| `breathing_aiming` | arms aimed/base pose + `Rifle_Breathing_Aiming` | arms hold/base + `Smg_BreathingAiming` | `Arms_AimPose` + `Pistol_Breathing_Aiming` | arms hold/base + `movement_breathing` + aimed gun pose as needed |
| `walk_aiming` | arms aimed/base pose + `Rifle_Walk_Aiming` | arms hold/base + `Smg_WalkAiming` | `Arms_AimPose` + `Pistol_Walk_Aiming` | arms hold/base + `movement_walking_Aiming` + aimed gun pose as needed |

The table is an implementation starting point, not permission to bypass validation. Confirm the exact arm/gun target coverage and grip attachment with the exporter/verifier before shipping. In particular, the Shotgun rig splits movement/object animation from `shotgun01_*` gun-bone animation and already has known source/export quirks.

Current runtime weapon GLBs expose only the core clips used today (`idle`, `fire`, `reload`, `draw`, with some fuller candidates also carrying `walk`, `run`, `hide`, and `interact`). They do **not** currently expose the six ADS runtime clips above.

## Required runtime clip contract

Export these exact animation group names into every ADS-capable viewmodel GLB:

```text
aim_start
aim_pose
aim_end
fire_aiming
breathing_aiming
walk_aiming
```

Keep the existing names unchanged:

```text
idle
fire
reload
draw
```

Update both mapping files and the exporter/verifier so the ADS set is declared and validated as one complete group. If one ADS clip is present, all six must be present for that weapon.

Do not write unreviewed builds directly into `public/assets/weapons`. Build review artifacts into:

```text
/tmp/frag-retro-candidates
```

Only replace runtime GLBs after all candidate checks pass and the mounts/poses have been reviewed.

## Input behavior

### Desktop

Use hold-to-aim on the **right mouse button**:

- `pointerdown`, button `2`: set `aimDown = true`
- `pointerup`, button `2`: set `aimDown = false`
- left button remains fire
- losing pointer lock, window blur, death, or disposal must clear aim so it cannot stick
- keep the context menu disabled as it is today

Do not let the current generic pointer handler turn right-click into fire. Explicitly distinguish mouse buttons.

### Touch

Add a dedicated hold-to-aim touch button. It should:

- set `aimDown = true` on touch start
- set `aimDown = false` on touch end/cancel
- optionally allow that same finger to drag-look, matching the fire button's existing behavior
- never interfere with movement joystick, fire, reload, switch, jump, throw, or settings
- receive responsive portrait/landscape CSS placement and be covered by mobile verification

### Local state versus networking

ADS is initially a **local presentation/control state**. Do not add it to `MoveCommand`, player replication, authoritative fire logic, spread, damage, movement speed, or hit validation merely to animate the local viewmodel.

The current aim ray remains authoritative. ADS changes camera FOV and presentation, not where bullets go.

If third-person replication of aiming is deliberately added later, design it as a separate networked state; do not smuggle it into unrelated command fields.

## Viewmodel state machine

Extend the explicit `Viewmodel` FSM rather than adding loose booleans that fight the existing states.

The ADS lifecycle must support at least:

```text
IDLE --aim held--> AIMING_IN --aim_start ends--> AIMED
AIMING_IN --aim released--> AIMING_OUT or a clean reversible exit
AIMED --aim released--> AIMING_OUT --aim_end ends--> IDLE
AIMED --fire--> ADS_FIRING --fire_aiming ends--> AIMED if still held, else AIMING_OUT/IDLE
AIMED/AIMING_IN --reload--> RELOADING, with ADS exited cleanly
any live ADS state --weapon swap/death/setActive(false)/dispose--> HIDDEN or DISPOSED
```

Exact state names may differ, but behavior must be explicit and generation-token guarded like the current draw/fire/reload transitions.

### Animation choice while aimed

- stationary + aimed: loop `breathing_aiming`
- moving + aimed: loop `walk_aiming`
- firing + aimed: play `fire_aiming`, then return to the correct aimed loop if the button is still held
- entering ADS: play `aim_start`
- leaving ADS: play `aim_end`
- `aim_pose` is the stable aimed reference/fallback and may be used to hold the sight pose if a loop handoff needs it

Do not play hip `fire` while aimed if `fire_aiming` exists.

### Priority and cancellation rules

Use these priorities:

1. hidden/dead/disposed
2. reload
3. draw/equip
4. fire
5. ADS enter/exit/aimed locomotion
6. hip idle/locomotion

Required behavior:

- Reload immediately exits/cancels ADS and plays the existing reload animation. Do not attempt aimed reload unless a real authored aimed-reload clip exists; this pack does not provide one.
- Weapon switching clears ADS before disposing the old rig. The newly equipped weapon should not automatically remain aimed unless a deliberate global hold behavior is implemented and tested.
- Death/respawn cannot leave the camera zoomed or the rig frozen in an aiming clip.
- Fire during `aim_start`: either queue/finish the transition quickly or cleanly switch to `fire_aiming`; never drop the shot and never leave two groups fighting the skeleton.
- Aim release during `fire_aiming`: let the shot read, then exit ADS cleanly.
- Repeated right-button presses and releases during transitions must not create stale callbacks, frozen clips, or multiple looping groups.
- Continue using generation tokens/end callbacks. Babylon `4.0.3` has synchronous `AnimationGroup.stop()` end-observable behavior; preserve the stale-callback protections already in `Viewmodel.js`.

## Camera zoom

Implement ADS zoom on the **world camera only**. Keep the separate viewmodel camera fixed at its current FOV (`1.0`) so the weapon animation remains authored and predictable.

Use a smooth frame-rate-independent transition, for example:

```text
hip FOV: current user-selected `this.fov`
ADS FOV: configurable per weapon, default around 65 degrees
zoom-in duration: about 0.12–0.18 seconds
zoom-out duration: about 0.18–0.25 seconds
```

Add weapon-level data such as:

```js
ads: {
  fov: 65,
  inTime: 0.15,
  outTime: 0.20,
  sensitivityMultiplier: 0.75
}
```

Tune values per weapon only if necessary. Avoid scope-like magnification; these are iron-sight animations.

### FOV integration requirements

The existing shotgun recoil FOV pulse and user FOV setting both write the world-camera FOV. Refactor them into one composed FOV calculation so they do not overwrite each other:

```text
base user FOV -> ADS interpolation -> transient recoil-FOV multiplier
```

Changing the FOV slider while aimed must update the correct hip baseline without popping. Releasing aim must always return to the user's selected FOV.

### Sensitivity

Scale desktop and touch look sensitivity while ADS is active, using the current ADS interpolation or an equivalent smooth factor. Do not permanently mutate the stored sensitivity setting. No sudden one-frame sensitivity jump on enter/exit.

## Aim and gameplay safety (non-negotiable)

ADS must not alter:

- `camera.getForwardRay()` semantics
- `MoveCommand.camRayX/Y/Z`
- local fire prediction direction
- server hit validation
- spread/heat unless separately designed and approved
- recoil safety ordering

The current simulator removes visual recoil rotation **before** constructing the movement command and fire ray, then reapplies presentation recoil later. Preserve that order exactly.

A FOV change is allowed because it does not rotate the forward ray. Do not move/rotate the camera to align sights. Sight alignment must come from the authored `aim_start`/`aim_pose`/aim-loop animations and, only if absolutely needed, a presentation-only viewmodel holder offset.

Crosshair behavior is presentation-only. It may fade while fully aimed, but the true center/aim point must remain testable and the fire ray must not move.

## Procedural presentation while aimed

- Reduce or disable the extra procedural hip bob while fully aimed so it does not fight `breathing_aiming` / `walk_aiming`.
- Keep recoil presentation, but tune viewmodel recoil lower while ADS if the authored `fire_aiming` already provides strong motion.
- Do not disable recoil by changing gameplay aim/spread.
- Muzzle flash, tracer, and casing sockets must continue following the animated weapon. Validate `muzzleWorldPos()` during ADS fire.

## Weapon reuse

Slots 4 and 5 reuse the Rifle/Shotgun arm rigs:

- Plasma reuses the Rifle GLB
- Flak reuses the Shotgun GLB

Either give them ADS through those shared clips with their own FOV data, or explicitly mark them `ads: false`. Do not accidentally leave them in a half-working state.

## Asset/export safety

Preserve these existing constraints:

1. Keep only one live equipped viewmodel rig. Babylon `4.0.3` can cross-wire multiple live copies of identically named skeletons.
2. Do not preload ADS by standing up a second live rig; retain raw parse/compile/dispose warming.
3. Every exported clip must drive the correct arms and gun nodes together. Validate grip slip; do not accept gun/hand detachment.
4. Do not regress the Shotgun's known pose/pump workaround. Its source animation topology differs from the other weapons.
5. Do not change shared mount transforms (`scale: 0.01`, camera-relative mount, Y rotation `Math.PI / 2`) merely to hide a bad export. Fix/rebase the export or use a documented per-weapon correction after visual proof.

## Suggested implementation order

1. Extend `scripts/retro-blend-actions.json` with the six concrete ADS mappings per weapon.
2. Extend `scripts/blend-to-gltf.blender.py` to export the six exact ADS group names.
3. Extend `scripts/verify-retro-glb.py` and manifest/preflight verification so ADS is all-or-nothing and attachment-safe.
4. Build all four candidates into `/tmp/frag-retro-candidates`.
5. Inspect clip names, durations, targeted nodes, grip slip, and visual sight alignment before replacing runtime assets.
6. Add `ads` animation names/data to `common/weaponsConfig.js`.
7. Add desktop and touch held input locally.
8. Extend `Viewmodel.js` FSM and aimed locomotion/fire selection.
9. Add composed ADS/recoil camera-FOV handling and smooth sensitivity scaling in `Simulator.js`.
10. Add/extend automated tests, then run the full relevant suite and production build.

## Verification and acceptance criteria

### Asset verification

For Rifle, SMG, Pistol, and Shotgun candidates:

- all existing core clips remain present
- all six ADS clips are present with exact runtime names
- durations are finite and positive (pad one-frame poses if needed for glTF validity)
- arms and gun targets are correct
- hands stay attached to the grip except intentional authored support-hand motion
- no duplicate/unexpected skeletons or orphan resources
- sight is centered at `aim_pose` with the fixed viewmodel camera

### Runtime automated scenarios

Extend `scripts/verify-weapon-states.mjs` or add `scripts/verify-aiming.mjs` to test:

1. hold aim from idle -> enter -> aimed loop
2. release aim -> exit -> hip idle
3. rapid aim press/release spam during transitions
4. fire while aimed, including sustained Rifle/SMG fire
5. release aim during aimed fire
6. aim while moving -> `walk_aiming`; stop -> `breathing_aiming`
7. reload while aimed -> clean ADS exit + reload + hip idle
8. fire-cancel reload remains correct
9. weapon switch during `aim_start`, fully aimed, `fire_aiming`, and `aim_end`
10. death while aimed and respawn
11. pointer-lock loss/window blur while aimed
12. touch aim hold/release/cancel and simultaneous movement/look/fire
13. FOV slider change while aimed
14. recoil FOV pulse while aimed
15. all weapon slots, including explicit Plasma/Flak behavior
16. repeated swaps/ADS cycles do not leak animation groups, skeletons, materials, textures, holders, or muzzle nodes
17. exactly one enabled viewmodel rig; visual weapon equals gameplay weapon
18. no uncaught browser/console errors

### Aim-safety assertion

Automate a check that, for an unchanged camera rotation, the forward ray and emitted `MoveCommand.camRayX/Y/Z` are equal before ADS, during ADS, while firing ADS, and after ADS within floating-point tolerance. This is the most important regression guard.

### Commands to run

At minimum:

```bash
npm run build
npm run verify:anim
npm run verify:viewmodel
npm run verify:fire
npm run verify:weapons
npm run verify:mobile
```

Run the new ADS verifier too. If candidate GLB verification has a dedicated command, run it for all four files in `/tmp/frag-retro-candidates` before integration and again for the shipped runtime assets after integration.

## Definition of done

The work is done only when:

- right mouse hold and touch hold both enter ADS smoothly
- the correct authored enter/pose/idle/walk/fire/exit animations play
- zoom and sensitivity interpolate cleanly
- reload/swap/death/input-loss races always settle correctly
- sights align without rotating the authoritative camera
- aim rays and command direction are unchanged by ADS
- all relevant automated checks and the production build pass
- runtime GLBs were replaced only after candidate review
- unrelated working-tree changes remain untouched

Do not report success based only on clip presence or a successful build. Provide test evidence and list any remaining visual-tuning caveat explicitly.
