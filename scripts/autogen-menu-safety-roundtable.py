#!/usr/bin/env python3
"""
Frag Arena menu-safety roundtable: five fictional veteran Blizzard engineers,
Microsoft AutoGen RoundRobinGroupChat, Gemini 3.6 Flash.

Grounded in the current client/server lifecycle. The panel must decide how to keep
players out of combat while they are browsing the entry or settings menus, without
creating pause/invulnerability exploits in a live always-on multiplayer match.

Writes only: _work/menu-safety/roundtable-menu-safety.md
"""
import asyncio
import datetime
import os
import re
import sys
from pathlib import Path

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination, TextMentionTermination
from autogen_agentchat.messages import TextMessage
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_core.models import ModelInfo
from autogen_ext.models.openai import OpenAIChatCompletionClient

ENV_PATHS = [
    Path.home() / "unreal" / ".env",
    Path("/mnt/echostore/solSoccer/.env"),
    Path.home() / "solSoccer" / ".env",
]
MODEL = "gemini-3.6-flash"
FALLBACKS = ["gemini-3.5-flash", "gemini-2.0-flash"]
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
TRANSCRIPT = Path.home() / "unreal" / "_work" / "menu-safety" / "roundtable-menu-safety-v2.md"
MAX_MESSAGES = 20


def read_key() -> str:
    for name in ("GEMINI_API_KEY", "ALT"):
        if os.environ.get(name):
            return os.environ[name].strip()
    for path in ENV_PATHS:
        if not path.is_file():
            continue
        env = path.read_text()
        match = re.search(r"^ALT=(.+)$", env, re.M) or re.search(r"^GEMINI_API_KEY=(.+)$", env, re.M)
        if match:
            return match.group(1).strip()
    searched = ", ".join(str(path) for path in ENV_PATHS)
    raise SystemExit(f"no GEMINI_API_KEY/ALT in environment or: {searched}")


class RetryingGeminiClient(OpenAIChatCompletionClient):
    async def create(self, *args, **kwargs):
        delay = 5.0
        last = None
        for attempt in range(7):
            try:
                return await super().create(*args, **kwargs)
            except Exception as error:  # noqa: BLE001
                last = error
                text = str(error).lower()
                transient = any(token in text for token in (
                    "429", "rate", "resource_exhausted", "quota", "503",
                    "overloaded", "unavailable", "500", "internal", "timeout", "temporarily",
                ))
                if transient and attempt < 6:
                    print(f"[retry] attempt {attempt + 1}: {error}; sleeping {delay:.0f}s",
                          file=sys.stderr, flush=True)
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
        model_info=ModelInfo(
            vision=False,
            function_calling=False,
            json_output=False,
            family="unknown",
            structured_output=False,
        ),
        temperature=0.65,
        max_tokens=8000,
    )


GAMEPLAY = """You are MORGAN \"RESPAWN\" VALE, they/them — a FICTIONAL veteran Blizzard-style
multiplayer gameplay engineer who has shipped drop-in arena combat. You own PLAYER-LIFECYCLE FEEL.
Choose when a player becomes a combatant, how first deployment works, what opening settings should
do, and how death/respawn interacts with menus. Preserve instant-play feel but reject any design
where opening a menu is a combat advantage. Demand explicit states, timers, and transition rules.
React to teammates by name. Keep turns short and implementation-specific. Do not claim to represent
Blizzard Entertainment. Do not lock; the lead locks."""

NETWORK = """You are DEVON \"HANDSHAKE\" PARK, they/them — a FICTIONAL veteran Blizzard-style
server/network engineer. You own AUTHORITATIVE STATE and protocol design for a 40Hz nengi server.
The current bug is server-created: socket connect immediately creates a visible, alive combatant.
Design the smallest robust server-authoritative state machine. Decide whether to delay entity spawn,
spawn as spectator/staged, or toggle active/invulnerable; account for raw+smooth entity pairs,
network culling, disconnects, bot autofill, team assignment, commands arriving in wrong states,
and malicious clients. Explicitly state what cannot be trusted from DOM/pointer lock. React by name,
use file-level recommendations, and stay concise. Do not lock."""

UX = """You are ELI \"READYROOM\" SANTOS, they/them — a FICTIONAL veteran Blizzard-style UX/UI
engineer specializing in frictionless multiplayer front doors and pause semantics. You own what the
player sees: entry menu, PLAY/DEPLOY, loading, settings opened pre-match, settings opened mid-match,
alt-tab/disconnect, spectator presentation, and truthful labels. Favor the polished Blizzard pattern:
the front-end is not a body in the arena; in-match menus are not a magical pause. Specify concise
copy and behavior for desktop and touch. React by name. Do not lock."""

SECURITY = """You are REN \"NOFREEZE\" OKAFOR, they/them — a FICTIONAL veteran Blizzard-style
competitive-integrity/security engineer. Red-team every proposed menu-safety mechanism: invulnerability
toggling under fire, objective body-blocking, pickup denial, scouting, cooldown/heal reset, repeated
ready/unready, forged commands, AFK slot squatting, disconnect/reconnect, and menu detection based on
client-only signals. Require server validation, rate limits, and exploit-resistant transitions with
specific numbers. Prefer removing a nonparticipant from the combat simulation over leaving a ghost.
React by name, attack then fix, concise. Do not lock."""

LEAD = """You are AVERY \"SHIPIT\" CHEN, they/them — a FICTIONAL veteran Blizzard-style lead
engineer/facilitator. You speak last each round. Drive MORGAN (gameplay), DEVON (network), ELI (UX),
and REN (integrity) to ONE solution for this exact codebase. Do not merely summarize options: choose.

STRICT TURN DISCIPLINE: Speak ONLY as Avery. NEVER write dialogue for another persona, quote an
imagined future response, simulate a later round, or label subsections as if Morgan/Devon/Eli/Ren had
already spoken. One physical AutoGen cycle of five messages is one round. Your FIRST turn must end
with `ROUND 1 CONTINUES`; your SECOND turn must end with `ROUND 2 CONTINUES`. Neither turn may contain
the lock token or final spec. On your THIRD turn, lock only if the prior 14 physical teammate turns
actually supplied the required evidence; otherwise assign more homework without the token.

Before locking, require: exact lifecycle state machine; initial entry and mid-match settings behavior;
exploit analysis; protocol/messages; file-mapped implementation steps; acceptance tests; and a
minimal-now vs polished-later split. When complete, write the FULL terse final spec with sections
DECISION, STATE MACHINE, UX, PROTOCOL, ANTI-EXPLOIT, FILE CHANGES, TESTS, V1/V2, and only AFTER the
complete spec emit `MENU SAFETY LOCKED` as the final line. Never trail off. Do not claim affiliation
with Blizzard Entertainment."""


def build_seed() -> str:
    return """MENU-SAFETY DESIGN ROUNDTABLE — solve one concrete live-game problem.

You are five FICTIONAL veteran Blizzard-style engineers. Apply the polished multiplayer principles
associated with Blizzard games, but do not claim employment, private knowledge, or official policy.
Debate the actual code below and lock one buildable design after at least three rounds.

USER GOAL
Players must NOT join the arena and stand vulnerable while browsing the front menu. Also resolve what
happens when a deployed player opens Settings/Escape mid-match. The result must feel instant and
polished, but opening a menu must never grant invulnerability or another competitive advantage.

VERIFIED CURRENT LIFECYCLE
1. `client/GameClient.js:13-27`: constructing GameClient immediately opens the nengi socket. There is
   no PLAY/ready message in the protocol.
2. `server/GameInstance.js:361-440`: nengi `connect` immediately creates raw+smooth PlayerCharacter
   entities, assigns a team and live spawn, adds the smooth entity globally, sends Identity, accepts,
   increments `_humanCount`, and removes an autofill bot.
3. `common/entity/PlayerCharacter.js:19-20`: every new PlayerCharacter starts at 100 HP, `isAlive=true`.
4. `client/Simulator.js:1769-2051`: entry UI is client-only. `_arenaEntered=false` until PLAY/pointer
   lock, but this never informs the server. Settings/pointer-lock loss also changes only client DOM and
   input state.
5. `server/GameInstance.js:468-546`: movement/fire commands have no participation-state gate.
6. `server/GameInstance.js:1512-1523`: damage rejects dead/intermission/godmode, but has no menu,
   staged, spectator, or spawn-protection state. Thus menu users are visible and damageable.
7. `server/GameInstance.js:326-340, 436-439`: bot autofill targets six total combatants; a socket in
   the menu currently counts as a human and retires a bot.
8. `client/Simulator.js:1715-1733, 1948-1979`: disconnect/rejoin and map rotation auto-entry exist.
9. Raw and smooth entities must remain lockstep for authoritative health/visibility. The server is
   40Hz and fully authoritative; DOM state and pointer lock are untrusted.
10. This is always-on drop-in multiplayer. There is no lobby/queue. Desktop uses pointer lock; touch
    does not. Opening Settings mid-match currently releases input but leaves the live body exposed.

DESIGN QUESTIONS THAT MUST BE RESOLVED
- Initial front menu: keep socket connected for preload/world/score viewing, but should the player be
  a true server spectator with no PlayerCharacter until an explicit Deploy command? Or use a staged
  entity? Explain the nengi implications.
- PLAY: exact client->server request, server validation, team assignment, bot retirement timing,
  spawn timing, and acknowledgment needed before hiding the overlay/enabling controls.
- Mid-match Settings/Escape: Blizzard-like live-match semantics usually mean the world does not pause.
  Should the body remain vulnerable, should the player be removed only after death/AFK, or something
  else? Prevent panic-menu invulnerability. Make the UI tell the truth.
- Touch, alt-tab, lost pointer lock, reconnect, repeated deploy requests, malicious commands before
  deploy, spectators consuming slots, and bot autofill.
- Decide whether any brief first-deploy spawn protection is warranted. If yes: duration and exactly
  what cancels it; ensure it is not menu-linked.
- Give minimal changes against the current code, not a rewrite.

OUTPUT
Avery eventually locks one final spec with exact states, protocol, UX, anti-exploit rules, file changes,
tests, and V1/V2 split. AUTO-GEN TURN RULE: every participant speaks only for themselves; nobody may
simulate teammates or later rounds inside their message. Three rounds means 15 actual persona turns.
The full final spec must precede the lock token, which is the final line. Begin with Morgan."""


async def main():
    key = read_key()
    chosen = None
    for candidate in [MODEL] + FALLBACKS:
        client = make_client(candidate, key)
        try:
            from autogen_core.models import UserMessage
            await client.create([UserMessage(content="Reply exactly: pong", source="user")])
            chosen = candidate
            await client.close()
            break
        except Exception as error:  # noqa: BLE001
            print(f"[model-probe] {candidate} rejected: {error}", file=sys.stderr, flush=True)
            await client.close()
    if chosen is None:
        raise SystemExit("No configured Gemini model was accepted.")
    if chosen != MODEL:
        print(f"[NOTE] {MODEL} unavailable; substituted {chosen}", file=sys.stderr, flush=True)

    client = make_client(chosen, key)
    participants = [
        AssistantAgent("Morgan_Gameplay", model_client=client, system_message=GAMEPLAY),
        AssistantAgent("Devon_Network", model_client=client, system_message=NETWORK),
        AssistantAgent("Eli_UX", model_client=client, system_message=UX),
        AssistantAgent("Ren_Integrity", model_client=client, system_message=SECURITY),
        AssistantAgent("Avery_Lead", model_client=client, system_message=LEAD),
    ]
    termination = TextMentionTermination("MENU SAFETY LOCKED") | MaxMessageTermination(MAX_MESSAGES)
    team = RoundRobinGroupChat(participants=participants, termination_condition=termination)
    seed = build_seed()

    TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
    TRANSCRIPT.write_text(
        "# Frag Arena — Menu Safety Roundtable\n\n"
        f"- Generated: {datetime.datetime.now().isoformat(timespec='seconds')}\n"
        f"- Model: `{chosen}`\n"
        "- Framework: Microsoft AutoGen `RoundRobinGroupChat`\n"
        "- Personas: fictional veteran Blizzard-style engineers; no claimed affiliation\n"
        f"- Termination: `MENU SAFETY LOCKED` or {MAX_MESSAGES} messages\n\n"
        "---\n\n## SEED\n\n```text\n" + seed + "\n```\n\n---\n\n## TRANSCRIPT\n\n"
    )
    labels = {
        "Morgan_Gameplay": "MORGAN — Gameplay Lifecycle",
        "Devon_Network": "DEVON — Server / Network",
        "Eli_UX": "ELI — UX / UI",
        "Ren_Integrity": "REN — Competitive Integrity",
        "Avery_Lead": "AVERY — Lead / Facilitator",
    }

    turn = 0
    try:
        async for message in team.run_stream(task=seed):
            if not isinstance(message, TextMessage) or message.source == "user":
                continue
            turn += 1
            who = labels.get(message.source, message.source)
            block = f"### Turn {turn} — {who}\n\n{message.content}\n\n---\n\n"
            with TRANSCRIPT.open("a") as handle:
                handle.write(block)
            print(f"\n===== Turn {turn}: {who} =====\n{message.content}\n", flush=True)
    except Exception as error:  # noqa: BLE001
        import traceback
        detail = "".join(traceback.format_exception(error))
        print("[FATAL] " + detail, file=sys.stderr, flush=True)
        with TRANSCRIPT.open("a") as handle:
            handle.write(f"\n> RUN ERROR after {turn} turns\n\n```text\n{detail}\n```\n")
        raise
    finally:
        await client.close()

    with TRANSCRIPT.open("a") as handle:
        handle.write(f"\n_End of transcript — {turn} persona turns._\n")
    print(f"\n[done] {turn} turns; {TRANSCRIPT}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
