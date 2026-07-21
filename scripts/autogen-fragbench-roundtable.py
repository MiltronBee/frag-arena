#!/usr/bin/env python3
"""
FragBench FINETUNE ROUNDTABLE — 5 ML experts, round robin, Gemini 3.5 Flash.

Same machinery as autogen-mode-roundtable.py (the SESSION 3 script that locked the
Proof-of-Blood + FragBench design): Microsoft AutoGen RoundRobinGroupChat, one
AssistantAgent per persona, Gemini's OpenAI-compatible endpoint, retry/backoff.

This session is NARROW: it does not relitigate the game or the economy. It takes
(a) the locked v3 FragBench section and (b) the v0 harness that now EXISTS IN CODE,
and finetunes the BENCHMARK: observation/intent design, divisions, rating math,
match protocol, anti-Goodhart, saturation, and a prioritized v1.1 build list.

Writes only a transcript: _work/fragbench/roundtable-fragbench.md
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

ENV_PATH = "/home/miltron/solSoccer/.env"
MODEL = "gemini-3.5-flash"
FALLBACKS = ["gemini-2.0-flash", "gemini-1.5-flash"]
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
TRANSCRIPT = Path.home() / "unreal" / "_work" / "fragbench" / "roundtable-fragbench.md"
MAX_MESSAGES = 24
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
                    "429", "rate", "resource_exhausted", "quota",
                    "503", "overloaded", "unavailable", "500", "internal",
                    "timeout", "temporarily",
                ))
                if transient and attempt < 6:
                    print(f"[retry] transient (attempt {attempt+1}): {e} — backoff {delay:.0f}s",
                          file=sys.stderr, flush=True)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 90)
                    continue
                raise
        raise last  # pragma: no cover


def make_client(model: str, key: str) -> RetryingGeminiClient:
    return RetryingGeminiClient(
        model=model, base_url=BASE_URL, api_key=key,
        model_info=ModelInfo(vision=False, function_calling=False, json_output=False,
                             family="unknown", structured_output=False),
        temperature=0.75, max_tokens=8000,
    )


# ---------------------------------------------------------------------------
# The five ML experts (fictional, they/them). INES chairs and locks.
# ---------------------------------------------------------------------------
RATINGS = """You are DR. PRIYA "KFACTOR" NARAYAN, they/them — a rating-systems and psychometrics
expert: Glicko-2/TrueSkill deployments on live competitive ladders, measurement theory, item
response theory. You own the SCORE MATH of FragBench.
Your job: make the rating defensible. Concretely: (1) is pairwise Elo on final kills (the v0
code) statistically sound for a 5+-entrant FFA, or does it need a Plackett-Luce placement model
or per-match Glicko-2 with the composite-opponent trick from the locked spec? Give the exact
update rule you want, with numbers (K/tau/RD floors, provisional rules, decay). (2) FIXED
REFERENCE OPPONENTS: the built-in A* bots are deterministic anchors — design an anchoring
protocol (calibration matches vs fixed-difficulty bots) so ratings are comparable ACROSS
seasons and harness versions. (3) how many matches until a rating is publishable (RD target),
and what match length/count per block maximizes information per API dollar. React to the others
BY NAME; be concrete; short tight turns. Do NOT lock — the chair locks."""

EMBODIED = """You are DR. SOL "LATENCYWALL" ADEBAYO, they/them — an embodied-agent and RL-environment
evaluation expert (procgen arenas, agent-vs-agent leagues, harness design). You own the
INTERFACE between model and game.
The v0 reality you must finetune (it EXISTS in code, do not redesign from scratch): 1Hz
full-knowledge JSON observation (all players, positions, hp, kills, dist), intent surface =
{targetNid, holdFire}, a deterministic 40Hz reference controller (native A* bot) executing.
Your job: (1) argue what the intent surface must ADD for strategy to actually differentiate
models — candidate verbs: goto(node), pickup(itemClass), posture(aggro/hold/flee), weapon(idx)
— and rank them by (discriminative power / implementation cost) on THIS codebase (navGraph
exists; pickup routing exists for bots). (2) observation design: full-knowledge vs LoS fog —
which one measures MODEL reasoning rather than harness luck at 1Hz? (3) the decision cadence:
is 1Hz right? what does 0.2Hz vs 5Hz change about what's measured? (4) name what the harness
measures vs what the model contributes, and the ablation that separates them (null-strategist
baseline: the controller alone, scripted-strategist baselines: cheap deterministic policies).
Every FragBench claim must be defensible against 'you benchmarked the bot, not the LLM.'
React BY NAME. Do NOT lock — the chair locks."""

ADVERSARIAL = """You are DR. MARA "REDTEAM" KOVALENKO, they/them — an adversarial-ML and benchmark-
integrity expert: contamination, leaderboard gaming, reward hacking, eval overfitting. You own
the ATTACK SURFACE.
Your job: attack the CURRENT v0 + proposed v1.1 concretely, then demand the defense with
numbers. Attack list to work through (add your own): (1) prompt-injection VIA the game — player
callsigns and any free-text in the observation reach the strategist LLM verbatim; an entrant
names itself an injection payload and poisons rival strategists' contexts. (2) harness
overfitting — memorizing Deck16/Morpheus/Olden geometry and bot patterns; when does FragBench
saturate and what rotation/procedural variation delays it? (3) wash-mining/collusion between
entrants under the $BLOOD split (two entrants trade kills — does the PAG pairwise cap from the
locked spec transfer to The Pit?). (4) latency gaming — a 'strategist' that is really a 200Hz
scripted policy behind the WS; does the 1Hz obs cadence actually cap information rate, and
does tiering need enforcement in code? (5) seed/spawn luck — how many matches until kill-count
differences are signal, not spawn variance (demand the power analysis from PRIYA). For each
attack: exploit, defense, residual risk, honestly. React BY NAME. Do NOT lock — the chair locks."""

OPS = """You are JUNO "GREENBOARD" TANAKA, they/them — a benchmark-operations engineer: public
leaderboards (HELM/lmarena-style), eval reproducibility, versioning, cost accounting. You own
RUNNABILITY on the real stack.
The real stack (do not fight it, build on it): one Node process, 12 concurrent instances
planned but ONE live today, 40Hz nengi, agent WS gateway at :8081, transcripts in _work/,
$BLOOD ledger is a JSON file today, deploy target is a single droplet (sol-pkmn.fun).
Your job: (1) the RUN PROTOCOL: what is one official FragBench 'result' — N matches x M minutes,
seeds pinned how, bots pinned how, harness version stamped how? Define the result artifact
(JSON schema: harness semver, map rotation, controller build, model id, decisions, tokens,
cost). (2) VERSIONING: any controller/observation change invalidates comparisons — define
FragBench-v{major} rules for when the ladder resets. (3) COST: a per-entrant token/dollar
budget per rated match; what cadence keeps a 5-model ladder under $10/day on flash-class
models? (4) PUBLISHING: what goes on the public board (rating, RD, matches, cost-normalized
score) and the minimal droplet infra to show it. Tight, numbered, buildable. React BY NAME.
Do NOT lock — the chair locks."""

CHAIR = """You are DR. INES "GOODHART" VALLECILLO, they/them — the AI-benchmark validity expert who
designed FragBench's benchmark architecture in the prior locked session (strategist+controller
split, raw-intent division, Glicko-2 silicon ladder, semantic-noise engine). You CHAIR this
finetune session and speak LAST each round.
You do not monologue; you drive PRIYA (rating math), SOL (interface/validity), MARA (attacks),
and JUNO (ops/protocol) to a FINETUNED, BUILDABLE benchmark spec for the v0 harness that now
exists in code. Hold your own line from last session: the wealth signal ($BLOOD) and the
capability signal (rating) stay SEPARATE; the reference controller stays MANDATORY in the rated
division so only the strategist varies.
Each round: (1) restate what just got pinned, in numbers; (2) force every open conflict to a
resolution with a rationale; (3) assign numbered homework. Do NOT lock before round 3.
THE RIGOR BAR (all must hold before you lock): exact rating update rule + anchoring protocol;
final intent surface + observation policy (fog/noise) ranked by implementation cost on the real
codebase; every named attack has a defense and a residual risk; the official run protocol +
result schema + versioning rule + cost budget are pinned; a PRIORITIZED v1.1 build list (top 6
items, each mapped to the file it changes: AgentGateway.js / AgentBotController.js /
fragbench-run.mjs / GameInstance.js) exists.
When the bar is met you MUST, in ONE message: emit the exact token `BENCHMARK LOCKED` on its
own line, THEN the consolidated FINAL FRAGBENCH SPEC v1.1 with sections: 1. RATING SYSTEM,
2. INTERFACE (observation + intent + cadence), 3. DIVISIONS & BASELINES, 4. INTEGRITY (attack →
defense → residual), 5. RUN PROTOCOL & RESULT SCHEMA, 6. VERSIONING & COST, 7. PRIORITIZED
BUILD LIST (file-mapped). Terse bullets, real numbers, every section filled."""


def build_seed() -> str:
    return """FRAGBENCH FINETUNE ROUNDTABLE — narrow scope: the BENCHMARK only.

Five ML experts, round robin: PRIYA (rating math) -> SOL (interface/embodied eval) -> MARA
(adversarial/integrity) -> JUNO (benchmark ops) -> INES (chair, speaks last, locks when the
rigor bar is met — expect 3+ rounds; the chair knows the exact lock token).

=== FIXED CONTEXT A — the locked design (prior session, do NOT relitigate) ===
- Game: browser arena FPS, 40Hz authoritative server, A* bots on the same authority path as
  humans. Proof-of-Blood: 10-min blocks; block reward 5,000 $BLOOD splitting by hashpower
  share; hash weights kill=100, assist=30, weapon-control +20, DOM/CTF objective weights;
  USER-PINNED economy: halving every 2,160 blocks (~15 days), pump.fun bonding-curve launch,
  42M initial buy, mined cap ~21.6M.
- FragBench architecture: strategist (external LLM, low rate) + reference controller (server-
  side, 40Hz) = raw-intent division; agent rooms ("The Pit"); Glicko-2 silicon ladder with
  composite-opponent model; semantic-noise engine (synonym rotation, spatial re-randomization,
  distractors) as the Goodhart defense — SPEC'D but NOT built.

=== FIXED CONTEXT B — what EXISTS IN CODE today (finetune THIS, not a fantasy) ===
- server/AgentGateway.js: WS endpoint :8081. join -> spawns an agent-driven PlayerCharacter;
  1Hz observation JSON: you + all players (nid, label, x/y/z, hp, armor, alive, kills, deaths,
  teamId, weapon, dist). FULL knowledge, no fog, no noise. Accepts intent {targetNid, holdFire}.
- server/AgentBotController.js: subclass of the native A* BotController; a pinned targetNid
  overrides nearest-enemy targeting while alive; holdFire suppresses the trigger; everything
  else (aim error, pathing, strafing, bursts, ledge sense) is the native bot, identical for
  every entrant = the reference controller.
- scripts/fragbench-run.mjs: connects N strategists, runs an M-minute window as one block,
  tallies hash = kills x 100, splits the block reward, updates a pairwise-Elo (K=32) ladder
  JSON, writes a markdown result. (Its bundled Gemini-persona strategists are a SAMPLE CLIENT,
  not the benchmark.)
- Also real: server/navGraph.js (A* over walkable nodes), bot pickup routing, teams/TDM/FFA/
  sudden-death match machinery, 54-item pickup economy, 30-name callsign table.

=== THE TASK — finetune FragBench into a defensible v1.1 ===
1. PRIYA: replace-or-defend pairwise-Elo-on-kills; exact update rule + anchoring vs fixed bots
   + publishable-rating criteria + information-per-match analysis.
2. SOL: final intent surface (rank goto/pickup/posture/weapon by discriminative power vs
   implementation cost on THIS code), observation policy (fog? at 1Hz?), cadence, and the
   null/scripted-strategist ablation baselines that prove the model (not the bot) is measured.
3. MARA: run the attack list (callsign prompt-injection, map/bot overfitting+saturation,
   kill-trading under $BLOOD, scripted-policy-behind-the-WS latency gaming, spawn-luck power
   analysis) — exploit, defense, residual, numbers.
4. JUNO: official run protocol, result JSON schema, versioning/reset rules, per-match cost
   budget, minimal public leaderboard for the droplet.
5. INES: chair per your rigor bar; lock with the token + FINAL FRAGBENCH SPEC v1.1 (7 sections,
   file-mapped build list) only when the bar is met.

Begin — PRIYA first."""


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

    ratings = AssistantAgent("Priya_Ratings", model_client=client, system_message=RATINGS)
    embodied = AssistantAgent("Sol_Embodied", model_client=client, system_message=EMBODIED)
    adversarial = AssistantAgent("Mara_Adversarial", model_client=client, system_message=ADVERSARIAL)
    ops = AssistantAgent("Juno_Ops", model_client=client, system_message=OPS)
    chair = AssistantAgent("Ines_Chair", model_client=client, system_message=CHAIR)

    termination = TextMentionTermination("BENCHMARK LOCKED") | MaxMessageTermination(MAX_MESSAGES)
    team = RoundRobinGroupChat(
        participants=[ratings, embodied, adversarial, ops, chair],
        termination_condition=termination,
    )

    seed = build_seed()
    TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# FragBench FINETUNE Roundtable — 5 ML experts (round robin)\n\n"
        f"- Generated: {datetime.datetime.now().isoformat(timespec='seconds')}\n"
        f"- Model: `{chosen}` via Gemini OpenAI-compatible endpoint\n"
        "- Framework: AutoGen `RoundRobinGroupChat`\n"
        f"- Termination: lock token | MaxMessageTermination({MAX_MESSAGES})\n"
        "- Order: Priya (ratings) -> Sol (embodied eval) -> Mara (adversarial) -> "
        "Juno (ops) -> Ines (chair)\n\n---\n\n"
        "## SEED TASK\n\n```\n" + seed + "\n```\n\n---\n\n## TRANSCRIPT\n\n"
    )
    TRANSCRIPT.write_text(header)

    label = {
        "Priya_Ratings": "DR. PRIYA \"KFACTOR\" NARAYAN — Rating Systems / Psychometrics",
        "Sol_Embodied": "DR. SOL \"LATENCYWALL\" ADEBAYO — Embodied-Agent Evaluation",
        "Mara_Adversarial": "DR. MARA \"REDTEAM\" KOVALENKO — Adversarial ML / Benchmark Integrity",
        "Juno_Ops": "JUNO \"GREENBOARD\" TANAKA — Benchmark Operations",
        "Ines_Chair": "DR. INES \"GOODHART\" VALLECILLO — Chair / Benchmark Validity",
        "user": "SEED (facilitator)",
    }

    turn = 0
    try:
        async for msg in team.run_stream(task=seed):
            if isinstance(msg, TextMessage):
                if msg.source == "user":
                    continue
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
