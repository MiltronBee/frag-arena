# Frag Arena hardening plan

**Status:** implementation roadmap  
**Baseline:** `upgrade/babylon9-vite` at `7891cd7` on 2026-07-28  
**Deliverable:** copy this document to repository root as `hardening.md`; this planning pass makes no source or production changes.

## Decision record: intentionally out of scope

The following are product decisions, not defects in this hardening track:

1. **Wallet semantics.** Do not add signed-wallet authentication, change entitlement lookup, change gated loadouts, rename the wallet flow, or change Proof of Blood settlement identity.
2. **Asset/IP choices.** Do not remove, replace, quarantine, rename, or otherwise alter the UT-derived maps/assets or their release treatment.

Do not reopen either subject in implementation reviews unless the user explicitly changes scope. This plan also avoids token design, mint/swap copy, Elo/product claims, new maps, new modes, and combat-balance redesign. Network failure states may be made truthful, but intentional product copy remains untouched.

---

## Goal

Harden the game already present:

- eliminate the verified renderer and HTTP failures;
- reject incompatible client/server generations explicitly;
- turn the existing probes into a credible release gate;
- make releases dependency-exact, observable, and rollbackable;
- reduce cold time-to-PLAY without changing gameplay;
- split large modules only when a touched responsibility can be extracted safely.

This is not a rewrite. Each batch must preserve current CTF-Visage gameplay and be independently releasable and reversible.

## Non-negotiable operating rules

- Never deploy with `rsync --delete` or `--delete-excluded`.
- Always exclude persistent `/data`; move persistent state deliberately, never as an incidental rsync side effect.
- Production needs **full dev-inclusive dependencies** because `tsx` and `patch-package` are devDependencies. Use `env -u NODE_ENV npm ci --include=dev`; never use `--omit=dev` or `--ignore-scripts`.
- Ship `client/`, `common/`, and `server/` as one generation whenever the wire protocol changes.
- Keep `root@sol-pkmn.fun` as the SSH target; the public game hostname is separate.
- Do not edit `public/js/app-*.js` directly. Client source lives under `client/`.
- Do not use global Babylon `scene.isReady()` as the future PLAY gate; optional background loads would make it blocking again.
- Multi-client browser tests use one Chrome process per client, not multiple tabs in one process.
- A failed active map/collision load is fatal to readiness. Do not silently fall back to a different map in production.
- Every rollout below is a separate commit/deployment boundary. Do not combine protocol, deployment-topology, preload-gate, AssetContainer, asset re-export, and Vite-chunk changes in one release.

---

## Verified baseline

| Area | Current verified state |
|---|---|
| Branch | Clean at audit; 77 commits ahead of `master` |
| Active release | Rotation pinned to `visage`, mode `CTF`, server rate 40 Hz |
| Build | Vite exits 0 despite missing `DefaultRenderingPipeline` and `Space` exports |
| Renderer | Desktop post-processing silently fails; high-tier flesh-to-wall splatter can throw on `BABYLON.Space.LOCAL` |
| HTTP | Encoded malformed wallet paths such as `%C0%AF` can throw in `decodeURIComponent()` and take down/restart the HTTP process |
| Wire compatibility | No explicit game protocol version; server accepts every decoded handshake and replies `Welcome!` |
| Sourcemaps | Production build generates a roughly 15 MB map; deploy excludes maps but an old public map survives because deployment correctly does not delete |
| Existing verification | `npm run verify` is only the old netcode probe; several browser probes predate spectator-before-PLAY and now time out |
| Cold boot | About 29.4 s to `_assetsReady`, 55.2 MiB cold transfer, 273 requests on the measured host |
| Warm boot | About 24.6 s despite near-zero transfer; approximately 21.9 s is long-task time |
| Main JS | About 4.22 MB raw / 1.00 MB gzip; production observation was about 1.15 MB transferred |
| Character payload | `hero_male.glb` about 19.65 MiB, including 120 clips and large embedded PNGs |
| Deployment | Direct copy into the live tree, no lockfile/patch sync, no dependency install, PM2 restart, then `/mapinfo` only |
| Production dependency audit | No production vulnerabilities at audit time; dev-tool findings remain and should be handled separately from runtime hardening |

The warm-load result is important: bandwidth and CDN work alone cannot fix startup. The dominant cost is repeated glTF parsing, object creation, shader/texture work, and warm-import-dispose behavior.

---

# Milestone H1 — Correctness and compatibility

**Priority:** P0  
**Expected scope:** small source changes plus focused tests  
**Release boundary:** deploy client/common/server together because this introduces protocol enforcement

## H1.1 Restore the missing Babylon surface

### Changes

- `common/babylon.node.js`
  - Export `Space` beside the existing `Axis` export from the Babylon math-axis module.
- `client/babylon.js`
  - Export `DefaultRenderingPipeline` from the deep Babylon 9 module path.
  - Keep the curated barrel; do not replace it with the Babylon root barrel.
- `upgrade/render-probe.mjs`
  - Assert `BABYLON.Space.LOCAL === 0`.
  - Assert `DefaultRenderingPipeline` is a constructor.
  - On desktop, assert the renderer created its named post-process pipeline.
  - Exercise the genuine high-tier wall-splatter path so `Space.LOCAL` is not merely symbol-tested.

### Build warning policy

- `vite.config.js`
  - Add a Rollup `onwarn` policy after the exports are fixed.
  - Allow only the exact known `client/babylon.js -> client/babylon.js` self-cycle used by the curated `window.BABYLON` namespace.
  - Throw on every other Rollup warning, including all future missing exports.
  - Do not broadly allow all circular dependencies.

### Acceptance

- Desktop FXAA/post-processing initializes.
- Flesh impact near a wall creates blood FX without a page error.
- `npm run build` has no unreviewed warning.
- The render probe fails if either export disappears again.

## H1.2 Make malformed encoded paths non-fatal

### Changes

- `server/serverMain.js`
  - Define the route response helper before decoding the wallet segment.
  - Wrap only `decodeURIComponent()` in a narrow `try/catch`.
  - Return `400` for malformed encoding; preserve current validation and successful wallet behavior.
  - Do not refactor the entire router in this batch.
- Add `scripts/verify-http-hardening.mjs`.
  - Start or target a controlled local server.
  - Issue a raw request for `/wallet/%C0%AF`.
  - Require `400`.
  - Immediately request `/mapinfo` and require `200` to prove process survival.

### Follow-up hardening, same semantics

After the crash fix, without altering wallet ownership behavior:

- bind game and mapinfo listeners to configured loopback hosts in production;
- trust forwarded IP headers only at the nginx boundary;
- periodically sweep or cap HTTP rate-limit buckets;
- make unknown HTTP paths return `404` rather than a mapinfo-shaped `200`.

### Acceptance

- Every malformed percent-encoding case returns a controlled `400`.
- PM2 restart count does not change during the regression test.
- Valid wallet and mapinfo behavior is unchanged.

## H1.3 Add an explicit game protocol handshake

### Shared contract

Add `common/protocolVersion.js`:

```js
export const GAME_PROTOCOL = 'frag-arena/1'
```

This is a manually bumped binary/schema compatibility identifier, not the build hash. Bump it whenever registered entities/messages/commands or incompatible semantics change.

### Server

- `server/GameInstance.js`
  - Read nengi handshake data from `data?.fromClient`, with a direct-data fallback only for test doubles.
  - Reject missing or mismatched `protocol` before creating player/session state.
  - Accept a matching client with `text: GAME_PROTOCOL` rather than `Welcome!`.
- `server/serverMain.js`
  - Add `protocol: GAME_PROTOCOL` to `/mapinfo` as an additive field.

### Client

- `client/GameClient.js`
  - Always send `protocol: GAME_PROTOCOL`, preserving all existing handshake fields.
  - Treat `accepted: false` as refusal.
  - Treat an accepted response whose text is not exactly `GAME_PROTOCOL` as incompatible.
  - Only publish the connected state after exact acknowledgement.
  - Retain the acknowledged protocol for diagnostics and live verification.
- `client/Simulator.js`
  - Preserve reason-specific connection states such as `UPDATE REQUIRED` and `CONNECTION REFUSED`.
  - A subsequent close event must not overwrite the more useful incompatibility reason.
- `bot/stressBot.js`
  - Send the same protocol identifier. The separate FragBench gateway protocol is unrelated and must not change.

### Tests

Add `scripts/verify-protocol-version.mjs` with these assertions:

1. exact match is accepted and echoed;
2. missing protocol is rejected;
3. `frag-arena/0` is rejected;
4. a future version is rejected;
5. malformed or old-server acknowledgement is rejected client-side;
6. `/mapinfo.protocol` matches the socket contract.

Extend `scripts/verify-live-connect.mjs` to prove the live socket acknowledgement, not merely that the currently deployed pair happened to connect.

### Compatibility behavior

- Old client → new server: rejected before entering the stream.
- New client → old server: client rejects `Welcome!` and asks for an update.
- Matching pair: accepted.

Old open tabs will require a reload after this rollout. That is expected and preferable to positional binary misdecoding.

## H1.4 Stop generating and serving production sourcemaps

### Changes

- `vite.config.js`
  - Set production `sourcemap: false`.
- `package.json` or a focused prebuild helper
  - Remove the fixed stale local `public/js/app-v0.0.1.js.map` before building because `emptyOutDir: false` will not clean it.
- `scripts/deploy-frag.sh`
  - Keep the `*.map` exclusion.
  - Never solve stale files with rsync deletion.
- Tracked nginx fragment introduced in H3
  - Deny public `*.map` requests.
- First production rollout
  - Explicitly remove the one known stale deployed map after confirming its exact path; do not recursively delete map files or unrelated content.

### Acceptance

- The built JS has no `sourceMappingURL` trailer.
- No `.js.map` is produced in `public/js`.
- Public requests for the old map return `404`.

## H1.5 Truthful transport-failure states only

This does **not** alter intentional currency, wallet, swap, Elo, or product copy.

- `client/graphics/MenuScreens.js`
  - Initial fetch failure: show `LEDGER UNAVAILABLE` / `CENSUS UNAVAILABLE` and clear dynamic fields.
  - Failure after valid data: label retained values `STALE`.
  - `enabled: false`: clear all prior dynamic values before painting the existing OFF state.
- `client/graphics/MarketHud.js`
  - On poll failure, use the existing no-data paint path instead of leaving an old value looking live.
- `client/graphics/MenuControls.js`
  - Hide stale now-playing data after a failed refresh.
- `public/index.html`
  - Initialize market source as no-data rather than claiming a live source before the first successful response.
- Extend `scripts/verify-screens.mjs` for unavailable, stale, recovered, and disabled states.

This is P1 and may be shipped after H1.1–H1.4 if keeping the P0 diff smaller is preferable.

## H1 release gate

Before deployment:

```bash
npm run build
npm run verify:protocol
npm run verify:http
# render probe against the built local site
# existing deterministic movement/collision and wallet/Blood regression tests
```

After deployment:

```bash
curl -fsS https://degentournament.fun/mapinfo
curl --path-as-is -i 'https://degentournament.fun/wallet/%C0%AF'
curl -I https://degentournament.fun/js/app-v0.0.1.js.map
node scripts/verify-live-connect.mjs
```

Required result: current protocol reported, malformed route returns `400` without restart, map returns `404`, and a real browser still enters PLAY and receives its entity.

---

# Milestone H2 — One credible release gate

**Priority:** P0/P1  
**Purpose:** replace ceremonial confidence with one command that covers the active game

## Command structure

Add the following package-level interface:

```text
npm run verify:fast        # deterministic checks, seconds
npm run verify:build       # production build + output/warning validation
npm run verify:browser     # built-bundle two-client smoke
npm run verify:release     # build -> fast -> browser, sequential
npm run verify:soak        # opt-in/nightly server soak
npm run verify:soak:ctf    # opt-in full objective flow
npm run verify:postdeploy  # public release identity + browser/WSS smoke
```

Keep orchestration sequential and fail-fast. `verify:browser` consumes the existing built `public/` through `scripts/static-serve.mjs`; do not use `vite preview`, which targets the wrong output directory for this repository.

## H2.1 Fast gate

### Add `scripts/verify-active-contract.mjs`

Assert the current release contract directly from source:

- default map is `visage`;
- rotation contains exactly one `visage`/`CTF` entry;
- mode name is `CAPTURE THE FLAG`;
- exactly two flag bases cover teams 0 and 1;
- team-tagged spawn sets exist for both teams;
- nengi update rate is 40 Hz;
- required CTF/deploy/spectator protocol types are registered;
- installed Babylon core and loaders versions match the pinned package versions.

### Repair current deterministic checks

- `scripts/verify-spawns.ts`
  - Replace the removed `MAPS` import with `mapRecords` from `common/mapRegistry.js`.
  - Explicitly validate active Visage team spawns.
- `scripts/verify-ads-spread.mjs`
  - Update the stale SMG expectation to its current configured ADS tightening.
- Reuse passing focused checks such as touch-look, falloff, and seat/capacity contract tests.
- Keep existing wallet and Blood regression tests behavior-preserving; this hardening work does not alter their semantics.

### Optional endpoint extraction

The production/dev URL construction is duplicated across client modules. Extract only the connection-critical calculation into a pure `client/endpoints.js`, then test HTTPS same-origin, custom ports, localhost, IPv4, and IPv6. Do not turn this into a broad menu API refactor.

## H2.2 Build gate

Add `scripts/verify-build-output.mjs` or equivalent checks around the existing build:

- production build and stamp exit 0;
- strict Rollup warning policy passes;
- expected JS exists and is non-empty;
- no public source map exists;
- `window.__BUILD_ID__`, JS query stamp, and CSS query stamp agree;
- recomputing the content hash agrees with the stamped ID;
- no unexpected extra JS chunk exists while `inlineDynamicImports` remains an explicit assumption;
- initial regression ceilings:
  - raw JS ≤ 4,650,000 bytes;
  - gzip JS ≤ 1,100,000 bytes.

These are guardrails against regression, not final performance targets. Correct stale `webpack` wording in `scripts/stamp-build.mjs` while touching it.

## H2.3 Built-bundle browser smoke

Add `scripts/verify-release-browser.mjs`. It owns and cleans up:

```text
MAP=visage MODE=CTF BOT_FILL=0 ROTATE=0 npx tsx server/serverMain.js
node scripts/static-serve.mjs public 8099
```

Requirements:

- refuse to run over occupied required ports;
- kill only processes it started;
- launch two separate Chrome processes with SwiftShader and anti-throttle flags;
- load the production bundle, never Vite source modules;
- collect page errors, console errors, rejected requests, shader failures, and unhandled promises.

Smoke assertions:

1. HTML and JS build IDs agree.
2. `/mapinfo` says ready, `visage`, `CTF`, and the current protocol.
3. Both clients connect as spectators with no local body before PLAY.
4. The real PLAY button deploys each client exactly once.
5. Each client receives raw and smooth local entities and sees the other player.
6. Team allocation is valid.
7. `MatchState` is CTF and exactly two valid flags exist.
8. A controlled tagged Babylon target exercises real `drawHitscan()` flesh classification and high-tier blood-wall FX.
9. High and low FX tiers produce bounded expected pool usage; repeated bursts reuse meshes/materials; airborne entries retire.
10. No browser error survives the run.

Do not make timing-fragile exact HP reads part of the mandatory smoke.

## H2.4 Soak and post-deploy gates

Promote `_work/tick-soak.js` to a maintained `scripts/verify-tick-soak.mjs` with exit-code-producing bounds:

- active map/mode are Visage/CTF;
- default 400,000 ticks complete without exception;
- ignore warmup buckets;
- final p95 tick cost is no more than 50% above warm p95;
- post-warm heap growth stays below 64 MiB;
- exactly two flags remain;
- bots, pickups, movers, messages, events, and entities remain bounded.

Keep the slower `_probe-ctf.mjs` steal/drop/return/capture flow as `verify:soak:ctf`, not a per-commit gate.

Extend `verify-live-connect.mjs` into `verify:postdeploy`:

- configurable `FRAG_URL`;
- release/protocol/build identity agreement;
- spectator-before-PLAY;
- real deploy and replicated entity;
- public `/mapinfo` and WSS path.

## Stale verifier disposition

Do not let known-stale scripts block H2. Quarantine them from the release command and repair them deliberately:

| Script group | Action |
|---|---|
| movement, mobile, viewmodel, fire attachment, firing FX, kill feedback | Repair the pre-deploy assumption using one shared “connect spectator → PLAY → wait entities” helper |
| netcode | Change to one browser process per client; retain as extended diagnostic rather than sole gate |
| weapon states, 1v1 | Keep as extended/soak after current deploy logic and timing assumptions are repaired |
| old `common/maps` verifier, Grove-only mesh diagnostics, SciFi box-arena check | Retire from the active Visage release gate; preserve only if still useful as extraction/development diagnostics |
| match recorder scripts that always exit 0 | Keep as recorders; never label them assertion gates |
| map rotation verifier | Keep outside the pinned-Visage gate until rotation is intentionally re-enabled |

## H2 acceptance

- `npm run verify:release` is the only pre-release command operators need to remember.
- It fails on a build warning, protocol mismatch, browser error, failed active-map contract, failed PLAY flow, or renderer regression.
- Soaks are explicit nightly/manual gates and report thresholds, not just statistics.
- A broken diagnostic cannot create a false red release; an excluded diagnostic cannot create false confidence.

---

# Milestone H3 — Reproducible deployment and rollback

**Priority:** P1  
**Purpose:** ship one immutable, dependency-exact client/server generation

## H3.1 Add release identity and health before changing topology

### Release manifest

Extend `scripts/stamp-build.mjs` to produce `public/release.json` containing:

- deterministic `releaseId` such as `<git-sha>-<client-build-id>`;
- Git revision;
- client build ID;
- `GAME_PROTOCOL`;
- SHA-256 of `package-lock.json`;
- build timestamp;
- build Node/npm versions.

Stamp `window.__RELEASE_ID__` beside the existing build ID. Add `server/releaseInfo.js` to validate and expose the same immutable manifest. Production startup should fail if the manifest is absent or malformed.

### Runtime endpoints

In `server/serverMain.js`, add strict routes:

- `/healthz`: cheap process liveness and identity;
- `/readyz`: `200` only after HTTP listener, game listener, active map/collision, and persistent-state initialization are ready, otherwise `503`;
- `/version`: release/build/protocol/lock identity;
- `/mapinfo`: retain existing fields, add identity and `ready`, return `503` while unready;
- unknown routes: `404`.

In `server/GameInstance.js`:

- expose map-ready/map-load-error state;
- make map load failure keep readiness false;
- support configured `GAME_HOST`/`GAME_PORT`;
- add graceful close behavior for game listener, gateway, bridges, timers, and integrations.

In `client/clientMain.js`:

- retry `/mapinfo` briefly with bounded backoff;
- require ready state and matching release/build/protocol before opening WSS;
- show a bounded “updating arena” state and cache-busted reload on generation mismatch;
- never silently fall back to `DEFAULT_MAP_ID` in production.

The socket handshake remains the authoritative protocol check; HTTP identity is an additional deployment guard.

## H3.2 Make release inputs deterministic

Track and deploy:

- `package.json`;
- `package-lock.json`;
- `patches/`;
- built `public/`;
- `client/`, `common/`, `server/`, required `scripts/`;
- PM2 and nginx fragments introduced below.

Add to `package.json`:

- pinned package manager metadata;
- supported Node engine;
- `start:production` and verification scripts.

Remote runtime install:

```bash
env -u NODE_ENV npm ci --include=dev
```

Verify both nengi patches applied, `tsx` exists, and lock SHA agrees with `release.json`. Build the browser locally once; do not rebuild it on production after it has been verified.

## H3.3 Move to staged immutable releases

Target layout:

```text
/var/www/frag-arena/
  current -> releases/<release-id>
  previous -> releases/<previous-release-id>
  releases/<release-id>/...

/var/lib/frag-arena/
  data/
  rotation-state.json
  deploy-journal.jsonl

/etc/frag-arena/
  frag-arena.env
```

Add configurable `DATA_DIR` and `ROTATION_STATE_FILE`. Preserve current atomic write behavior. Migrate existing state once under a backup and controlled outage; never let old and new generations write the same state concurrently.

Add `ops/rsync-excludes.txt` with anchored exclusions including:

```text
/data/
/.env
/.rotation-state.json
/node_modules/
/.git/
/_work/
/_convert/
/_incoming/
/scratch/
/backups/
*.bak*
*.map
```

Never use an unanchored `maps` rule because it can match `public/assets/maps`.

## H3.4 Track process and proxy configuration

Add:

- `.env.example`
  - document hosts, ports, data/state paths, capacity, bots, integrations, logging, and timeout variables;
  - mark development overrides explicitly.
- `scripts/run-production.sh`
  - clear inherited development foot-guns before executing release-local `tsx`.
- `ecosystem.config.cjs`
  - only the `frag-arena` process;
  - fork mode, one instance, release symlink cwd;
  - `wait_ready`, autorestart, restart delay, timeouts, memory ceiling, timestamped logs;
  - preserve automatic restart after clean exit because restart-based rotation depends on it.
- `ops/nginx/frag-arena.inc`
  - exact `/ws`, `/mapinfo`, `/healthz`, `/readyz`, `/version`, and optional `/agent` routes;
  - WebSocket upgrade and idle timeout;
  - `index.html` and `release.json` no-store;
  - immutable caching only for genuinely content-versioned assets;
  - deny public source maps;
  - switch static root and all runtime upstream ports as one generation.

Keep certificates and unrelated droplet applications outside this tracked include.

## H3.5 Staging and cutover procedure

### Candidate staging

1. Require a clean local source tree.
2. Run `npm ci --include=dev`, `npm run verify:release`, and manifest validation.
3. Rsync to `/var/www/frag-arena/releases/<release-id>/`, using anchored exclusions and never deletion.
4. Run remote `env -u NODE_ENV npm ci --include=dev` in that fresh release.
5. Validate lock hash, patches, launcher, manifest, and required static files.
6. Start the candidate on alternate loopback ports with isolated temporary state and outward integrations disabled.
7. Run health, mapinfo, WSS, protocol, and local browser smoke.
8. Stop the candidate. Do not point production at it yet.

### Atomic production cutover

1. Put only this site’s dynamic game routes into a short maintenance response.
2. Gracefully stop only the `frag-arena` PM2 process.
3. Snapshot persistent state.
4. Point `current` at the candidate and start it against real state.
5. Wait for `/readyz`; require exact release/build/protocol/lock/map identity.
6. Validate the candidate nginx include with `nginx -t`.
7. Atomically switch static root, `/mapinfo`, and `/ws` in the same nginx reload.
8. Run `verify:postdeploy` publicly.
9. Record the result in `deploy-journal.jsonl`.
10. Retain at least two previous immutable releases.

This intentionally accepts a short reconnect window. It does not permit a mixed old-client/new-server window or concurrent writers.

### Rollback

1. Re-enter the short dynamic-route maintenance state.
2. Stop the failed `frag-arena` generation.
3. Point `current` back to the previous release.
4. Start it using the same controlled environment and persistent state.
5. Require its `/readyz`.
6. Restore the previous nginx generation and reload only after `nginx -t`.
7. Run the same public post-deploy verifier.
8. Leave the failed release intact for diagnosis.

Never rollback by rsyncing old files over new files, deleting the tree, restoring an old data snapshot during ordinary application rollback, or touching unrelated PM2 applications.

## H3 acceptance

A release is valid only when all of these agree:

- HTML build/release stamps;
- `release.json` Git/lock/build/protocol identity;
- `/version`, `/readyz`, and `/mapinfo` identity;
- WSS handshake protocol;
- browser-loaded generation;
- PM2 online generation.

Dependency additions cannot reach production against stale modules. A failed health or browser probe can restore the prior whole generation without restoring or mutating ordinary game data.

---

# Milestone H4 — Cold time-to-PLAY

**Priority:** P1 after H1/H2  
**Purpose:** stop making every asset in the game part of the join critical path

## H4.0 Add stable measurements first

Instrument performance marks in:

- `client/clientMain.js`: entry, mapinfo start/end;
- `client/graphics/BABYLONRenderer.js`: renderer created, map geometry/collision ready;
- `client/graphics/Viewmodel.js`: spawn viewmodel ready;
- `client/Simulator.js`: critical assets ready, PLAY enabled, optional prefetch complete;
- first stable rendered frame after deploy.

Collect at least five cold and warm runs for desktop, throttled mobile, slow-network profiles, and old-cache-to-new-release behavior. Capture CDP network events, Resource Timing, Long Tasks, peak heap, normalized duplicate URL starts, and Babylon mesh/texture/skeleton counts.

Keep the current baseline in the report so improvements are measured against 29.4 s cold and 24.6 s warm, not judged by feel.

## H4.1 Start boot earlier

- `client/clientMain.js`
  - Replace `window.onload` gating with immediate/`DOMContentLoaded` guarded boot. The production script already appears after required DOM.
  - This overlaps mapinfo, map setup, and spawn-rig work with eager page resources.

One localized change, one isolated deployment.

## H4.2 Replace the universal preload gate with a critical gate

Critical before PLAY:

1. active map geometry is imported;
2. client collision flags are installed;
3. spawn-pistol viewmodel is ready;
4. connection/protocol is accepted;
5. a visible cheap fallback exists for any remote character whose full body is still loading.

Changes:

- `BABYLONRenderer._loadMeshMap()` exposes a `mapReady` promise and fatal load state.
- `Viewmodel` exposes its existing load promise safely.
- `Simulator` separates `_criticalAssetsReady` from background prefetch completion.
- `createPlayerFactory.js` keeps a visible neutral/team-readable proxy until `CharacterModel` is ready, then hides it. Never create an invisible opponent while the 20 MB body parses.
- Keep current behavior behind a temporary `legacy` preload profile for one release.

Do **not** block PLAY on:

- non-spawn weapon rigs;
- armor variants;
- announcer roster;
- unused props/pickups;
- sky/cosmetic bodies;
- offline vertex-light sidecars or texture variants that are not collision-critical;
- shader warm copies for effects not yet visible.

## H4.3 Deduplicate and serialize heavy parse work

In `client/graphics/assetPreloader.js`:

- canonicalize and deduplicate `{loader kind, URL}` jobs;
- deduplicate rifle/plasma and shotgun/flak shared rig URLs;
- exclude disabled weapons;
- deduplicate third-person weapon URLs;
- never warm a prop, dispose it, and immediately import it again for its cache template;
- use the persistent prop-template path when a prop deserves preload, otherwise leave it genuinely lazy;
- allow at most one heavy `ImportMeshAsync` parse at a time in the background queue;
- yield a frame between heavy jobs;
- use a separate small pool for fetch-only work.

Preserve the deliberate arena-dressing order that seeds shared trim textures before dependent pieces; do not replace it with unrestricted `Promise.all`.

## H4.4 Prioritize optional work by likely need

After PLAY is available:

1. bodies for players present in the current snapshot;
2. props/pickups currently replicated;
3. likely next weapon/viewmodel;
4. remaining held-weapon and armor templates;
5. announcer and low-frequency SFX;
6. menu/codex media.

Audio changes:

- `client/graphics/WeaponAudio.js`
  - first gesture loads spawn-pistol essentials, common impact/pain/death, current mode callout, and fight cue;
  - queue the rest in the background;
  - retain procedural fallbacks.
- Remove announcer warming from the blocking asset list.
- `client/graphics/MusicManager.js` / `public/index.html`
  - avoid auto-preloading both full music tracks;
  - defer the match track until PLAY is ready or imminent;
  - verify real iOS/Android audio unlock before changing production preload behavior.

## H4.5 Delivery improvements, separately deployed

- Enable HTTP/2 at nginx before adding a separate asset hostname.
- Add correct GLB/GLTF/OBJ/MTL MIME types.
- Prefer precompressed Brotli/gzip assets or edge compression over compressing large GLBs on every request.
- Give content-versioned resources long-lived immutable caching; retain short caching for mutable unversioned paths.
- Preserve no-store for mapinfo/release identity.
- Keep assets same-origin initially; a new hostname does not reduce parse time and adds CORS/root-URL failure modes.

Measured compression opportunities include approximately 6–6.5 MiB saved on the hero GLB and a reduction of the current JS from about 0.96 MiB gzip to about 0.70 MiB Brotli. Validate CPU and real transfer behavior rather than assuming every format benefits.

## H4 acceptance budgets

Measure p75 across at least five fresh-profile runs:

| Metric | Initial target |
|---|---:|
| Desktop FCP | ≤ 1.5 s |
| 4× CPU mobile-profile FCP | ≤ 3.0 s |
| Critical transfer before PLAY | ≤ 8 MiB |
| Critical request count | ≤ 120 |
| PLAY at 10 Mbps / 100 ms desktop | ≤ 8 s |
| PLAY at 4 Mbps / 150 ms mobile profile | ≤ 18 s |
| Warm desktop PLAY | ≤ 4 s and ≤ 0.5 MiB transferred |
| Heavy glTF parse concurrency after critical readiness | 1 |
| Peak JS heap | no >10% regression from captured baseline |

Behavioral requirements:

- active map collision is ready before deployment;
- no invisible remote player;
- first shot, pickup, flag, and weapon change remain hitch-free within the agreed device budget;
- no non-spawn rig or full announcer roster blocks PLAY;
- a failed optional asset uses an existing fallback and does not disconnect the player.

## H4 rollback

- Ship measurement marks before loader behavior.
- Keep `legacy` and `critical` preload profiles for one release.
- Preserve current import paths until replacements pass.
- Revert delivery headers independently from loader code.
- Never combine this batch with model re-export, AssetContainer adoption, or Vite chunking.

---

# Milestone H5 — Parse once, instantiate many

**Priority:** P2, only after H4 metrics and gate are stable  
**Mechanism:** Babylon 9.17 `LoadAssetContainerAsync` + `instantiateModelsToScene()`

The old Babylon 4-era comments are obsolete: Babylon 9 can clone skeletons, animation groups, linked transform nodes, and morph-target managers. Adopt this behind independent flags, one asset category at a time.

## H5.1 Character body container

Replace per-entity parsing behind a feature flag in `client/graphics/CharacterModel.js`:

- load the body container once per scene;
- instantiate geometry with cloned skeleton/animation groups;
- use `cloneMaterials: true` because team/neutral uniforms and emissive setup mutate materials;
- keep the current import path as fallback.

Required tests:

- directional locomotion and upper-body masks;
- hand/head/armor bone links;
- team and neutral materials;
- death/corpse lifecycle;
- late join and delete-during-load;
- six simultaneous remote players;
- repeated disconnect/reconnect and disposal;
- memory/mesh/texture/skeleton counts return near post-warm baseline.

Acceptance: the 19.65 MiB hero body parses once per scene regardless of player count.

## H5.2 Viewmodel container

In `client/graphics/Viewmodel.js` and its preload path:

- cache one container per unique rig URL;
- instantiate only the currently equipped rig;
- dispose the instance on swap, not shared source resources;
- remove full-roster warm/import/dispose behavior.

Test every draw/fire/reload/ADS clip and a ten-minute repeated-swap soak. Acceptance: a repeated equip performs no network fetch and no glTF parse.

## H5.3 Flag container

In `client/factories/createFactories.js`:

- instantiate both flags from one source container with cloned morph managers, animations, and materials;
- verify independent team texture, wave phase, carry/drop/return, and disposal.

Keep the existing conservative fresh-import path until those checks pass.

## H5.4 What not to convert

- Static props already have a useful shared template/clone cache; fix warm/dispose duplication instead.
- Arena dressing already uses hardware instances.
- The active map appears once, so AssetContainer conversion offers little startup value.

## H5 acceptance

- body GLB parses once;
- repeat viewmodel equips do not parse;
- flags animate and recolor independently;
- ten minutes of joins/leaves/swaps returns mesh, texture, skeleton, and heap counts to within 10% of post-warm baseline;
- existing character, viewmodel, armor, flag, map, and collision checks remain green.

---

# Milestone H6 — Later payload and bundle work

These are valuable, but higher-risk and deliberately isolated from H4/H5.

## H6.1 Shipping hero export

The hero body contains 120 clips while gameplay maps only a small set. Update the existing Blender/export pipeline to produce:

- a trimmed shipping body containing only mapped clips;
- a full playground/audition body retained outside the critical release path.

Then evaluate external WebP or KTX2/Basis textures. Embedded PNGs account for much more payload than geometry. Do not start with Draco/meshopt: hero geometry is a relatively small fraction of the file.

## H6.2 Vite module/chunk migration

Current output intentionally uses IIFE, a fixed filename, and `inlineDynamicImports`. In a separate build-only batch:

- move playground/development-only code out of the production static graph;
- emit ESM with content-hashed chunks;
- dynamically import genuinely deferred features;
- update `stamp-build.mjs` to consume a Vite manifest rather than assume one fixed file;
- preserve curated deep Babylon imports.

Chunking only helps cold load if parsing/loading is actually delayed. Splitting Babylon into several eagerly loaded files is not a win.

## H6.3 Defer low-value format churn

Do not prioritize:

- active OBJ map conversion, because it is small and conversion risks collision/material/light-bake behavior;
- a separate asset hostname before same-origin HTTP/2/caching is measured;
- simultaneous KTX2, model trimming, AssetContainer, and chunk changes.

---

# Milestone H7 — Operations, capacity, and bounded growth

**Priority:** P1/P2 alongside H3–H5

## Telemetry

Emit a structured startup record containing release/build/protocol/lock/map/Node identity. Track:

- 40 Hz tick duration, p50/p95/p99, and overruns;
- event-loop delay;
- CPU and RSS/heap;
- connected sockets, spectators, deployed humans, bots, queue depth;
- PM2 restart reason/count, distinguishing planned match rotation from crashes;
- map load duration/failure;
- handshake rejects by reason;
- HTTP errors and rate-limit rejects;
- match start/completion and objective flow;
- persistent ledger write/backup failures without logging secrets.

Add PM2 log rotation/retention and an external synthetic check for ready/version/mapinfo/WSS/browser deploy.

## Capacity and state

- Establish controlled capacity numbers rather than relying on the observed roughly 30% CPU/179 MB eight-bot snapshot.
- Run the bounded 400k-tick soak and a real multi-client soak.
- Measure before imposing socket command limits; then add payload/rate ceilings with counters so valid 40 Hz play is not accidentally throttled.
- Keep ledger semantics unchanged, but move state outside releases, preserve atomic writes, back it up, and test restore.
- Startup corruption must never silently replace valid persistent state with an empty ledger.

## Incremental module boundaries

Do not schedule a monolith rewrite. When H1–H7 touches a stable responsibility, extract only that responsibility with behavior-preserving tests. Candidate seams:

```text
server/match/MatchLifecycle.js
server/match/SpawnSystem.js
server/match/DamageSystem.js
server/match/ObjectiveSystem.js
server/match/SpectatorSystem.js
server/runtime/Readiness.js
server/runtime/ReleaseInfo.js

client/graphics/effects/
client/graphics/characters/
client/graphics/weapons/
client/graphics/loading/
```

Rules:

- extraction is a separate commit from behavior change where practical;
- no new service layer without at least two real callers;
- preserve raw/smooth replicated-field mirroring;
- keep one focused regression test around every extracted boundary;
- never delay P0 fixes for architectural cleanup.

---

# Recommended delivery sequence

| Release | Contents | Must not include |
|---|---|---|
| H1a | Babylon exports, render probe, strict warning policy | protocol, loader changes |
| H1b | malformed URI survival test/fix | wallet semantic changes |
| H1c | game protocol handshake, update/refusal state, mapinfo protocol | deployment topology, gameplay schema changes beyond version field |
| H1d | sourcemap generation/serving cleanup; optional stale network-state UI | loader and asset changes |
| H2 | release command, active contract, repaired fast checks, built-browser smoke, soak commands | production topology change |
| H3a | release manifest, health/readiness/version, configurable hosts/ports | symlink cutover |
| H3b | staged immutable releases, state-path migration, tracked PM2/nginx, atomic cutover/rollback | preload behavior |
| H4a | boot marks and repeatable baseline reports | behavior changes |
| H4b | earlier boot, critical PLAY gate, proxy body, dedupe/background queue/audio deferral | AssetContainer or model re-export |
| H4c | HTTP/2, MIME, compression/cache policy | JS chunk migration |
| H5 | body, viewmodel, then flag containers as three separately flagged changes | hero export and Vite chunks |
| H6 | trimmed shipping hero, then ESM/chunks as separate projects | simultaneous loader architecture change |

Every release runs `verify:release` before staging and `verify:postdeploy` after cutover. If post-deploy verification fails, roll back the whole generation before debugging live.

---

# Definition of done

## Correctness

- Babylon post-processing and blood wall FX are covered and error-free.
- Malformed encoded paths return controlled errors without process restart.
- Missing, stale, and future game protocol versions fail closed with a useful client state.
- No production source map is generated or publicly served.

## Verification

- One release command builds and validates the active source contract and built-browser CTF flow.
- The smoke covers spectator → PLAY → replicated entity → flags → renderer FX using two browser processes.
- Long tests are thresholded soaks, not success-by-timeout or success-by-exit-zero recorders.
- Stale scripts are either repaired, explicitly diagnostic, or excluded from release claims.

## Deployment

- Every release contains exact lockfile, patches, runtime dependencies, source, build, and identity.
- Candidate readiness is checked before public cutover.
- Static root, mapinfo, and WSS switch as one generation.
- Persistent data is outside immutable releases and excluded from rsync.
- Rollback restores a whole prior generation without overwriting ordinary game data.

## Performance

- PLAY is gated only by active collision, spawn rig, connection, and visible fallbacks.
- Initial p75 targets in H4 are met on measured desktop/mobile profiles.
- No duplicate heavy parse runs for the same asset.
- Remote players are never invisible while loading.
- Character/viewmodel/flag container work proves bounded resource counts before legacy imports are removed.

## Operations

- Release identity is visible in startup logs and health endpoints.
- Tick, event loop, memory, sockets, players, restarts, map loading, and handshake failures are observable.
- A controlled soak establishes capacity and catches monotonic collection/heap growth.

---

## First implementation slice

Start with **H1a only**: missing Babylon exports, real render regression coverage, and strict build-warning handling. It is the smallest independently verifiable correction and establishes the rule that future Vite warnings are release failures. Then ship H1b and H1c separately so an HTTP hardening regression cannot be confused with the intentional old-client protocol rejection.
