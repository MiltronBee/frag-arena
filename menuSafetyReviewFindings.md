# Menu Safety — Review Findings and Fix Brief

**Prepared:** 2026-07-22  
**Scope:** Review of the implemented connect-as-spectator / explicit-deploy menu-safety feature.  
**Audience:** The implementation agent responsible for corrective follow-up.

## Goal

Preserve the implemented architecture:

- A connected socket starts as a non-spatial spectator.
- No `PlayerCharacter` exists before explicit deployment.
- Spectators do not count as humans or retire autofill bots.
- Gameplay commands from spectators are rejected server-side.
- Opening Settings after deployment does not pause combat or grant safety.

Fix the verified issues below without redesigning unrelated gameplay, rendering, weapons, or textures.

---

## P1 — Combat logging denies score and immediately replaces the player

### Evidence

`server/GameInstance.js:425-449` removes a deployed player's raw/smooth entities on disconnect, decrements `_humanCount`, and immediately invokes `_rebalanceBots()`.

The disconnect path does **not** pass through normal death, scoring, kill attribution, `Killed`, or Proof-of-Blood bookkeeping.

### Failure scenario

1. Player A damages Player B to 1 HP.
2. Player B closes the tab or disconnects.
3. Player B disappears without a death.
4. Player A receives no frag, team score, kill event, or mining credit.
5. Autofill immediately replaces Player B with a fresh bot.

This makes disconnecting advantageous.

### Required fix

- Track the last valid attacker and damage timestamp on the authoritative player handle/entity.
- When a live deployed player disconnects:
  - resolve a normal server-authoritative death;
  - credit the last attacker when damage occurred within **5 seconds**;
  - otherwise record an unattributed suicide/forfeit;
  - emit the usual score, `Killed`, and Proof-of-Blood consequences;
  - clean up the disconnected entity pair safely;
  - delay autofill replacement by the normal respawn delay instead of replacing the player immediately.
- A spectator disconnect must remain a no-op for scoring and bot balance.

### Acceptance checks

- Disconnect within five seconds of enemy damage credits that enemy exactly once.
- Disconnect without a recent attacker records no enemy frag.
- `_humanCount` decrements exactly once.
- The replacement bot does not appear before the configured delay.
- No entity, channel, mesh, name, timer, or respawn handle leaks after cleanup.

---

## P1 — Existing verification harnesses never deploy

### Evidence

The following harnesses wait for `myRawEntity` immediately after page connection, but the new lifecycle intentionally creates no entity until `requestDeploy()`:

- `scripts/verify-netcode.mjs:57-69`
- `scripts/verify-bots.mjs:52-58`
- `scripts/verify-1v1.mjs:49-65`
- `scripts/verify-live-connect.mjs:29-36`

`npm run verify` invokes `scripts/verify-netcode.mjs`, so the default verification path is affected.

### Failure scenario

A harness connects successfully, remains a spectator, then times out waiting for `myRawEntity`. The product may work while CI reports failure, or regressions may go unchecked because the suite is no longer runnable.

### Required fix

For every harness that expects a combatant:

1. Wait for `simulator._connectionState === 'connected'`.
2. Call `window.gameClient.simulator.requestDeploy()`.
3. Wait for `myRawEntity` and `mySmoothEntity`.
4. Continue with the existing test.

Do **not** auto-deploy production clients merely to preserve old tests.

### Acceptance checks

- `npm run verify` reaches its gameplay assertions instead of timing out.
- `npm run verify:bots` deploys before checking bot combat.
- `npm run verify:1v1` explicitly deploys both clients.
- `verify-live-connect.mjs` verifies both spectator connection and explicit deployment.

---

## P1 — `_probe-menu-safety.mjs` can print PASS after Phase 2 fails to start

### Evidence

`scripts/_probe-menu-safety.mjs:44-59` starts child processes without `detached: true`, but later tries to terminate process groups with `process.kill(-pid)`.

The server can survive Phase 1. Phase 2 then fails with `EADDRINUSE` on ports 8078/8079, while the probe continues against the surviving Phase-1 server and can print:

```text
menu-safety probe verdict: PASS (8/8)
```

This behavior was reproduced during review.

### Required fix

- Spawn owned server/Vite processes with a lifecycle that can be terminated reliably:
  - either `detached: true` with process-group termination;
  - or kill the exact process tree without negative PIDs.
- Await process exit and confirmed release of ports 8078/8079 before Phase 2.
- Reset phase-specific server logs before asserting Phase-2 events.
- Detect child `error` and nonzero `exit` events.
- Fail immediately if the intended Phase-2 server did not bind.
- Do not continue a phase against an old server process.

### Acceptance checks

- Phase 1's server PID is gone before Phase 2 starts.
- Ports 8078 and 8079 are free before the Phase-2 spawn.
- An intentional Phase-2 bind failure makes the probe exit nonzero.
- Phase-2 assertions cannot match Phase-1 logs.
- The probe leaves no server, Vite, or Chrome process behind.

---

## P2 — Spectator timeout ignores real menu activity

### Evidence

- `server/GameInstance.js:398-400` stores `_connectedAt` once.
- `server/GameInstance.js:2140-2146` disconnects spectators based only on elapsed time since connection.

No callsign input, settings interaction, menu navigation, heartbeat, or other activity refreshes the timeout.

### Failure scenario

A player spends over three minutes reading instructions or configuring controls. The server disconnects the active menu session. PLAY can no longer deploy, and the UI falls to `UPLINK LOST`.

### Required fix

Choose and implement one explicit contract:

1. **True inactivity timeout:** introduce a lightweight, rate-limited activity/heartbeat command and refresh a server-owned `lastSpectatorActivityAt`; or
2. **Hard menu session cap:** clearly name and present it as a session limit rather than AFK detection.

Recommended: true inactivity timeout. Do not trust DOM state as combat authority; the activity command may only keep a spectator socket alive.

### Acceptance checks

- An untouched spectator is disconnected after the configured idle period.
- A spectator who sends permitted activity remains connected.
- Activity cannot create an entity, retire a bot, move, fire, or bypass deployment.
- Activity messages are rate-limited.

---

## P2 — Spawn-immune player remains physically solid

### Evidence

- Spawn immunity is assigned at `server/GameInstance.js:633-637`.
- The authoritative raw mesh keeps collision enabled at `server/GameInstance.js:586-589`.
- Damage is rejected at `server/GameInstance.js:1657-1662`.
- Projectiles skip immune targets, but movement collision is not disabled.

### Failure scenario

For up to one second, an immune player can still occupy a doorway, overlap another spawn, or obstruct player movement while taking no damage.

### Required fix

Make the immune player non-blocking to other players for the immunity window while preserving collision with world geometry.

- Restore normal player collision immediately when immunity expires or is cancelled by action/pickup interaction.
- Apply the state consistently to raw and smooth representations where relevant.
- Do not solve this by disabling all collision and allowing the player to fall through the map.
- If Babylon's current collision system cannot separate player and world masks cleanly, use an explicit player-player collision exclusion in the movement collision path.

### Acceptance checks

- A player can pass through an idle spawn-immune player.
- The immune player still collides with floors and walls.
- Movement, fire, jump, dodge, throw, or pickup interaction restores the normal state immediately.
- Natural immunity expiry restores the normal state.
- Hitscan and projectiles do not stop on an immune player.

---

## P3 — Settings warning remains stale after death

### Evidence

The banner state is calculated only when Settings opens at `client/Simulator.js:2187-2202`. Death is observed later at `client/Simulator.js:2358-2364`, but the already-open banner is not refreshed.

### Failure scenario

A player opens Settings while alive and sees:

```text
COMBAT ACTIVE — CHARACTER VULNERABLE
```

They die while the panel remains open, but the warning stays unchanged.

### Required fix

Refresh the Settings status whenever local alive/dead state changes:

- alive and deployed: `COMBAT ACTIVE — CHARACTER VULNERABLE`;
- dead: `YOU DIED — RESPAWNING`;
- pre-deploy menu: no combat warning.

Centralize this in a small status-update method used by both `_openSettings()` and the existing death-state transition.

### Acceptance checks

- Opening Settings alive shows the vulnerability warning.
- Dying while Settings remains open updates the warning immediately.
- Respawning while Settings remains open restores the live-combat warning.
- Opening Settings before deployment shows no combat warning.

---

## Required regression coverage

Extend `scripts/_probe-menu-safety.mjs` or add focused harnesses for:

1. Connect and remain spectator: no local entity, no bot retirement.
2. Forged pre-deploy movement/fire/switch commands: no effect and no crash.
3. Deploy once: exactly one entity pair and one human count increment.
4. Duplicate deploy requests: no duplicate entity or bot retirement.
5. Settings while deployed: full incoming damage remains active.
6. Death while Settings is open: warning changes correctly.
7. Spawn shield: damage blocked, action cancels it, movement collision is ghosted only during immunity.
8. Disconnect under recent enemy damage: correct kill attribution and delayed bot replacement.
9. Spectator idle/activity behavior.
10. Process cleanup: both probe phases bind the intended fresh server and leave no processes behind.

Also update and run the existing gameplay harnesses after adding explicit deployment.

---

## Verification commands

Run from `/home/miltron/unreal`:

```bash
npm run build
node scripts/_probe-menu-safety.mjs
npm run verify
npm run verify:bots
npm run verify:1v1
```

Report every skipped or failed command faithfully. A probe that ran against the wrong server process is invalid even if its assertions printed PASS.

---

## Review disposition

The implementation has the correct foundation and successfully establishes connect-as-spectator behavior. Do **not** redesign that foundation. Fix the three P1 issues before shipping; address the P2/P3 issues in the same corrective pass if practical.
