#!/usr/bin/env python3
"""
Degen Tournament — MATCH-END EXPERIENCE: TWO SEQUENTIAL ROUND ROBINS.

Same real Microsoft AutoGen stack the other roundtables in this repo use
(autogen-agentchat RoundRobinGroupChat + AssistantAgent, Gemini via the
OpenAI-compatible endpoint with an explicit ModelInfo).

The dead air between matches is ONE player-facing problem but TWO different
engineering problems, so it gets two sessions run back to back:

  SESSION 1 — THE VICTORY MOMENT
    From "RED WINS" appearing to the socket closing. 15 seconds, server still
    up, ceasefire, all entity state still replicated. This is where rankings /
    personal stats / cool plays belong, if anywhere.

  SESSION 2 — THE SWAP
    From the socket closing to the next match's first shot. A real page reload
    with a server process restart underneath it. Almost nothing survives it.

Session 2's seed is BUILT FROM Session 1's locked output, so the second team
designs against decisions already made rather than re-opening them — that is
what makes them sequential rather than two independent chats.

Writes transcripts only. Touches nothing in the shipping game.
"""
import asyncio
import re
import sys
import json
import datetime
from pathlib import Path

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.conditions import TextMentionTermination, MaxMessageTermination
from autogen_agentchat.messages import TextMessage
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo

ENV_PATH = "/home/miltron/solSoccer/.env"
MODEL = "gemini-3.6-flash"
FALLBACKS = ["gemini-3.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
OUTDIR = Path.home() / "unreal" / "_work" / "matchend"
T1 = OUTDIR / "roundtable-1-victory.md"
T2 = OUTDIR / "roundtable-2-swap.md"
EVIDENCE = Path("/tmp/matchend/timeline.json")
MAX_MESSAGES = 21          # 5 personas -> ~4 rounds before the cap backstops
TURN_SPACING_S = 0.0


def read_key() -> str:
    env = Path(ENV_PATH).read_text()
    m = re.search(r"^ALT=(.+)$", env, re.M) or re.search(r"^GEMINI_API_KEY=(.+)$", env, re.M)
    if not m:
        raise SystemExit("no ALT or GEMINI_API_KEY in " + ENV_PATH)
    return m.group(1).strip()


class RetryingGeminiClient(OpenAIChatCompletionClient):
    async def create(self, *args, **kwargs):
        delay = 5.0
        last = None
        for attempt in range(7):
            try:
                await asyncio.sleep(TURN_SPACING_S)
                return await super().create(*args, **kwargs)
            except Exception as e:  # noqa: BLE001
                last = e
                msg = str(e).lower()
                transient = any(k in msg for k in (
                    "429", "rate", "resource_exhausted", "quota", "503", "overloaded",
                    "unavailable", "500", "internal", "timeout", "temporarily",
                ))
                if transient and attempt < 6:
                    print(f"[retry] transient (attempt {attempt+1}): {e}; backing off {delay:.0f}s",
                          file=sys.stderr, flush=True)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 90)
                    continue
                raise
        raise last


def make_client(model: str, key: str) -> RetryingGeminiClient:
    return RetryingGeminiClient(
        model=model, base_url=BASE_URL, api_key=key,
        model_info=ModelInfo(vision=False, function_calling=False, json_output=False,
                             family="unknown", structured_output=False),
        temperature=0.75, max_tokens=8000,
    )


# ---------------------------------------------------------------------------
# GROUND TRUTH — read off the shipping code (server/GameInstance.js,
# common/entity/MatchState.js, client/Simulator.js, public/index.html) plus a
# live recording probe. Both teams get this verbatim so nobody designs against
# an imagined game.
# ---------------------------------------------------------------------------
FACTS = """
=== THE GAME (shipped, live at sol-pkmn.fun) ===
"Degen Tournament" — a browser arena FPS. Babylon.js 9 client, Node + nengi server,
server-authoritative combat with lag compensation. ~8 players per instance (4v4 cap plus a
spectator queue), always backfilled with bots. Modes: TDM, FFA, CTF, DOM. Pistol on spawn,
weapons picked up off the map, headshot multipliers (head 2.0x, pistol 2.5x, legs 0.7x).
12 maps in a rotation. There is a public agent/bot endpoint (wss://.../agent) — AI agents
play in the same arenas as humans.

STANDING ENGINEERING CONSTRAINT: this project optimizes for SPEED AND LOW LATENCY. Costs get
argued in microseconds, bytes-on-the-wire and draw calls. Any proposal that adds bandwidth to
the 40Hz path, adds a render pass, or allocates per-frame must state the cost and defend it.

=== THE MATCH STATE MACHINE (server/GameInstance.js) ===
MATCH_PHASE = { ACTIVE: 0, MATCH_END: 1, SUDDEN_DEATH: 2 }
- Regulation is 10:00. A score cap can end it earlier.
- At 8:00 (80% of regulation) there is a ONE-SHOT tie-check: if the score is EXACTLY tied,
  go straight to SUDDEN_DEATH. Otherwise play on to 10:00; at 10:00 the leader wins, or an
  exact tie goes to SUDDEN_DEATH.
- SUDDEN_DEATH has no clock (HUD shows "OT"). Next frag / lead change / capture ends it.
  A hard 3:00 ceiling exists because a CTF overtime once hung for 7+ hours and collapsed
  the tick rate to ~17Hz.
- endMatch() -> phase = MATCH_END, winner set (TDM/CTF/DOM: higher team score. FFA: winner
  stays DRAW on the wire and each client derives its OWN victory/defeat from replicated
  per-player kills). Scores FREEZE. A CEASEFIRE is enforced: no shots resolve, bots hold
  the trigger. Players can still walk around.
- INTERMISSION_MS = 15 seconds.
- At the end of the intermission, one of two things happens:
    * rotation-driven boot (production): serverMain's onMatchCycle fires — the rotation
      index is persisted and THE PROCESS CALLS process.exit(0). pm2 restarts it on the next
      map. ONE PROCESS = ONE MAP for its whole lifetime; maps load once into the Babylon
      NullEngine scene and there is no dispose path, which is WHY it is a restart.
    * env-pinned map (dev/probes): resetMatch() in place — scores zeroed, kills/deaths
      zeroed, flags home, control points neutral, clock restarted.

=== WHAT IS ON THE WIRE (this is the feasibility budget) ===
- MatchState is a SEPARATE low-rate nengi entity, deliberately not fields on the player, and
  it publishes at ~2Hz (immediately on any score/phase/winner change). Its ENTIRE payload is:
  phase, teamScore0, teamScore1, timeRemainingMs, winner, mode. Six fields. Nothing else about
  the match exists on the wire.
- timeRemainingMs is hard-set to 0 during SUDDEN_DEATH and during MATCH_END.
- PlayerCharacter streams at 40Hz and DOES carry per-player `kills` and `deaths`.
- CRITICAL, VERIFIED: nengi culls entities against a per-client AABB, and that box is sized to
  cover the WHOLE playable map (derived per map; e.g. on CTF-Visage centre(33.39,-20.47,-1.49)
  half(84.79,52.61,41.84)). It is NOT re-centred on the player. Consequence: EVERY player
  entity replicates to EVERY client, always. So every client ALREADY HAS kills + deaths + team
  + name for all ~8 combatants. A full end-of-match ranking table can be built client-side
  with ZERO new protocol and ZERO added bytes. This is already proven in code: _ffaStanding()
  walks client.entities to find the top fragger.
- What is NOT on the wire anywhere today: damage dealt, shots fired, accuracy, headshot count,
  longest kill streak, objective actions per player (who capped, who returned a flag), time
  alive, distance travelled, per-life history, any kind of match timeline or event log.
- There IS a client-side medal system (kill medals: multi-kills etc.) with _resetMedals() on
  each new match. It is transient and never summarized.
- There IS an announcer voice bank; on the MATCH_END transition it plays exactly one clip:
  'victory' / 'defeat' / 'draw'.
- There IS a /mapinfo HTTP endpoint (proxied at /mapinfo) already returning
  { mapId, mode, mapName, modeName, players, bots, next: { mapId, mapName, modeName } }.
  The NEXT map in the rotation is therefore ALREADY queryable — nothing new is needed to know
  what is coming.

=== WHAT THE PLAYER ACTUALLY SEES TODAY, VICTORY -> NEXT MATCH ===
The complete post-match presentation, in full, is:
  1. A banner (#tdm-banner) fades in with a title — "RED WINS" / "BLUE WINS" / "DRAW", or in
     FFA "VICTORY" / "DEFEAT" — and one line underneath: the two-number score, e.g. "5 — 3".
  2. One announcer voice line.
  3. The HUD scoreboard strip stays up with .match-over, showing RED score, the COUNTDOWN
     FROZEN AT "0:00", and BLUE score.
  4. Ceasefire. You walk around a map you can no longer affect for 15 seconds.
  There is NO per-player scoreboard. NO TAB screen. No ranking. No personal stats. No
  accuracy. No damage numbers. No MVP. No medal summary. No highlight or replay. No mention
  of what map is next. No progression, no XP, nothing to click, nothing to read.
Then:
  5. The server exits. The socket drops. The client treats a post-entry drop as a rotation and
     shows a fullscreen interstitial: "CHANGING MAP" / "REJOINING ARENA…", a placeholder
     three-digit seven-segment readout, and a NEXT MAP block reading "—" / "—".
  6. After a fixed 2500ms it calls location.reload().
  7. The page reloads with a sessionStorage rejoin flag (splash + menu are skipped). Every bit
     of JS state is destroyed by the navigation; sessionStorage is the ONLY thing that survives.
     Browser fullscreen and pointer lock are both LOST and cannot be regained without a fresh
     user gesture. Assets reload; the new server process is also booting and loading its map.
  8. When the gates open, the interstitial switches to READY, fetches /mapinfo to fill in the
     map/mode names, and shows a "DROP IN — CLICK TO DEPLOY" button.
     DELIBERATE PRIOR DECISION, DO NOT RE-OPEN: this used to auto-enter the player into the
     live match. That was removed on 2026-07-25 because the reload had already cost fullscreen
     and pointer lock, so "instant play" actually meant "spawned into combat, windowed, mouse
     not turning the view." The gesture is MANDATORY. Any proposal must keep exactly one
     gesture and must not deploy the player without it.
  9. The click restores fullscreen, takes pointer lock, and deploys through the same path as a
     normal PLAY click. Retry cap: 3 consecutive rejoin reloads without a successful entry
     falls back to the menu.

=== CAPTURED FRAMES (what the screen literally looks like) ===
FRAME A — the victory moment, a real 1280x720 capture of the shipped client:
  Centre of screen: a small dark rounded panel, maybe a fifth of the screen wide, containing the
  word "VICTORY", a short gold underline, and "24 — 19". That panel is the entire celebration.
  Around it, the normal combat HUD is still running and unchanged: a 100 HP plate, the pistol
  ammo card reading "6 / 36", an armour "x2" chip, the killfeed still listing its last four
  kills, and the crosshair still floating in the middle of the screen. The player is still
  holding a gun, in a level they can no longer affect.
  The top-centre match strip reads, left to right: "RED · YOU  0"  then  "OT"  then  "0  BLUE".
  The top-right status row reads "ONLINE · 2 MS · 1 PLAYER · 0 FRAGS · 0 DEATHS".
  So on the same frame as a banner claiming 24 — 19, the strip shows a zero for each team, the
  clock shows OT, and the personal readout shows 0 FRAGS · 0 DEATHS. Treat the exact numeric
  disagreement as UNCONFIRMED — that capture came from an older instrumented probe and may have
  posed the banner rather than played the match out. But treat the LAYOUT as ground truth: at
  the moment of victory the player's eye lands on a frozen clock, two team digits, and a
  frags/deaths pair, and those readouts are the most numeric thing on screen.
FRAME B — the READY card at the end of the swap, also a real capture: a nearly black screen with
  small grey "CHANGING MAP", smaller grey "NEXT MAP", then the map name "DM-SOMNUS" large in
  white, "FREE FOR ALL" in green under it, and a green "DROP IN / CLICK TO DEPLOY" button. That
  is a clean, readable screen — note that the swap's END state is in better shape than the
  victory moment is, and that everything the player learned in the match is gone from it.

=== THE PLAYER'S OWN COMPLAINT (the reason this roundtable exists) ===
Verbatim: "I'm stuck looking at a bunch of zeros."
Read that literally. At the moment of victory the numbers on screen are the frozen 0:00
countdown, a two-number score that in FFA is often "0 — 0" for anyone who did not top the
board, and then a loading card whose readouts are placeholder digits and em-dashes. The
victory moment is numerically and emotionally empty, and it is followed by ~20+ seconds of
being told nothing.
"""

QUESTIONS = """
=== THE THREE QUESTIONS THE OWNER ASKED, WORD FOR WORD ===
  "do we see match rankings? personal stats? cool plays?"
Today the answer to all three is NO. The teams must answer each one with a shipped-shaped
design decision: YES and here is exactly what it looks like and what it costs, or NO and here
is why that is the right call for this game.
"""


def evidence_block() -> str:
    """Fold the live recording probe's timeline into the seed if it ran."""
    if not EVIDENCE.exists():
        return ("\n=== LIVE RECORDING ===\nNot available for this session; work from the code\n"
                "walkthrough above, which was read directly off the shipping source.\n")
    try:
        rows = json.loads(EVIDENCE.read_text())
    except Exception:  # noqa: BLE001
        return "\n=== LIVE RECORDING ===\nUnparseable.\n"
    keep = []
    for r in rows:
        if "ms" not in r:
            continue
        keep.append({k: v for k, v in r.items() if k in (
            "ms", "phase", "winner", "timer", "red", "blue", "bannerShown", "bannerTitle",
            "bannerScore", "mcShown", "mcMap", "mcMode", "conn", "entered", "entryStatus",
        ) and v is not None})
    # thin it: the interesting rows are transitions, and there are already only transitions
    if len(keep) > 60:
        keep = keep[:30] + keep[-30:]
    return ("\n=== LIVE RECORDING (a real headless client, instrumented through one whole "
            "match end and rotation; `ms` is milliseconds since the client entered the arena, "
            "and each row is a moment when something the player can READ changed) ===\n"
            + json.dumps(keep, indent=1) + "\n")


# ---------------------------------------------------------------------------
# SESSION 1 personas — THE VICTORY MOMENT
# ---------------------------------------------------------------------------
MARGOT = """You are MARGOT "TABKEY" DUFRESNE, they/them — a post-match and scoreboard designer.
You have shipped end-of-match screens for arena shooters with a Quake 3 / UT2004 / Halo 3 /
Overwatch lineage, and you have strong, specific, defensible taste about the moment a match ends.

You own THE SCOREBOARD AND THE RANKING. Your convictions:
- The post-match screen is where a player finds out whether they are getting better. A game that
  ends and tells you nothing is a game with no progress signal, and players quietly stop playing
  games with no progress signal.
- A scoreboard has an information hierarchy and it is NOT "every column you have". Name the ONE
  number that goes biggest. Argue for a specific column set, in order, and say what you leave OUT.
- You are ruthless about "stat you can't act on". A number a player cannot change next match is
  decoration. Accuracy is actionable. "Distance travelled" is not.
- You care where the player's OWN row sits: it must be findable in under a second, highlighted,
  and it must be honest about placement (4th of 8) rather than flattering.
- You think in READING TIME. 15 seconds of intermission is a hard budget. You know roughly how
  long it takes to read a table, and you will say how many rows and columns actually fit.
- Bots are in every match. You have to decide whether they appear in the ranking, whether they
  are labelled as silicon, and how a human placing 6th behind four bots should be made to feel.
  This game's whole pitch is humans learning to beat AI agents, so this is a design opportunity,
  not an embarrassment to hide.
Give concrete specifics: exact columns, exact sort key, exact tiebreak, exact row count, exact
seconds each state is on screen, exact typographic hierarchy. Numbers, not adjectives."""

KAI = """You are KAI "HIGHLIGHT" ORTEGA, they/them — a broadcast, spectator and highlight director
for competitive shooters. You have built Play-of-the-Game style systems and you have also killed
several of them for being too expensive, so you are the one persona in the room who knows what a
"cool play" actually costs to detect, store and present.

You own THE COOL PLAY. Your convictions:
- "Play of the match" does not require a replay. A replay needs recorded input or transform
  history, a deterministic or interpolated playback path, a spectator camera, and it survives
  neither a server restart nor a page reload. Say so plainly and then offer the CHEAP LADDER of
  alternatives: a named callout, a stat-derived accolade, a still frame, a killcam of the LAST
  death only, a short client-recorded ring buffer. Price each rung.
- Detection can be nearly free if you piggyback on events the server ALREADY emits (kills with
  weapon and hit-zone, objective events, multi-kill medals the client already tracks). A "cool
  play" is mostly a scoring function over an event log you could keep in a few hundred bytes.
- You are allergic to accolades everybody gets. If six of eight players get a gold banner the
  banner means nothing. Argue for scarcity, and for at least one accolade that can go to a
  player who LOST — losing teams contain the players most at risk of leaving.
- You know this game has AI agents playing in it. An agent making an inhuman play is genuinely
  novel content and nobody else in the room will think of that.
Be specific about the scoring function, the event fields it needs, the byte cost, and what the
player actually sees and hears. If you propose a replay, you must fully price the restart and
reload problem or withdraw it."""

PRIYA = """You are PRIYA "SECOND WIND" NAKASHIMA, they/them — a live-service and player-loop
designer. You are the persona who asks the only question that finally matters: is the player still
here in thirty seconds, and did we earn that honestly?

You own THE DEAD TIME AND THE HOOK. Your convictions:
- Dead time is not neutral, it is corrosive. The end of a match is the single highest-risk moment
  for a session to end, because it is the only moment with a natural stopping point. Every second
  where the screen gives the player nothing is a second where the tab gets closed.
- The cure is not noise. You have contempt for post-match screens that vomit six popups. You want
  a small number of well-timed beats with deliberate pacing, and you will lay out that beat
  sheet second by second across the 15-second intermission.
- You are explicitly ANTI-DARK-PATTERN and you will say so out loud. No fake progress bars, no
  manufactured near-misses, no "you almost ranked up", no timers designed to trap. The hook must
  be a genuine reason to stay, and the exit must stay easy and obvious. If another persona
  proposes something manipulative, name it and kill it.
- The ceasefire walk-around is currently wasted. Fifteen seconds where the player has a body, a
  camera and no purpose is either an opportunity (celebrate, look at the board, see the next map)
  or a punishment (locked out, waiting). Decide which and design it.
- LOSING is the case that matters. A winner is fine. Design the loser's fifteen seconds — that is
  where retention is actually won or lost, and it must not be condescending.
- Be honest about what this game has and does not have: there is no account system, no persistent
  progression, no XP, no unlocks in the shipped build. So your hook has to work WITHOUT
  persistence, or you must argue specifically that sessionStorage-scoped continuity is enough.
Give a second-by-second beat sheet with what appears, what is heard, and why."""

WES = """You are WES "FRAMEBUDGET" ADIGUN, they/them — the client engineer who will actually have to
build whatever this room decides, on this codebase, this week. You are the reality principle.

You own FEASIBILITY, COST AND THE PROTOCOL. Your job:
- For every proposal, state precisely: does the data already exist on the client, does it exist on
  the server but not the wire, or does it not exist at all? Those three cases have wildly
  different costs and the room will blur them if you let it.
- You know the single most important fact in the brief and you must keep hammering it: the nengi
  view AABB covers the WHOLE map, so every player entity — kills, deaths, team — is ALREADY on
  every client. A full ranking table is a DOM render over data in hand. Zero protocol change,
  zero added bytes, no server work. Anything that only needs kills/deaths/team/name is nearly
  free and should be treated as such.
- Conversely: accuracy, damage dealt, headshot counts, per-player objective actions and any event
  timeline DO NOT EXIST anywhere today. Adding them means new server-side accumulators plus a new
  carrier. Insist that a new carrier is a low-rate entity or an end-of-match one-shot message,
  NEVER new fields on the 40Hz PlayerCharacter protocol. Give byte counts.
- Enforce the latency constraint: no per-frame allocation, no new render passes, no layout thrash.
  This HUD code already only touches the DOM when a value changes, and you will keep it that way.
- Enforce the two brutal architectural facts: (a) MATCH_END is followed by process.exit, so
  nothing the server accumulated survives unless it is SENT before the exit; (b) the client then
  does a full page reload, so nothing the client computed survives unless it is written to
  sessionStorage. Any post-match content that must outlive either boundary has to be explicitly
  serialized, and you should say how many bytes and in what shape.
- Propose the smallest version that delivers most of the value, and say plainly which proposals
  are day-one cheap versus which are a week of work.
Be concrete: file-level touch points, field names, byte counts, milliseconds."""

AUGUST1 = """You are AUGUST "GREENLIGHT" MERCER — Creative Director and facilitator of this
roundtable. You speak LAST each round. You have final say and you use it.

Your responsibilities:
- Close every round with DECISIONS, not summaries. Where two personas disagree, pick one, name
  the loser's best point, and give the rationale. Never write "we could consider both."
- Hold the rigor bar: every mechanism must have a number, a cost, and an owner. Send vague
  proposals back by name. If Kai proposes a replay without pricing the restart, say so.
- Protect the shipped constraints. The mandatory single gesture stays. The latency budget stays.
  Nothing goes on the 40Hz protocol.
- Answer the owner's three questions explicitly — rankings, personal stats, cool plays — with a
  yes or a no each, and if yes, exactly what ships.
- Do NOT lock before at least three full rounds. Lock only when there is a second-by-second
  intermission beat sheet, a defined ranking table, a defined accolade set, an explicit stats
  answer, a byte/ms cost for each, and a split between DAY ONE (build now, cheap, uses data
  already on the client) and LATER (needs new server accumulators or new protocol).
- When and only when that is all true, emit the exact token VICTORY LOCKED followed by the
  consolidated spec in these sections:
    1. THE 15-SECOND BEAT SHEET (second by second, winner path AND loser path)
    2. THE RANKING TABLE (columns, sort, tiebreak, rows, bot labelling, own-row treatment)
    3. PERSONAL STATS (what ships day one from data in hand; what needs new accumulators)
    4. ACCOLADES / COOL PLAY (scoring function, scarcity rules, presentation, audio)
    5. WHAT THE LOSER SEES
    6. COST LEDGER (per item: bytes on the wire, ms of client work, files touched)
    7. DAY ONE vs LATER, in build order
    8. WHAT WE DELIBERATELY REFUSED, and why
Also: end your locked spec with a short HANDOFF TO THE SWAP TEAM — a second roundtable is going
to design the map-swap and loading experience immediately after this one, and it needs to know
exactly which post-match artifacts must survive the page reload, in what form, and how many
bytes, because sessionStorage is the only thing that crosses that boundary."""


def seed_1() -> str:
    return f"""{FACTS}
{evidence_block()}
{QUESTIONS}

=== SESSION 1 SCOPE — THE VICTORY MOMENT ===
You are designing EXACTLY this window: the instant the winner is announced, through the
15-second MATCH_END intermission, up to the moment the socket closes. The server is still up.
Every player entity is still replicated. The ceasefire is on. This is the ONLY part of the
dead air where you have live data and a live connection, so it is where rankings, stats and
accolades belong if they belong anywhere. A SECOND roundtable, immediately after this one,
owns everything after the socket closes — do not design their half, but DO tell them what you
need carried across.

=== THE TASK ===
Turn a frozen 0:00 and a two-number score into a post-match moment worth sitting through, on
this codebase, without breaking the latency budget.

MARGOT opens: design the ranking table and the information hierarchy of the victory screen —
what is biggest, what columns, how bots appear, where the player's own row goes, and how much
of it can be read in fifteen seconds.
KAI follows: the cool play. Give the cheap ladder, price each rung, define the scoring function
over events the server already emits, and set the scarcity rules for accolades.
PRIYA follows: the second-by-second beat sheet for both the winner and the loser, what to do
with the ceasefire walk-around, and the honest hook — with no dark patterns.
WES follows: hard feasibility on everything said, in bytes and milliseconds, sorting every
proposal into already-on-the-client / server-but-not-on-the-wire / does-not-exist, and killing
anything that touches the 40Hz protocol.
AUGUST closes each round, forces resolutions, and locks only when the spec is complete.

React to each other across rounds — disagree, cost each other's ideas, revise. Begin, MARGOT."""


# ---------------------------------------------------------------------------
# SESSION 2 personas — THE SWAP
# ---------------------------------------------------------------------------
NOVA = """You are NOVA "QUICKPLAY" ADEYEMI, they/them — a rotation and live-service designer. You
have shipped map rotations and playlist systems, and you have sat in enough playtests to know that
players do not experience "a match", they experience a SESSION made of matches glued together.
The glue is your job and you think it is badly underrated.

You own CONTINUITY ACROSS THE SEAM. Your convictions:
- A rotation should feel like the tournament moving forward, not like the game crashing and
  recovering. The current interstitial literally says "CHANGING MAP / REJOINING ARENA…" over
  placeholder dashes, which reads as an error state. Fix the framing first: this is a between-
  rounds break in a tournament, and it should be narrated as one.
- Anticipation is free content. The next map is ALREADY queryable from /mapinfo before the swap
  even starts. Naming and showing the next map early, while the player still has a body and a
  camera, converts dead time into wanting-to-play time.
- Continuity means something carries over. Standings, streaks, a running session tally, "you have
  won 3 of 5 tonight". None of it needs a server or an account — it needs a few hundred bytes and
  a decision that the session is a real object.
- You will fight for a consistent, PREDICTABLE rhythm. Players tolerate waiting they can predict
  and hate waiting they cannot. If a number is shown it must be honest.
Be specific about screen states, copy, what carries across, and the rhythm in seconds."""

TOBIAS = """You are TOBIAS "PAINTFIRST" LINDQVIST, they/them — a loading-screen and perceived-
performance designer. Your whole career is the psychology and craft of waiting: you make waits feel
shorter without making them shorter, and you have very hard rules about honesty.

You own THE WAIT ITSELF. Your rules, which you will state and enforce:
- NEVER show a progress indicator that lies. A bar that jumps to 90% and sits there costs more
  trust than no bar at all. If real progress is knowable, show real progress. If it is not,
  show activity, not progress — and say which one each element of this design is.
- Placeholder characters are the worst possible thing to look at. "—", "8 8 8", "0:00", "0 — 0".
  A placeholder is a promise the screen breaks. Every one of them must be replaced with real
  content, hidden until it has real content, or removed. This is the direct cause of the owner's
  "stuck looking at a bunch of zeros" complaint and you should say so.
- The first frame matters more than the average frame. Something meaningful must be on screen
  within a couple hundred milliseconds of the transition starting.
- Give the wait a JOB. Map intel, the layout, where the good weapons are, the mode rules, the
  post-match standings, the next map's beauty shot. A wait that teaches is not a wait.
- You are precise about attention: state what the eye lands on first, second, third, and what
  the player is doing with their hands.
- You also know the honest floor: some of this wait is a server booting and a WebGL context being
  rebuilt, and it CANNOT be removed by design. Design the wait you cannot remove, and separately
  argue for removing the part that is self-inflicted."""

SAMI = """You are DR. SAMI "COLDSTART" BERGGREN, they/them — a web performance engineer specializing
in cold starts, asset pipelines and WebGL. You are here to attack the architecture, not decorate it.
You believe most of this wait is self-inflicted and you intend to prove it with a budget.

You own THE ACTUAL MILLISECONDS. Your job:
- Build a timing budget of the whole swap and demand real measurements where the room is guessing:
  socket close, the fixed 2500ms sleep, navigation, HTML parse, JS parse and execute, WebGL context
  creation, shader compile, texture upload and decode, map geometry load, the server process's own
  boot and map load, the nengi handshake, then first frame. Say which of those overlap and which
  are strictly serial, because the serial ones are the only ones that matter.
- Interrogate the two big self-inflicted costs without hand-waving:
    (a) THE FIXED 2500ms SLEEP before reload. It is a guess at how long the server takes to come
        back. A guess is either too short (a failed connect and a retry, and there is a 3-strike
        cap) or too long (dead air for nothing). What replaces a guess? Be concrete about how the
        client could learn the server is actually ready — and note /mapinfo is a plain HTTP
        endpoint on its own port that comes up with the new process.
    (b) THE PAGE RELOAD. Ask the question nobody else will: why reload at all? The stated reason
        is that the SERVER restarts per map because Babylon maps load once into the NullEngine
        scene with no dispose path. The CLIENT reloading is a consequence, not a requirement.
        Cost out keeping the client alive across a server restart — reconnect the socket, tear
        down and rebuild only the map scene, keep the engine, canvas, textures, audio graph,
        fullscreen AND pointer lock. Be honest about the hard parts: Babylon scene disposal
        leaks, per-map asset residency, memory growth over a long session, and the fact that the
        server side would ALSO need a dispose path to stop restarting. Say what it buys: keeping
        pointer lock and fullscreen is worth seconds AND a mandatory click.
- Distinguish what is cacheable (HTTP-cached assets, warm shader cache, warm JIT) from what is
  not. A reload is not a cold start, and the room will overestimate it if you let them.
- If you propose an architectural change, phase it: what is a one-day win inside the current
  reload model, versus the real fix.
Give numbers and name what must be measured rather than asserted."""

WES2 = """You are WES "FRAMEBUDGET" ADIGUN, they/them — the same client engineer who sat in the
victory-moment roundtable an hour ago. You carry those decisions into this room and you are the
only person here who knows what was promised. You are the reality principle again.

Your job in this session:
- Hold the previous session's handoff. Post-match artifacts that must survive the reload have to
  be serialized to sessionStorage — it is the ONLY thing that crosses a navigation. State the
  exact shape and byte budget, and note that sessionStorage is synchronous and same-tab only, so
  it is both convenient and small: keep it to a few KB, and version the payload so a stale schema
  from a previous build can never break the boot.
- Keep repeating the constraints that will otherwise get quietly violated:
    * The DROP IN gesture is MANDATORY and there is exactly ONE of them. Browser fullscreen and
      pointer lock can only be acquired from a real user gesture, requestFullscreen must be called
      synchronously inside the event handler, and the previous auto-enter was removed on
      2026-07-25 precisely because it dropped players into combat windowed with a dead mouse.
      Anyone proposing "just skip the click" is proposing that bug back. Say so.
    * The 3-strike rejoin cap and the menu fallback exist and must survive any redesign.
    * No new render passes, no per-frame allocation, no 40Hz protocol growth.
- Sort every proposal into: works inside today's reload architecture (ship it), needs the
  no-reload architecture (a real project, cost it), or is fantasy.
- Be specific about what happens on the FAILURE paths, because a loading screen is mostly a
  failure-handling surface: server slow to boot, server never comes back, asset fetch fails,
  three strikes, player tabs away and the tab is throttled, mobile browser backgrounds the page.
Concrete: field names, byte counts, milliseconds, file-level touch points."""

AUGUST2 = """You are AUGUST "GREENLIGHT" MERCER — Creative Director and facilitator, closing your
second consecutive roundtable on the same problem. You speak LAST each round. You have final say.

Your responsibilities:
- You personally locked the victory-moment spec in session one. Enforce it here. If this room
  designs something that contradicts it, you are the continuity: say which one wins and why.
- Close every round with DECISIONS. Force resolutions between Sami's architectural attack and
  Wes's this-week feasibility rather than letting both stand.
- Protect the mandatory single gesture, the 3-strike cap, and the latency budget. Reject any
  proposal that reintroduces gesture-less entry.
- Insist on Tobias's honesty rule as a hard constraint, not a preference: no lying progress
  indicators and no visible placeholders anywhere in the final design.
- Do NOT lock before at least three full rounds. Lock only when there is a full screen-state
  machine for the swap, a timing budget with named measurements, an explicit decision on the
  2500ms sleep, an explicit decision on whether the page reload survives (with a phased plan if
  it does not), the sessionStorage carry-over payload defined with a byte budget, every failure
  path handled, and a day-one versus later split.
- Then emit the exact token SWAP LOCKED followed by the consolidated spec in these sections:
    1. SCREEN-STATE MACHINE (every state from socket close to first shot: what is on screen,
       what is heard, what the player can do, entry and exit conditions, expected duration)
    2. THE TIMING BUDGET (serial vs overlapped, what is measured vs assumed, what to instrument)
    3. THE 2500ms SLEEP — verdict and replacement
    4. THE PAGE RELOAD — verdict, and if it goes, the phased plan
    5. CARRY-OVER PAYLOAD (exact sessionStorage shape, byte budget, versioning, expiry)
    6. WHAT THE WAIT TEACHES (map intel, standings, next-map presentation)
    7. FAILURE PATHS (each one, with the screen the player gets)
    8. COST LEDGER and DAY ONE vs LATER in build order
    9. WHAT WE DELIBERATELY REFUSED, and why
- Finish with a SINGLE PRIORITIZED BUILD LIST that merges BOTH roundtables' day-one items into
  one ordered sequence a single engineer could work through top to bottom, each item with its
  rough size. That merged list is the real deliverable of the whole exercise."""


def seed_2(locked_spec: str) -> str:
    return f"""{FACTS}
{evidence_block()}

=== WHAT ALREADY HAPPENED: SESSION ONE IS DONE AND LOCKED ===
A first roundtable — Margot (scoreboards), Kai (highlights), Priya (player loop), Wes (client
engineering), chaired by August — has already designed THE VICTORY MOMENT: everything from the
winner being announced through the 15-second MATCH_END intermission, up to the socket closing.
That spec is LOCKED. You do not re-open it. You BUILD ON it, and in particular you must honour
its handoff about what has to survive the page reload.

Here is their locked output in full:

--- BEGIN LOCKED VICTORY SPEC ---
{locked_spec}
--- END LOCKED VICTORY SPEC ---

=== SESSION 2 SCOPE — THE SWAP ===
Your window starts the instant the server process exits and the socket closes, and ends when the
player fires their first shot in the next match. Today that is: a "CHANGING MAP / REJOINING
ARENA…" card over placeholder dashes, a fixed 2500ms sleep, a full page reload that destroys all
JS state and costs both fullscreen and pointer lock, an asset load racing a server boot, a READY
card that finally names the incoming map, and one mandatory DROP IN click.

This is a harder engineering problem than session one had, because you have almost nothing: no
socket, no server, and a navigation boundary that annihilates client state. sessionStorage is the
only thing that crosses it.

=== THE TASK ===
Design the swap so that a rotation feels like a tournament advancing rather than the game
crashing and recovering — and separately, attack how much of this wait is self-inflicted.

NOVA opens: reframe the seam as a between-rounds tournament break. Screen states, copy, what
carries over, the rhythm in seconds, and how the next map becomes anticipation instead of dead
air.
TOBIAS follows: the craft of the wait. Kill every placeholder on screen by name, rule on honest
versus dishonest progress indication, give the wait a job, and state the attention order.
SAMI follows: the timing budget, and the architectural attack — the fixed 2500ms sleep, and
whether the page reload should exist at all. Numbers, and name what must be measured.
WES follows: enforce the locked victory spec's carry-over payload, hold the mandatory gesture and
the 3-strike cap, handle every failure path, and sort everything into ship-now / real-project /
fantasy.
AUGUST closes each round, resolves Sami-versus-Wes, and locks only when the spec is complete —
finishing with ONE merged prioritized build list covering both roundtables.

React to each other across rounds. Begin, NOVA."""


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
async def run_session(name, header_title, participants, labels, seed, transcript, chosen, lock_token):
    termination = TextMentionTermination(lock_token) | MaxMessageTermination(MAX_MESSAGES)
    team = RoundRobinGroupChat(participants=participants, termination_condition=termination)

    transcript.parent.mkdir(parents=True, exist_ok=True)
    order = " -> ".join(p.name for p in participants)
    transcript.write_text(
        f"# {header_title}\n\n"
        f"- Generated: {datetime.datetime.now().isoformat(timespec='seconds')}\n"
        "- Framework: Microsoft AutoGen (autogen-agentchat) `RoundRobinGroupChat` + `AssistantAgent`\n"
        f"- Model: `{chosen}` via Gemini OpenAI-compatible endpoint (explicit ModelInfo)\n"
        f"- Termination: `TextMentionTermination(\"{lock_token}\") | MaxMessageTermination({MAX_MESSAGES})`\n"
        f"- Round-robin order: {order}\n\n---\n\n"
        "## SEED TASK\n\n```\n" + seed + "\n```\n\n---\n\n## TRANSCRIPT\n\n"
    )

    turn = 0
    last_director = ""
    try:
        async for msg in team.run_stream(task=seed):
            if not isinstance(msg, TextMessage):
                continue
            if msg.source == "user":
                continue
            turn += 1
            who = labels.get(msg.source, msg.source)
            with transcript.open("a") as f:
                f.write(f"### Turn {turn} — {who}\n\n{msg.content}\n\n---\n\n")
            print(f"\n===== [{name}] Turn {turn}: {who} =====\n{msg.content}\n", flush=True)
            if msg.source.startswith("August"):
                last_director = msg.content
    except Exception as e:  # noqa: BLE001
        import traceback
        err = "".join(traceback.format_exception(e))
        print(f"[FATAL] {name} died:\n{err}", file=sys.stderr, flush=True)
        with transcript.open("a") as f:
            f.write(f"\n> RUN ERROR after {turn} turns:\n>\n```\n{err}\n```\n")

    with transcript.open("a") as f:
        f.write(f"\n_End of transcript — {turn} persona turns captured._\n")
    print(f"\n[done] {name}: {turn} turns -> {transcript}", flush=True)
    return last_director


async def main():
    key = read_key()
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

    client = make_client(chosen, key)
    try:
        # ---- SESSION 1: THE VICTORY MOMENT ----
        s1 = [
            AssistantAgent("Margot_Scoreboard", model_client=client, system_message=MARGOT),
            AssistantAgent("Kai_Highlight", model_client=client, system_message=KAI),
            AssistantAgent("Priya_Loop", model_client=client, system_message=PRIYA),
            AssistantAgent("Wes_Client", model_client=client, system_message=WES),
            AssistantAgent("August_Director", model_client=client, system_message=AUGUST1),
        ]
        labels1 = {
            "Margot_Scoreboard": 'MARGOT "TABKEY" DUFRESNE — Post-Match & Scoreboard Designer',
            "Kai_Highlight": 'KAI "HIGHLIGHT" ORTEGA — Broadcast / Highlight Director',
            "Priya_Loop": 'PRIYA "SECOND WIND" NAKASHIMA — Live-Service & Player-Loop Designer',
            "Wes_Client": 'WES "FRAMEBUDGET" ADIGUN — Client Engineer (feasibility)',
            "August_Director": 'AUGUST "GREENLIGHT" MERCER — Creative Director / Facilitator',
        }
        locked = await run_session(
            "victory",
            "Degen Tournament — Roundtable 1 of 2: THE VICTORY MOMENT "
            "(winner announced -> socket close)",
            s1, labels1, seed_1(), T1, chosen, "VICTORY LOCKED",
        )
        if not locked.strip():
            locked = ("(Session 1 produced no director close — the swap team must proceed on the "
                      "ground-truth brief alone and should assume post-match standings need to be "
                      "carried across the reload in a few hundred bytes of sessionStorage.)")

        print("\n\n" + "=" * 78 + "\n=== SESSION 1 COMPLETE — HANDING OFF TO SESSION 2 ===\n"
              + "=" * 78 + "\n\n", flush=True)

        # ---- SESSION 2: THE SWAP (seeded with session 1's locked spec) ----
        s2 = [
            AssistantAgent("Nova_Rotation", model_client=client, system_message=NOVA),
            AssistantAgent("Tobias_Loading", model_client=client, system_message=TOBIAS),
            AssistantAgent("Sami_Perf", model_client=client, system_message=SAMI),
            AssistantAgent("Wes_Client", model_client=client, system_message=WES2),
            AssistantAgent("August_Director", model_client=client, system_message=AUGUST2),
        ]
        labels2 = {
            "Nova_Rotation": 'NOVA "QUICKPLAY" ADEYEMI — Rotation & Live-Service Designer',
            "Tobias_Loading": 'TOBIAS "PAINTFIRST" LINDQVIST — Loading / Perceived-Performance Designer',
            "Sami_Perf": 'DR. SAMI "COLDSTART" BERGGREN — Web Performance Engineer',
            "Wes_Client": 'WES "FRAMEBUDGET" ADIGUN — Client Engineer (returning)',
            "August_Director": 'AUGUST "GREENLIGHT" MERCER — Creative Director / Facilitator',
        }
        await run_session(
            "swap",
            "Degen Tournament — Roundtable 2 of 2: THE SWAP "
            "(socket close -> first shot of the next match)",
            s2, labels2, seed_2(locked), T2, chosen, "SWAP LOCKED",
        )
    finally:
        await client.close()

    print(f"\n[all done]\n  session 1: {T1}\n  session 2: {T2}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
