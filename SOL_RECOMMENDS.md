# Frag Arena: Solana + realtime multiplayer recommendations

Last updated: 2026-07-14

## Outcome to optimize for

Frag Arena should feel like a late-1990s arena shooter in the browser. Gameplay
is entirely off-chain. Solana has one narrow job: send rewards after the
authoritative game server has finalized a result. Solana must not sit in player
admission, movement, firing, hit-registration, respawn, snapshots, matchmaking,
or the live scoreboard.

The practical split is:

- **Gameplay plane:** browser + regional authoritative game server. Inputs,
  prediction, reconciliation, interpolation, lag compensation, bots, pickups,
  damage, and match rules live here.
- **Reward plane:** after the server finalizes a match, an idempotent reward
  worker sends the earned SOL or SPL token to the player's submitted wallet.
  Confirmation is asynchronous and never blocks the next match, spawn, or shot.

This gives the game Solana rewards without turning the blockchain into a game
server or making a wallet a prerequisite for play.

## What already works

The repository is well beyond a static demo:

- Babylon.js renders a real first-person arena with mobile controls, weapon
  viewmodels, third-person characters, pooled combat FX, audio, and a HUD.
- nengi provides an authoritative server, client prediction, reconciliation,
  interpolation, network culling primitives, and a historian used for rewound
  hitscan checks.
- Shared movement already models UT99-style ground acceleration, friction,
  jumping, air control, and double-tap dodging.
- Damage, kills, deaths, respawning, four weapons, deterministic spread,
  projectiles, kill feedback, and server-driven bots already exist.
- The nengi connection handshake accepts arbitrary JSON, but wallet state does
  not need to be added to it for a rewards-only integration.

## Findings that matter most

### 1. The client currently schedules two animation loops

`clientMain.js` owns the real `requestAnimationFrame` loop, while
`BABYLONRenderer` also calls `engine.runRenderLoop` with an empty callback. The
second callback still schedules browser frames and adds needless main-thread
wakeups. Keep one RAF owner and render exactly once per visible frame.

### 2. Simulation time is partly client-controlled

`MoveCommand.delta` comes from the browser. Movement clamps it, but weapon timers
currently receive the original value. A modified client can accelerate cooldowns
or reloads, and a burst of otherwise valid commands can consume more simulated
time than the server elapsed. Use the same sanitized delta everywhere and enforce
a small per-client input-time budget on the server.

### 3. The server loop drifts and does not perform bounded catch-up

The current loop performs at most one update when late and resets its clock to
the current time. Under a stall this loses simulation time and produces uneven
snapshot cadence. Use a monotonic fixed timestep, accumulate elapsed time, run a
small bounded number of catch-up steps, and drop only a pathological backlog.

### 4. WebSocket is acceptable for the current milestone, not the end state

Prediction hides normal latency, but TCP head-of-line blocking can still turn one
lost packet into a visible stall. Preserve the current WebSocket transport as a
universal fallback, then add WebTransport or a WebRTC data-channel transport
behind the same nengi-facing adapter. Do not rewrite gameplay around a transport.

### 5. The match is endless and results are not finalizable

There is no authoritative match clock, frag limit, or intermission. The game is
playable, but there is no definitive result from which a reward can safely be
calculated. A rewards system first needs explicit warmup/live/intermission states
and a server-finalized result. Wallets do not belong in the live player protocol.

### 6. Projectile collision can tunnel

Projectiles are advanced once per server update and checked at their endpoint.
Fast bolts can pass through a player or thin wall between ticks. Use a swept
segment/capsule test from previous to next position and obstacle dimensions rather
than the current fixed-radius approximation.

### 7. The current technology stack is intentionally old

Babylon 4.0.3, webpack 4, and nengi 1.18 are already patched for Node 24. A broad
framework upgrade in the same change as wallet and match work would multiply
risk. Stabilize the realtime protocol first, then migrate build tooling in a
separate, measured change with bundle and frame-time comparisons.

## Recommended Solana design: rewards only

### Wallet collection

Playing should never require a wallet. A player may attach a reward address in a
profile/reward screen before or after a match. Wallet Standard discovery is the
best browser UX, with a pasted address as a simple fallback if product policy
allows it.

If reward-address ownership must be proven, request a short-lived, single-use
message signature only when the address is attached or a reward is claimed. That
proof belongs to the reward API, not the nengi handshake. The player can still
join and play when the wallet, RPC, or the entire reward service is unavailable.

Never request a private key or seed phrase. If signatures are used, challenges
must be single-use, short-lived, domain-bound, and rate-limited.

### Reward flow

1. The authoritative server closes a match and writes an immutable result ID.
2. A reward policy calculates an amount from that server result, with caps and
   anti-abuse checks.
3. A durable ledger creates one payout row keyed by result ID + recipient. A
   unique constraint makes retries idempotent.
4. A separate worker sends the SOL/SPL transfer from a treasury signer or calls a
   dedicated claim program.
5. The worker stores the transaction signature, confirms it through RPC, and
   retries only transactions that are provably safe to retry.
6. The UI reports pending/confirmed/failed status independently of gameplay.

Good on-chain data:

- The reward transfer itself.
- An optional compact result/reward reference in a memo.

Keep off-chain:

- Every shot, movement input, pickup, damage event, or respawn.
- Login and server admission.
- Matchmaking, player identity, and the live leaderboard.
- Waiting for a transaction before entering or continuing play.
- Any client-authored score or reward calculation.

For an initial payout, a normal SOL or SPL transfer plus a compact memo reference
is enough. The Solana Memo program records text in transaction logs and is useful
for reconciling an off-chain reward ID with a transaction. Use devnet until abuse
controls, reward economics, idempotency, and production key management are
finished.

Official references:

- [Solana frontend client and Wallet Standard connectors](https://solana.com/docs/frontend/client)
- [Solana payment/memo transaction guide](https://solana.com/docs/payments/send-payments/payment-with-memo)
- [Solana Cookbook wallet and message-signing topics](https://solana.com/de/developers/cookbook)

## Realtime architecture target

```text
browser RAF (visuals)
  -> sample input
  -> predict shared movement immediately
  -> queue compact input command
  -> render once

regional game server (fixed timestep; no chain calls)
  -> validate and budget input time
  -> authoritative movement / weapon timers
  -> rewound hitscan and swept projectile collision
  -> pickups / match state / bots / final results
  -> snapshots and combat events

reward service (separate and asynchronous)
  -> consume finalized server result
  -> apply reward policy + abuse caps
  -> idempotent payout ledger
  -> send SOL/SPL reward
  -> confirm transaction and expose payout status
```

## Performance budget

Targets for a public browser build:

- Render: 60 FPS baseline, 120/144 FPS when the device and display allow it.
- Main-thread frame: under 8 ms at the 120 FPS quality tier; under 14 ms at the
  60 FPS tier.
- Authoritative simulation: fixed 30 Hz initially. Prediction renders local input
  immediately; 30 Hz offers a useful hit-reg improvement over 20 Hz without the
  bandwidth jump of 60 Hz.
- Snapshot payload: measure bytes/player/second before increasing tick rate.
- Server update: p95 below half a tick and p99 below one tick at target room size.
- No mesh, material, light, audio-context, or large-array allocation on fire.
- Adaptive resolution based on sustained frame time, with conservative mobile
  defaults and a user override.

Tick rate alone does not create responsive controls. Prediction, stable frame
pacing, compact packets, regional placement, and bounded server work matter more.

## Implementation order

### Now

- Remove the duplicate RAF and clamp visible-frame deltas.
- Change the server to a bounded fixed timestep.
- Sanitize command deltas consistently and add an input-time budget.
- Add a match timer, frag limit, intermission, and immutable finalized result.
- Keep wallet and RPC code out of the nengi handshake and gameplay process.
- Add automated tests for excessive deltas, match transitions, duplicate result
  finalization, duplicate payout requests, and existing prediction behavior.

### Next

- Add dynamic health/ammo pickups and swept projectile collision.
- Persist finalized results and the payout ledger in a transactional database.
- Send devnet rewards from a separate worker and confirm them asynchronously.
- Add server directory/matchmaking and deploy regional rooms.
- Instrument frame time, server tick time, reconciliation magnitude, RTT, jitter,
  snapshot size, packet loss (where transport exposes it), and RPC latency.

### Later

- Put transport behind WebTransport/WebRTC with WebSocket fallback.
- Upgrade Babylon/build tooling independently with visual and performance gates.
- Consider audited tournament prize logic only after authoritative results,
  replay evidence, abuse controls, treasury limits, and key management are
  production-ready.

## Definition of done

The architecture is ready for Solana rewards when two independent browsers can
play a fully off-chain authoritative match, the server alone finalizes the result
and reward amount, one result cannot pay twice, the reward worker can safely
recover from RPC/process failures, and chain settlement can never delay or break
gameplay.
