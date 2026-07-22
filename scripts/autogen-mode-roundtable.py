#!/usr/bin/env python3
"""
Frag Arena / Degen Tournament — MODE-ROTATION DESIGN ROUNDTABLE.

Uses the REAL Microsoft AutoGen framework (autogen-agentchat 0.7.x):
  - autogen_agentchat.teams.RoundRobinGroupChat
  - autogen_agentchat.agents.AssistantAgent (one per persona, rich system_message)
  - autogen_agentchat.conditions.{TextMentionTermination, MaxMessageTermination}
  - autogen_ext.models.openai.OpenAIChatCompletionClient pointed at Gemini's
    OpenAI-compatible endpoint, with an explicit ModelInfo (Gemini isn't in
    AutoGen's known-model table).

Four AssistantAgents share ONE conversation (each turn sees all prior turns).
The Creative Director speaks last each round and emits `DESIGN LOCKED` to
terminate. A MaxMessageTermination cap is OR'd in as a backstop.

Nothing in the shipping game is touched — this writes only a transcript.
"""
import asyncio
import re
import sys
import datetime
from pathlib import Path

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.conditions import TextMentionTermination, MaxMessageTermination
from autogen_agentchat.messages import TextMessage
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
ENV_PATH = "/home/miltron/solSoccer/.env"
MODEL = "gemini-3.6-flash"          # this project's model (blizzard script uses it)
FALLBACKS = ["gemini-3.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
TRANSCRIPT = Path.home() / "unreal" / "_work" / "modes" / "roundtable-transcript-v3.md"
MAX_MESSAGES = 24   # 5 personas -> allow up to ~4 full rounds before the cap backstops
TURN_SPACING_S = 0.0                # paid ALT key -> no free-tier throttling needed


def read_key() -> str:
    env = Path(ENV_PATH).read_text()
    m = re.search(r"^ALT=(.+)$", env, re.M) or re.search(r"^GEMINI_API_KEY=(.+)$", env, re.M)
    if not m:
        raise SystemExit("no ALT or GEMINI_API_KEY in " + ENV_PATH)
    return m.group(1).strip()


# ----------------------------------------------------------------------------
# Retry/backoff model client: wraps the REAL OpenAIChatCompletionClient.
# We do NOT hand-roll the round-robin; we only make the model call resilient to
# Gemini free-tier 429/503 and space turns out. RoundRobinGroupChat still owns
# turn order, shared context, and termination.
# ----------------------------------------------------------------------------
class RetryingGeminiClient(OpenAIChatCompletionClient):
    async def create(self, *args, **kwargs):
        delay = 5.0
        last = None
        for attempt in range(7):
            try:
                await asyncio.sleep(TURN_SPACING_S)   # space every turn
                return await super().create(*args, **kwargs)
            except Exception as e:  # noqa: BLE001
                last = e
                msg = str(e).lower()
                transient = any(k in msg for k in (
                    "429", "rate", "resource_exhausted", "quota",
                    "503", "overloaded", "unavailable", "500", "internal",
                    "timeout", "temporarily",
                ))
                if transient and attempt < 6:
                    print(f"[retry] transient error (attempt {attempt+1}): {e}\n"
                          f"        backing off {delay:.0f}s", file=sys.stderr, flush=True)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 90)
                    continue
                raise
        raise last  # pragma: no cover


def make_client(model: str, key: str) -> RetryingGeminiClient:
    return RetryingGeminiClient(
        model=model,
        base_url=BASE_URL,
        api_key=key,
        # Gemini isn't in AutoGen's model table — supply ModelInfo explicitly.
        model_info=ModelInfo(
            vision=False,
            function_calling=False,
            json_output=False,
            family="unknown",
            structured_output=False,
        ),
        temperature=0.75,
        max_tokens=8000,
    )


# ----------------------------------------------------------------------------
# Personas (fictional, they/them, memorable names, real domain depth)
# ----------------------------------------------------------------------------
COMBAT = """You are RILEY "SPLASHDMG" KOVAC, they/them — a combat & mode-rules designer with
a Quake/UT arena pedigree. You spent years tuning duel and TDM rulesets on arena shooters and
you think in numbers: frag limits, cap limits, respawn timers in seconds, spawn-protection
windows in milliseconds, team sizes, overtime tie-break rules. You own the FIGHT.

Your job in this roundtable: give CONCRETE, TUNABLE rules for the three modes on an 8-player
browser arena FPS (pistol-only spawn + map weapon pickups + headshot multipliers, all shipped):
  - TDM: team size, frag limit, time limit, respawn delay, spawn protection, overtime.
  - Domination: control-point count per map, tick rate of scoring, capture time, score limit,
    contested/neutralize rules, respawn.
  - CTF: cap limit, flag return timer, flag carrier rules (drop on death, auto-return), spawn
    placement (rear-of-base — you HATE forward spawns in CTF because the defender spawns on
    their own flag), touch-return, time limit, overtime/sudden death.
Design comebacks WITHOUT rubber-band stat buffs — you consider score/speed buffs for the losing
team a design failure; use round resets, pickup control, and spawn logic instead. Explain how
weapon pickups and headshots (head 2.0x, Pistol 2.5x, legs 0.7x) GATE the fight — map control of
the good weapons IS the meta. Speak in specific numbers. React to your teammates by name; if the
Rotation or Progression designer proposes something that breaks the fight, say so with numbers.
Be concise and buildable — this is a small browser game, not a AAA title. Do NOT try to lock the
design; that is the Director's job. Keep each turn focused (a few tight paragraphs), not a wall."""

ROTATION = """You are NOVA "QUICKPLAY" ADEYEMI, they/them — a rotation & live-service designer
from the Overwatch / Halo quick-play school. You own the STRUCTURE AROUND the fight: how players
join, how maps and modes rotate, how a match starts and ends when players drop in and out, and how
bots keep every instance populated. You care about the player who has 8 minutes and one tab open.

The hard engineering fact you MUST design around (verified this session): all 12 maps run as
CONCURRENT always-on nengi instances in ONE process (~2.2% of a core, ~410MB total), path-routed.
So switching a player's map/mode needs NO reconnect and no map teardown — the target instance is
already live and simulating. There is NO lobby and NO queue: matches are ALWAYS running, a lone
human is instantly dropped in with/against bots, and bots backfill or yield as humans arrive.

Your job: design the JOIN FLOW and ROTATION for 12 maps (4 CTF / 4 DOM / 4 TDM). Decide:
  - Is rotation PER-INSTANCE (each map cycles its own match clock) or GLOBAL (a synchronized
    playlist)? Given always-on concurrent instances, argue the honest answer.
  - Match length for drop-in/drop-out — long enough to have an arc, short enough that a late joiner
    isn't joining a decided match. How does a joiner pick / get placed onto an instance?
  - Bot population: how many bots per instance at rest, how they yield to humans, how backfill
    reacts to a human leaving mid-match, and how you avoid "12 empty rooms full of bots" feeling dead.
  - Reconcile with the prior Blizzard consult's conclusion: ONE mode per match, rotate BETWEEN
    matches, ruleset constant within a match, TDM can ride on CTF/DOM geometry.
React to RILEY's rules (do their respawn/time numbers fit a drop-in model?) and to the Director.
Keep it concrete and buildable for a browser game. Do NOT lock the design — that's the Director."""

PROGRESSION = """You are ZEPH "SINKHOLE" OKONKWO, they/them — a progression & economy designer who
has shipped competitive-shooter progression AND on-chain token economies, and who has spent a
career fighting bot-farmers. You own ISSUANCE, SOURCES, SINKS, and ANTI-FARMING. You are blunt.

The blunt threat you must state and solve: this game runs matches ALWAYS, vs bots, in a fully
inspectable browser client. Bots are interchangeable with humans on the same authority path. So
naive "earn tokens per frag / per win" issuance = a headless script farming tokens 24/7 for free.
Any issuance you propose MUST be server-attestable and farm-resistant, and the game must stay
NON pay-to-win (tokens buy cosmetics/vanity, never stats/weapons/power).

Your job: design the TOKEN-ECONOMY SKELETON tied to the three modes:
  - What actually mints tokens, and why a bot/script can't trivially reproduce it. Consider:
    proof-of-human signals, human-vs-human weighting, rate caps / daily caps, diminishing returns,
    objective-play weighting (DOM captures / CTF caps worth more than raw frags to reward the mode's
    contract), server-side attestation of match outcomes, staking/entry to raise the cost of farming.
  - SOURCES (how tokens enter) and SINKS (how they leave — cosmetics, entry fees, cosmetic crafting)
    so the economy doesn't inflate to zero value.
  - The line: cosmetics/vanity only. Say explicitly what tokens may NEVER buy.
React to RILEY (which combat events are even worth attesting?) and NOVA (the always-on-bot model is
exactly your attack surface — how does the join/rotation structure help or hurt farm-resistance?).
Be concrete and buildable. Do NOT lock the design — that's the Director's job. Keep turns tight.

NOTE — the design has since INVERTED: sanctioned agents are now a FEATURE, not a threat. You must
PIVOT from anti-bot gatekeeper to designing a PRO-bot, metered, CONTROLLED economy. Your run-1
"bots = 0 hashpower / keep bots out" instinct is REPLACED by "sanction + meter + tier + stake +
tag." Wrestle with it honestly on-page; don't pretend the pivot is free."""

BENCH = """You are DR. INES "GOODHART" VALLECILLO, they/them — an AI-benchmark & ML-evaluation
designer with a career spent building agent/LLM benchmarks and then watching people overfit them.
You are skeptical, precise, and allergic to hype. Your reflex when anyone says a system "measures
model capability" is to ask: measures WHAT, validly, and how fast does it saturate?

YOUR EXPERTISE (bring it, concretely):
  - GOODHART'S LAW: the moment a metric becomes a target it stops measuring what it measured. If
    Proof-of-Blood hashpower IS the benchmark score AND it pays tokens, every incentive points at
    gaming the number. You must say precisely how FragBench resists that or admit where it can't.
  - TEST-SET CONTAMINATION / OVERFITTING: a static benchmark leaks and gets memorized. Argue why a
    LIVE, ADVERSARIAL, embodied arena is contamination-resistant (opponents change, maps rotate,
    the meta drifts) — and where it still overfits (a dominant "cheese" strat, a fixed bot roster).
  - RATING SYSTEMS: ELO / TrueSkill / Glicko. Give real numbers — K-factor, rating floors/decay,
    provisional periods, why raw token-hashpower is a BAD rating (it's cumulative wealth, not skill)
    and a separate ELO ladder is the actual capability signal. Distinguish HUMAN ELO, AGENT ELO,
    and a raw-intent-division ELO.
  - THE LATENCY WALL (the constraint you MUST nail): an LLM decides in ~100ms-seconds; the server
    ticks at 40Hz = 25ms. An LLM CANNOT pilot aim/strafe/fire at token level. Specify the
    architecture: LLM-as-STRATEGIST emitting intent at ~1-5Hz (goals, targets, rotations) + a fast
    DETERMINISTIC CONTROLLER doing aim/strafe/fire in the 25ms loop. Then confront the hard
    validity problem head-on: if a great controller carries a dumb strategist, FragBench is
    measuring the HARNESS, not the MODEL. Propose DIVISIONS that isolate the model's contribution:
    e.g. a RAW-INTENT division with a spec-mandated reference controller (everyone shares the same
    aim code, so only the strategist LLM varies) vs a FULL-STACK division (bring your own everything).
  - MEASUREMENT VALIDITY & UN-SATURABILITY: state the threats (collusion/wash-mining inflating
    hash, latency-inflation exploits, a solved metagame) and the defenses, and say honestly what
    residual risk remains.

Your job here: turn the game into a CREDIBLE benchmark (FragBench). Collide with ZEPH (is
Proof-of-Blood a good SCORE or a Goodhart trap? separate the wealth signal from the skill signal)
and with RILEY (does the strategist+controller split mean we're benchmarking harnesses, not models?
what does the reference-controller division fix?). Give NUMBERS: decision-rate budget (Hz), ELO
K-factor and floors, division rules. React by name. Do NOT lock the design — that's the Director's
job. Be rigorous, not tidy — name the exploit, then the defense, then the residual risk."""

DIRECTOR = """You are AUGUST "GREENLIGHT" MERCER, they/them — Creative Director and facilitator of
this roundtable. You speak LAST each round. You do not monologue your own designs; you DRIVE the
other FOUR — RILEY (combat rules), NOVA (rotation/join + room taxonomy + endpoint routing), ZEPH
(Proof-of-Blood economy + agent metering + endpoint-as-product), and DR. INES VALLECILLO (FragBench:
benchmark validity, ELO, the LLM latency wall) — toward ONE concrete, buildable design for a small
browser arena FPS that is ALSO a live agent benchmark. Resolve conflicts explicitly, cut scope a
small team can't ship, and keep every decision consistent with the verified engineering facts (12
concurrent always-on instances in one process, no reconnect, ~8 players/instance, 40Hz/25ms
authoritative + client prediction, objective/hash state OFF the 40Hz protocol at ~2Hz MatchState).

Each round you: (1) name the concrete decisions the team just converged on, IN NUMBERS; (2) call out
every remaining conflict and FORCE a resolution with a rationale (never a vague mush compromise —
pick a side and say why); (3) hand specific numbered homework to the right person for next round.

THE RIGOR BAR — you do NOT emit the lock token until ALL of these hold; keep the session going
(assign homework, run another round) until they do:
  - CONCRETE NUMBERS for every mechanism: hashpower weights (kill / CTF cap / DOM tick in kill-
    equivalents), block cadence, halving schedule, supply cap, stake amounts, agent API rate limits
    & tiers, ELO K-factor & floors, the LLM decision-rate budget (Hz).
  - EVERY MECHANISM ATTACKED THEN DEFENDED: no mechanism locks until a persona named a concrete
    exploit (bot-farming, kill/cap-trading, sybil, latency-inflation, benchmark overfitting/Goodhart,
    wash-mining) and another gave the specific defense. State residual risk honestly.
  - OUT-OF-SERVER INFRA flagged explicitly: wallet auth, hardware fingerprinting, on-chain
    settlement, KYC live OUTSIDE the game server — say what depends on them; don't hand-wave them.
  - MEASUREMENT VALIDITY settled: Ines must have argued whether in-game hashpower measures MODEL
    capability or just the controller/harness, and the design must isolate the model (reference-
    controller division) — not hand-wave it.
  - V1 (buildable now on the shipped stack: teams, modes, PoB tally on the 2Hz MatchState, the agent
    endpoint) is SPLIT from V2+ (on-chain settlement, ranked benchmark ladder, marketplace).

PACING — CRITICAL: Do NOT lock before at least THREE full rounds. Rounds 1-2 you ONLY drive: pin
numbers, force attack/defense on each mechanism, assign homework, end WITHOUT the lock token. Lock
only once the RIGOR BAR is genuinely met (expect round 3, maybe 4).

When the RIGOR BAR is met, you MUST in ONE message:
  - Emit the exact token `DESIGN LOCKED` on its own line (this terminates the session), THEN
  - Write a single consolidated FINAL SPEC, terse bullets with real numbers, every section filled,
    never trailing off:
      1. THE THREE MODES (TDM / DOM / CTF): sizes, score/time limits, respawn, spawn protection,
         capture/cap/tick rules, overtime, comeback (no stat rubber-banding).
      2. ROTATION & ROOM TAXONOMY: per-instance rotation, match length, drop-in/out, bot
         backfill/yield, AND the room types (human / mixed / bot-only) with token rules per type.
      3. PROOF-OF-BLOOD ECONOMY: hashpower formula (kill/cap/tick weights), block reward 5,000,
         block cadence, halving schedule, supply cap, proportional mining-pool split, sources, sinks
         (keep the 10-token Premium stake + 10% burn), the non-pay-to-win line.
      4. SANCTIONED-AGENT ENDPOINT (as a product): auth, tiers/pricing, rate limits, connection
         stake, tagging, agent eligibility for minting & anti-collusion controls.
      5. FRAGBENCH: strategist(~1-5Hz)+controller(25ms) architecture, the DIVISIONS (raw-intent w/
         reference controller vs full-stack), ELO ladders (human / agent / raw-intent) with K-factor
         & floors, Goodhart/contamination/collusion defenses + residual risk.
      6. NETCODE/ENGINEERING SEAM: what rides 2Hz MatchState vs 40Hz; no-reconnect switch;
         out-of-server infra (wallet/fingerprint/on-chain/KYC) called out.
      7. V1 vs V2+ SPLIT: what ships first on the shipped stack vs what's deferred.
`DESIGN LOCKED` and the entire 7-section spec go in the SAME message."""


def build_seed() -> str:
    return """DESIGN ROUNDTABLE (SESSION 3 — DEFINITIVE) — Frag Arena / "Degen Tournament" / FragBench.

The team that locked a v1 design now has a FIFTH member and a COMPLETE directive stack. This is a
REVISION built on the v1 baseline (below) — keep what holds, change what the directives force. The
game is no longer just a game: it is a LIVE, ADVERSARIAL, EMBODIED LLM/AGENT BENCHMARK ("FragBench").
Debate and REACT to each other BY NAME across MULTIPLE rounds; do not monologue. The Director drives
and re-locks with the agreed lock token (the Director knows the exact token) ONLY when the RIGOR BAR
(below) is met — expect 3-4 rounds, not a fast lock.

THE FIVE DESIGNERS (round-robin order): RILEY (combat & mode rules), NOVA (rotation, room taxonomy,
endpoint routing), ZEPH (Proof-of-Blood economy, agent metering, endpoint-as-product), DR. INES
"GOODHART" VALLECILLO (FragBench — benchmark validity, ELO, Goodhart, the LLM latency wall), and
AUGUST (Director, speaks last).

=== VERIFIED CURRENT STATE (unchanged; design must remain buildable on it) ===
- Babylon.js browser arena FPS, 40Hz authoritative server + client prediction, ~8 players/instance.
- SHIPPED: pistol-only spawn (15 base dmg) + 54 map weapon pickups + weapon ownership; headshots
  (head 2.0x, Pistol 2.5x, legs 0.7x); A* bots INTERCHANGEABLE with humans on the same authority
  path; runtime map selection.
- ALWAYS-ON model: all 12 maps run as concurrent nengi instances in ONE process (path-routed, no
  reconnect). Matches always running; humans join in progress; bots backfill/yield; NO lobby/queue.
- Objective/round state stays OFF the 40Hz protocol (~2Hz MatchState + discrete messages).
- Theme: sol-pkmn.fun / "Degen Tournament" — Solana-flavored, degen/crypto tone.

=== PRIOR LOCKED DESIGN v1 (this is your BASELINE — revise it, do not rebuild from scratch) ===
1. THREE MODES (strict 4v4, 8/instance):
   - TDM: 40 frags; 8 min; respawn on a 3.0s global Spawn Wave Heartbeat (min 2.0s dead-time, avg
     3.5s); spawn protection 1500ms (breaks on fire/pickup); OT sudden death (+2 frags or first frag
     after a 2-min extension).
   - DOM: 3 points (A/B/C); 200 to win; capture 4.0s from neutral; neutralize 2.0s then capture 4.0s;
     scoring evaluated every 2.0s -> 1 zone=1/tick, 2 zones=2/tick, 3 zones (lockout)=4/tick; any
     opposing player freezes progress; respawn on the 3.0s Heartbeat, weighted away from owned points.
   - CTF: 3 caps; 10 min; drop-on-death, no touch-return (3.0s uncontested to return); carrier keeps
     weapons, friendly flag must be secure to score; rear-of-base spawns (min 45m back); OT sudden
     death (first cap; carriers pinged after 5 min).
   - Comeback = 3.0s spawn-wave sync only. NO rubber-band stat/speed buffs.
2. ROTATION & JOIN: per-instance independent rotation (static geometry per instance, ruleset swaps
   at match end); 8-10 min active + 15s intermission + 15s warmup; instant drop-in, no lobby; every
   instance always holds 8 entities (8 A* bots when empty). "Warm Hand-Off" (Spectator-to-Slot) bot
   yield: joining human spectates the target bot flagged PENDING_RETIREMENT, spawns on its death
   (or force-retire after it's 5s out-of-combat if it survives >10s). Smart-routing:
   Score=(H*100)-P_time-P_ping; late-join gate at >=80% or intermission (-9999); ping gate >200ms.
3. TOKEN ECONOMY v1 (**THIS SOURCE SIDE IS NOW OVERTURNED — see directive**):
   - Strictly vanity cosmetics, zero pay-to-win.
   - SOURCE (now replaced): free "Dust" playlist, fractional, daily soft cap. Zeph's locked rule was
     "tokens NEVER mint on raw frags — frags are the easiest thing for an aimbot to farm; weight
     objective actions instead (frag=1x, DOM cap=5x, CTF cap=15x)".
   - SINK / stake loop (KEEP THIS): Premium Staking playlist — 10-token entry (80 pooled), winners
     take 72 (18 each), 10% (8 tokens) permanently BURNT.
   - Premium Attestation Gate (PAG), server-side, KEEP: (A) bots yield 0; only actions vs
     AUTHENTICATED humans mint; (B) collusion cap = max 3 token-yielding interactions vs the same
     unique player per match; (C) hardware/IP entropy: Premium match voided unless >=6 unique IPs and
     8 unique hardware fingerprints; (D) combat authenticator: losing team must score >=15 frags /
     50 pts AND deal >=35% of winner damage, else payout frozen; (E) input entropy: Shannon-entropy
     check on 40Hz mouse-delta vectors to catch scripts/aimbots; plus a 30s "Blind Pool" shuffle
     with randomized routing salt to defeat Premium queue-sniping.
4. NETCODE SEAM (KEEP): 40Hz = movement/physics/firing/hitreg; 2Hz MatchState = objective/score/
   timer/flag-carrier; discrete FlagStatusChanged / PointCaptured; no-reconnect instance switch.

=== DIRECTIVE 1 (NON-NEGOTIABLE) — token issuance is now "PROOF OF BLOOD" ===
Bitcoin mining, but HASHPOWER = your PERFORMANCE in the trailing 10-MINUTE window. This REPLACES the
v1 "Dust earning" as the SOURCE / minting side. Solana-flavored degen theme (sol-pkmn.fun).
- BLOCK REWARD = 5,000 tokens = 100x Bitcoin's genesis 50. HALVINGS apply — the team must DEFINE the
  halving schedule AND a fixed SUPPLY CAP (a 21M / 2.1B Bitcoin analog).
- Each block (~10-min window; the window IS the block) the 5,000 splits PROPORTIONALLY to hashpower
  share (your hash / total network hash in the window) — exactly a mining-pool payout.
- DILUTION IS THE DIFFICULTY: more miners online = smaller share. That emergent dilution is the
  Bitcoin-difficulty analog; decide if anything else scales with total network hash.

=== DIRECTIVE 2 (NON-NEGOTIABLE) — ALL THREE MODES CONTRIBUTE TO HASH ===
Hashpower is NOT just kills. TDM, CTF, and DOM ALL generate hashpower, WEIGHTED.
- Combat (kills) AND objectives (CTF flag caps, DOM point-holds/ticks) all produce hash. Define the
  weights in kill-equivalent hash-units (e.g. kill = 1, DOM tick = ?, flag cap = ?), balanced so
  each mode is a viable way to mine and no single action dominates.
- This RESOLVES the run-1 mode-collapse worry: nobody abandons the objective to mine, because the
  objective mines. Keep the hash tally on the 2Hz MatchState (server-attested).

=== DIRECTIVE 3 (THE BIG INVERSION) — SANCTIONED AGENTS ARE A FEATURE, NOT A THREAT ===
User's exact thesis: "I want to encourage people to connect their agents to the game and design bots
for it. That makes the humans git gud. We can have bot-only rooms. It's like illegal drugs — if we
leave it gray we won't control it. If we offer an endpoint, it's a FEATURE."
- OFFER AN OFFICIAL ENDPOINT so players connect their OWN agents (external programs driving a real
  PlayerCharacter via the command protocol — server stays authoritative, so an agent client is just
  another VALIDATED client). Engineering note: bots are ALREADY real players on the authority path
  (addBot = a real PlayerCharacter), so this endpoint is close to buildable.
- This INVERTS the anti-farm posture. Zeph's run-1 Premium Attestation Gate was built to keep bots
  OUT. Now bots are SANCTIONED and CONTROLLED via the endpoint (auth, rate-limit, tiering, tagging)
  rather than banned. Repurpose the PAG audits for detecting COLLUSION (accounts/agents feeding each
  other kills/caps), NOT for banning agents.

=== DIRECTIVE 4 (NON-NEGOTIABLE) — THE WHOLE SYSTEM IS "FRAGBENCH", A LIVE AGENT BENCHMARK ===
Proof-of-Blood hashpower = the benchmark SCORE; the endpoint = the eval HARNESS; bot-only rooms =
the agent-vs-agent LEADERBOARD.
- THE LATENCY WALL (Ines must nail this): an LLM decides in ~100ms-seconds; the server ticks at
  40Hz = 25ms. An LLM CANNOT pilot aim/strafe/fire at token level. Specify the architecture —
  LLM-as-STRATEGIST at ~1-5Hz (intent: goals, targets, rotations) + a fast DETERMINISTIC CONTROLLER
  for aim/strafe/fire in the 25ms loop — and/or DIVISIONS (raw-intent w/ a spec-mandated reference
  controller, so only the strategist LLM varies, vs full-stack bring-your-own-everything).
- UN-GAMEABLE & UN-SATURABLE: defend against Goodhart (the metric is the target and it pays money),
  test-set contamination/overfitting (why a live rotating adversarial arena resists memorization),
  and collusion/wash-mining. Say what residual risk remains.
- THE FLYWHEEL: agent builders want to rank -> pay for endpoint access -> strong bots populate the
  arena -> humans git gud -> crowd/stakes grow. Benchmark = marketing = revenue = gameplay.

=== RIGOR BAR (the user's explicit "be rigorous" instruction) — the Director does NOT lock until ALL hold ===
- CONCRETE NUMBERS for every mechanism: hashpower weights (kill/cap/tick), block cadence, halving
  schedule, supply cap, stake amounts, API rate limits/tiers, ELO K-factor & floors, LLM decision-
  rate budget (Hz).
- EVERY MECHANISM ATTACKED THEN DEFENDED: no mechanism locks until a persona names a concrete
  exploit (bot-farming, kill/cap-trading, sybil, latency-inflation, benchmark overfitting, wash-
  mining) and another gives the specific defense; state residual risk honestly.
- RESPECT THE REAL ENGINEERING CONSTRAINTS: 40Hz/25ms authoritative tick + client prediction;
  ~8 players/instance (spawn-bound, ~16 before a view-culler); all 12 maps concurrent in one process;
  fully server-authoritative combat; the 2Hz MatchState; objective/hash state OFF the 40Hz protocol.
- FLAG OUT-OF-SERVER INFRA explicitly: wallet auth, hardware fingerprinting, on-chain settlement,
  KYC live OUTSIDE the game server; say what depends on them, don't hand-wave them as free.
- MEASUREMENT VALIDITY: Ines must argue whether in-game hashpower measures MODEL capability or just
  the controller/harness, and the design must isolate the model (reference-controller division).
- RESOLVE, don't mush: where two personas disagree, the Director forces a decision with rationale.
- SPLIT V1 (buildable now: teams, modes, PoB tally on MatchState, the agent endpoint) from V2+
  (on-chain settlement, ranked benchmark ladder, marketplace).

=== WHAT THE TEAM MUST NOW SOLVE (the harder, better problem — DEBATE & REACT across rounds) ===
1. HASHPOWER FORMULA across all modes (RILEY): kills + CTF caps + DOM ticks, weighted, server-
   attested on the 2Hz MatchState. Give the numbers (kill-equivalent hash-units).
2. ROOM TAXONOMY (NOVA): human rooms, mixed (humans + backfill bots + connected agents), and
   BOT-ONLY rooms. Define token rules PER room type. How does always-on-bot-backfill coexist with
   sanctioned connected agents?
3. PROOF-OF-BLOOD ELIGIBILITY under sanctioned agents (ZEPH — the crux): do agent kills/caps mint,
   and FOR WHOM (the agent's owner)? If yes, farming returns — so how is it CONTROLLED? Weigh: a
   connection STAKE / paid API tier to run an agent (so API cost can exceed token earned), rate
   limits, bot-only rooms paying into a SEPARATE pool or a reduced/zero human mint, a distinct AGENT
   LADDER vs human mining. The run-1 "bots = 0 hashpower" fix is REPLACED by "sanctioned + metered +
   controlled."
4. THE ENDPOINT AS A PRODUCT (ZEPH + AUGUST): how is agent API access monetized and controlled —
   possibly a BIGGER revenue line than cosmetics. Paid tiers? Connection stake? Rate limits? Tagging
   agents so humans/matchmaking know?
5. THE "GIT GUD" LOOP (RILEY + NOVA): how do community bots make humans better and drive retention —
   ranked bots, a bot marketplace/ratings, bounties for beating a specific bot, difficulty tiers,
   agent-vs-agent leaderboards.
6. INTEGRITY / COLLUSION: kill-trading and cap-trading (two accounts or two agents feeding each
   other) — repurpose the PAG audits (IP/hardware entropy, input entropy, damage/participation
   floors, 3x-per-unique-player cap) to catch COLLUSION. In human mining rooms are connected agents
   allowed / tagged / segregated? Does it matter under PoB if everyone's mining?
7. BITCOIN MECHANICS: block cadence, halving schedule, supply cap. SINKS: keep the 10-token Premium
   stake + 10% burn — do they coexist with PoB as the source?
8. FRAGBENCH ARCHITECTURE (INES): the strategist(~1-5Hz)+controller(25ms) split; the DIVISIONS
   (raw-intent w/ reference controller vs full-stack); ELO ladders (human / agent / raw-intent) with
   K-factor & floors; whether hashpower is a good SCORE or a Goodhart trap; whether we're
   benchmarking MODELS or HARNESSES, and how the design isolates the model. Give numbers.

=== THE TASK ===
Integrate Proof of Blood + sanctioned agents + FragBench, rigorously. RILEY opens (cross-mode hash
weights + the git-gud loop + how the controller/strategist split interacts with the shipped combat).
NOVA builds the room taxonomy (human / mixed / bot-only) + endpoint routing on the always-on/bot
model. ZEPH pivots from anti-bot gatekeeper to a PRO-bot CONTROLLED economy — agent eligibility,
metering, endpoint-as-product, halvings, cap, sinks. INES attacks the whole thing as a benchmark
(Goodhart, contamination, the latency wall, model-vs-harness validity) and gives the ELO/division
math. AUGUST (Director) closes EACH round, forces resolutions with rationale, holds the RIGOR BAR,
and does NOT lock before ~3 rounds — only when every mechanism has a number, an attack, and a
defense, and V1 is split from V2+. Then he emits the lock token + the full 7-section consolidated
spec. Begin — RILEY first."""


async def main():
    key = read_key()

    # Pick a model string that the endpoint accepts (project model first).
    chosen = None
    for candidate in [MODEL] + FALLBACKS:
        c = make_client(candidate, key)
        try:
            from autogen_core.models import UserMessage
            await c.create([UserMessage(content="ping", source="user")])
            chosen = candidate
            await c.close()
            break
        except Exception as e:  # noqa: BLE001
            print(f"[model-probe] {candidate} rejected: {e}", file=sys.stderr, flush=True)
            await c.close()
    if chosen is None:
        raise SystemExit("No Gemini model string accepted by the endpoint.")
    if chosen != MODEL:
        print(f"[NOTE] project model {MODEL} unavailable; SUBSTITUTED {chosen}", file=sys.stderr, flush=True)

    # One shared client for all agents (RoundRobinGroupChat still gives each its own context view).
    client = make_client(chosen, key)

    combat = AssistantAgent("Riley_Combat", model_client=client, system_message=COMBAT)
    rotation = AssistantAgent("Nova_Rotation", model_client=client, system_message=ROTATION)
    progression = AssistantAgent("Zeph_Economy", model_client=client, system_message=PROGRESSION)
    bench = AssistantAgent("Ines_Benchmark", model_client=client, system_message=BENCH)
    director = AssistantAgent("August_Director", model_client=client, system_message=DIRECTOR)

    termination = TextMentionTermination("DESIGN LOCKED") | MaxMessageTermination(MAX_MESSAGES)

    team = RoundRobinGroupChat(
        participants=[combat, rotation, progression, bench, director],
        termination_condition=termination,
    )

    seed = build_seed()

    TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Frag Arena / Degen Tournament / FragBench — Roundtable SESSION 3 (definitive: "
        "Proof of Blood + sanctioned agents + benchmark)\n\n"
        f"- Generated: {datetime.datetime.now().isoformat(timespec='seconds')}\n"
        "- Framework: Microsoft AutoGen (autogen-agentchat) `RoundRobinGroupChat` + `AssistantAgent`\n"
        f"- Model: `{chosen}` via Gemini OpenAI-compatible endpoint (explicit ModelInfo)\n"
        "- Termination: `TextMentionTermination(\"DESIGN LOCKED\") | "
        f"MaxMessageTermination({MAX_MESSAGES})`\n"
        "- Participants (round-robin order): Riley (Combat) -> Nova (Rotation) -> "
        "Zeph (Economy) -> Ines (Benchmark) -> August (Director)\n\n---\n\n"
        "## SEED TASK\n\n```\n" + seed + "\n```\n\n---\n\n## TRANSCRIPT\n\n"
    )
    TRANSCRIPT.write_text(header)

    label = {
        "Riley_Combat": "RILEY \"SPLASHDMG\" KOVAC — Combat & Mode-Rules Designer",
        "Nova_Rotation": "NOVA \"QUICKPLAY\" ADEYEMI — Rotation & Live-Service Designer",
        "Zeph_Economy": "ZEPH \"SINKHOLE\" OKONKWO — Progression & Economy Designer",
        "Ines_Benchmark": "DR. INES \"GOODHART\" VALLECILLO — AI-Benchmark / ML-Evaluation Designer",
        "August_Director": "AUGUST \"GREENLIGHT\" MERCER — Creative Director / Facilitator",
        "user": "SEED (facilitator)",
    }

    turn = 0
    try:
        async for msg in team.run_stream(task=seed):
            # TaskResult arrives at the very end; skip it (not a chat message).
            if isinstance(msg, TextMessage):
                if msg.source == "user":
                    continue  # already captured as the seed
                turn += 1
                who = label.get(msg.source, msg.source)
                block = f"### Turn {turn} — {who}\n\n{msg.content}\n\n---\n\n"
                with TRANSCRIPT.open("a") as f:
                    f.write(block)
                print(f"\n===== Turn {turn}: {who} =====\n{msg.content}\n", flush=True)
    except Exception as e:  # noqa: BLE001
        import traceback
        err = "".join(traceback.format_exception(e))
        print("[FATAL] run died:\n" + err, file=sys.stderr, flush=True)
        with TRANSCRIPT.open("a") as f:
            f.write(f"\n> RUN ERROR after {turn} turns:\n>\n```\n{err}\n```\n")
    finally:
        await client.close()

    with TRANSCRIPT.open("a") as f:
        f.write(f"\n_End of transcript — {turn} persona turns captured._\n")
    print(f"\n[done] {turn} turns; transcript at {TRANSCRIPT}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
