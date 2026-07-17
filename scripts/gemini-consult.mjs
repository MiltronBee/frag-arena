// Consult gemini-3.5-flash as a veteran id FPS/netcode engineering advisor.
// Pattern mirrors solMTG/scripts/gemini-consult.mjs.
import fs from 'node:fs'

const envRaw = fs.readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key =
  envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
  envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no ALT or GEMINI_API_KEY in solSoccer/.env')

const PERSONA = `You are a veteran id Software engineer with 25+ years of experience shipping networked FPS games. You worked on Quake, Quake III Arena, and Doom engines. You have deep expertise in client-server netcode, lag compensation, client-side prediction, server reconciliation, and entity interpolation at scale. You also have experience with modern browser-based game constraints (WebSockets, WebRTC, WebTransport, WASM). You are blunt, specific, and opinionated. You give concrete actionable recommendations with code-level detail when it matters. Your north star for this project: Unreal Tournament 99 in the browser — seamless, no perceivable lag or latency for the players.`

const BRIEF = `
PROJECT: Frag Arena — a browser-based arena FPS aiming to replicate the FEEL of Unreal Tournament 99.
Language: JavaScript (Node.js server, Babylon.js client). Running live at https://sol-pkmn.fun.

=== CURRENT STACK ===
- Renderer: Babylon.js 4.0.3 (client)
- Netcode library: nengi.js (fork of timetocode/nengi-babylon-3d-shooter, Apache-2.0)
- Transport: WebSocket (TCP) via patched 'ws' package — the intended UDP path (geckos.io / WebTransport) has NOT been implemented yet
- Server tick rate: 20 Hz (UPDATE_RATE constant)
- Physics / movement: custom velocity model in shared common/applyCommand.js (runs identically on client and server for prediction). Quake-style friction+acceleration, UT99 jump (JumpZ 325≈6.2m/s), air control 0.35, double-tap dodge (1.5x burst, 0.35s cooldown).
- Entity protocol: nengi entities with x/y/z + velX/velY/velZ replicated per-tick; client predicts own movement and reconciles against server corrections.
- Lag compensation: built into nengi's historian (server rewinds entity positions to the client's estimated render time for hitscan validation).
- Characters: animated GLB bodies (65-bone Universal Base Characters + Universal Animation Library 2 clips) rendered for remote players; own player is first-person viewmodel only.
- Weapons: 4-weapon loadout (Rifle/SMG/Shotgun/Pistol), visible in third-person on remote bodies (prop parented to hand_r bone).
- Kill feedback: FragLayer — kill feed, frag banner, hitmarker, directional damage arc, death cam. Client-predicted hitmarker (80-100ms visual confirm) upgraded to server confirm.

=== VERIFIED WORKING (via headless test scripts) ===
- Handshake + full 9/9 netcode suite (prediction, interpolation, lag-comp hitscan, reconciliation)
- Movement: 8/8 (jump arc, dodge burst 11.4 m/s, friction bleed, zero reconciliation errors)
- Kill feedback: 9/9
- Bot AI (5/5)

=== OPEN ISSUES / KNOWN GAPS ===

1. CRITICAL NETCODE BUG (late-joiner invisibility):
   When player A is already in the game and player B joins 4+ seconds later, B can see A but A never sees B.
   The 54-byte CREATE packet for B arrives at A's WebSocket ✓.
   nengi's Client.handleMessage receives it ✓.
   But client.readNetwork() never yields any createEntities for B.
   Working theory: nengi's Interpolator render-window stall — renderTime = now - interpDelay - chronus.averageTimeDifference.
   findInitialSnapshot returns null forever (snapshots array may be empty for the late-join entity's timeline).
   Impact: all human-vs-human late-joins are invisible. Bots are pre-spawned so they mask it.

2. TRANSPORT: still on TCP WebSocket. No UDP path yet. For a UT99-feel game this is architecturally wrong — TCP head-of-line blocking spikes latency under packet loss. Plan was to move to geckos.io (WebRTC data channels) or WebTransport (HTTP/3+QUIC). Haven't started.

3. ANIMATION GAPS: UAL2 (Universal Animation Library 2) has no run/shoot/death clips — currently using placeholder anims (Walk_Carry_Loop for run, OverhandThrow for shoot, Hit_Knockback for death). Need UAL1 (same rig, real locomotion clips) to fix. Bodies are also naked (no clothing/armor sourced yet).

4. ARENA: still a placeholder white plane + yellow obstacle boxes. No real level geometry.

5. PLAYER NAMES: the nengi protocol has no name field — kill feed says "Player <nid>".

6. GUN MOUNTS: third-person weapon props look passable but haven't been fine-tuned per-weapon.

=== ARCHITECTURE QUESTIONS FOR THE VETERAN ===

QUESTION 1 — LATE-JOINER BUG:
We're deep in nengi's internals. The interpolator seems to stall on entities that join after game start. We believe it's the render-window calculation using chronus.averageTimeDifference which may not be valid for freshly-added entities. How do you typically approach this kind of interpolation window stall in a custom netcode engine? What invariants should we check? Should we look at the snapshot timestamp derivation (server only stamps every UPDATE_RATE tick; intermediate ticks use prev+tickLength)?

QUESTION 2 — UDP vs TCP urgency:
We're TCP-only (WS) right now and the game feels OK on LAN/low-latency connections. How much real-world difference does geckos.io (WebRTC) or WebTransport make for a 20 Hz tick game? At what player-count or latency threshold does TCP head-of-line blocking become the dominant feel problem vs just tweaking interpolation delay? Is it worth fixing the late-joiner bug first, then switching transport, or does the transport switch come first?

QUESTION 3 — TICK RATE:
We're at 20 Hz server tick. UT99 ran at 35 Hz. Quake 3 at 40 Hz. What's the minimum tick rate to achieve UT99 feel in a browser game, and what are the bottlenecks that prevent us from just cranking it to 60 Hz (nengi loop cost, ws send frequency, bandwidth)?

QUESTION 4 — ROADMAP PRIORITIZATION:
Given the north star (UT99 in the browser, no perceivable lag), rank these remaining work items:
a) Fix late-joiner invisibility bug
b) Switch transport to geckos.io / WebTransport (UDP)
c) Raise tick rate (20→40 Hz)
d) Add real arena geometry (level design)
e) Fix animations (UAL1 run/shoot/death)
f) Add player names to protocol
g) Per-weapon hit registration tuning
h) SFX pass

Be specific, be brutal. If our stack has a fundamental architectural mistake for UT99-feel, call it out now.
`

const body = {
  systemInstruction: { parts: [{ text: PERSONA }] },
  contents: [{ role: 'user', parts: [{ text: BRIEF }] }],
  generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.error('Gemini HTTP', res.status, await res.text())
  process.exit(1)
}
const json = await res.json()
const text =
  json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ??
  JSON.stringify(json, null, 2)
console.log(text)
