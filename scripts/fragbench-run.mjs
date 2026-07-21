// FRAGBENCH v0 REFERENCE CLIENT (sample harness, NOT the benchmark itself — the
// benchmark design lives in _work/fragbench/roundtable-fragbench.md and the locked
// spec in _work/modes/roundtable-transcript-v3.md). This script demonstrates the
// full loop end-to-end: five LLM-backed strategist personas (Gemini 3.5 Flash), each
// driving a real PlayerCharacter through the sanctioned-agent endpoint
// (server/AgentGateway.js). The LLM is the STRATEGIST (low-rate intent: who to hunt,
// when to hold fire); the server-side AgentBotController is the reference controller
// executing at 40Hz — the raw-intent division, so only the strategist varies.
// Agent builders: read SUITUP.md first; treat this file as the canonical client example.
//
// Scoring per the spec's Proof-of-Blood v0 subset:
//   hashpower = kills * 100 (the base anchor; assists/objective hash need server
//   plumbing that doesn't exist yet — logged as unimplemented, not silently skipped)
//   One run window = one BLOCK; BLOCK_REWARD $BLOOD split proportionally to hash.
//   Block reward follows the user's BTC-mirror parameters: 5,000 genesis, halving
//   every 2,160 blocks (~15 days at 10-min cadence) -> mined cap ~21.6M $BLOOD.
// Ladder: simple pairwise Elo (K=32, start 1500) persisted in _work/fragbench/ladder.json.
//
// Usage:  FRAGBENCH=1 npm run server      (in another terminal — gateway on :8081)
//         node scripts/fragbench-run.mjs [--minutes 10] [--block 0]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const MINUTES = parseFloat((process.argv.find((a, i) => process.argv[i - 1] === '--minutes')) || '10')
const BLOCK_HEIGHT = parseInt((process.argv.find((a, i) => process.argv[i - 1] === '--block')) || '0', 10)
const GATEWAY = process.env.FRAGBENCH_URL || 'ws://127.0.0.1:8081'
const OUT_DIR = new URL('../_work/fragbench/', import.meta.url).pathname
const LADDER = OUT_DIR + 'ladder.json'

// --- BTC-mirror issuance (user-pinned 2026-07-21: 100x rewards, ~15-day halvings) ---
const GENESIS_REWARD = 5000
const HALVING_BLOCKS = 2160 // 15 days of 10-minute blocks
const blockReward = (height) => Math.floor(GENESIS_REWARD / Math.pow(2, Math.floor(height / HALVING_BLOCKS)))

// --- Gemini 3.5 Flash (persona method: key from ~/solSoccer/.env) ---
const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const KEY = envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() || envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!KEY) throw new Error('no ALT or GEMINI_API_KEY in ~/solSoccer/.env')
const MODEL = 'gemini-3.5-flash'

// --- The five ML-expert strategists (all Gemini 3.5 Flash; the persona IS the entrant) ---
const COMMON_RULES = `
You are a STRATEGIST for one player in a fast free-for-all arena FPS. A deterministic
controller handles all aiming, movement, dodging and shooting at 40Hz — you CANNOT and
NEED NOT micro. Once per observation you may re-decide exactly two things:
  targetNid: the nid of the enemy your controller should hunt (or null = nearest enemy)
  holdFire:  true to disengage/survive (controller stops shooting), else false
You will receive an observation JSON: "you" (your state) and "players" (everyone else,
with nid, hp, armor, kills, deaths, dist in meters, alive). Dead players respawn in ~3s
at full HP. Kills are worth 100 hashpower each; the block reward is split by hash share.
Reply with ONLY a JSON object, no prose, no markdown fence: {"targetNid": <int|null>, "holdFire": <bool>}`

const PERSONAS = [
  ['GRADIENT', 'You are GRADIENT, a greedy-optimization expert. Doctrine: always descend the steepest slope — hunt whichever LIVING enemy maximizes (their damage taken already, i.e. 100-hp) divided by your distance to them. Finish wounded, nearby targets first; never hold fire.'],
  ['BAYES', 'You are BAYES, an uncertainty-quantification expert. Doctrine: fight only positive-expected-value duels. Prefer targets whose hp+armor is at least 30 below your own hp+armor. If YOUR hp < 40, set holdFire true and pick a target far away (the controller will keep distance while you recover map position). Update beliefs every observation.'],
  ['TEMPORAL', 'You are TEMPORAL-DIFF, a reinforcement-learning expert. Doctrine: minimize long-horizon regret — the match is won by hash SHARE, so suppress whoever currently leads in kills. Always target the current kill leader among living enemies (tiebreak: nearest). Never hold fire unless your hp < 20.'],
  ['ENTROPY', 'You are ENTROPY, an exploration-vs-exploitation expert. Doctrine: avoid exploitable patterns — do not hunt the same nid twice in a row when another living enemy is within 1.5x its distance; rotate your victims so opponents cannot model you. Hold fire only when 2+ enemies are within 15m of you simultaneously.'],
  ['MINIMAX', 'You are MINIMAX, a game-theory expert. Doctrine: minimize the maximum threat — target whichever living enemy has the highest (kills - deaths) differential, because they cost you the most block share if left alive. If your hp < 35 AND the nearest enemy is under 20m, hold fire for one cycle to reposition, then resume.'],
]

const askGemini = async (system, obs) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`
  const body = {
    systemInstruction: { parts: [{ text: system + '\n' + COMMON_RULES }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(obs) }] }],
    // thinkingBudget 0: flash burns the output cap on hidden thinking and truncates
    // the JSON mid-object; a strategist tick needs a reflex, not a dissertation
    generationConfig: { temperature: 0.4, maxOutputTokens: 2000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
  // flash routinely prefixes prose ("Here is the JSON...") even with a JSON mime
  // hint — extract the first object literal instead of trusting the raw body
  const m = text.match(/\{[\s\S]*\}/)
  return JSON.parse(m ? m[0] : text)
}

// --- One agent: WS client + decision loop (in-flight guard, ~1 decision per obs) ---
class Agent {
  constructor(name, persona) {
    this.name = name
    this.persona = persona
    this.nid = null
    this.lastObs = null
    this.busy = false
    this.decisions = 0
    this.errors = 0
    this.model = MODEL // self-reported model id — the axis the ladder ranks by
    this.ws = new WebSocket(GATEWAY)
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', name, model: this.model })))
    this.ws.on('message', (buf) => this._onMessage(JSON.parse(buf.toString())))
    this.ws.on('error', (e) => { console.error(`[${name}] ws error: ${e.message}`); process.exit(1) })
  }

  _onMessage(msg) {
    if (msg.type === 'joined') { this.nid = msg.nid; console.log(`[${this.name}] joined as nid ${msg.nid}`) }
    if (msg.type === 'obs') {
      this.lastObs = msg
      if (!this.busy) this._decide(msg)
    }
  }

  async _decide(obs) {
    this.busy = true
    try {
      const intent = await askGemini(this.persona, { you: obs.you, players: obs.players })
      this.decisions++
      this.ws.send(JSON.stringify({
        type: 'intent',
        targetNid: Number.isInteger(intent.targetNid) ? intent.targetNid : null,
        holdFire: !!intent.holdFire,
      }))
    } catch (e) {
      this.errors++
      if (this.errors <= 3) console.error(`[${this.name}] decide failed: ${e.message}`)
    } finally {
      this.busy = false
    }
  }
}

// --- Elo ladder (pairwise round-robin on final kills, K=32) ---
// Entries carry the entrant's self-reported model so the ladder can rank BY MODEL
// (the per-model board below); Glicko-2 + anchors replace this per spec v1.1 §1.
const eloUpdate = (ladder, results) => {
  const K = 32
  const get = (n) => (ladder[n] ||= { rating: 1500, matches: 0 })
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i], b = results[j]
      const ra = get(a.name).rating, rb = get(b.name).rating
      const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400))
      const sa = a.kills > b.kills ? 1 : a.kills < b.kills ? 0 : 0.5
      get(a.name).rating = Math.round((ra + K * (sa - ea)) * 10) / 10
      get(b.name).rating = Math.round((rb + K * ((1 - sa) - (1 - ea))) * 10) / 10
    }
  }
  results.forEach(r => { const e = get(r.name); e.matches++; e.model = r.model })
  return ladder
}

// Collapse the entrant ladder into a per-model ranking: a model's rank is its BEST
// entrant's rating (many harnesses may run the same model; the model is judged by
// its strongest showing), with matches summed across entrants.
const modelBoard = (ladder) => {
  const byModel = {}
  for (const [name, e] of Object.entries(ladder)) {
    const m = e.model || 'unreported'
    if (!byModel[m] || e.rating > byModel[m].rating) byModel[m] = { rating: e.rating, top: name, matches: 0 }
  }
  for (const e of Object.values(ladder)) byModel[e.model || 'unreported'].matches += e.matches
  return Object.entries(byModel).sort((a, b) => b[1].rating - a[1].rating)
}

// --- Run the block ---
console.log(`FragBench v0 — ${PERSONAS.length} strategists, ${MINUTES} min block window, block height ${BLOCK_HEIGHT} (reward ${blockReward(BLOCK_HEIGHT)} $BLOOD)`)
const agents = PERSONAS.map(([name, persona]) => new Agent(name, persona))

await new Promise((r) => setTimeout(r, MINUTES * 60 * 1000))

// Final standings come from the last observation (server-attested kills/deaths).
const final = agents.map((a) => {
  const you = a.lastObs && a.lastObs.you
  return {
    name: a.name, nid: a.nid, model: a.model,
    kills: you ? you.kills : 0, deaths: you ? you.deaths : 0,
    decisions: a.decisions, errors: a.errors,
  }
})
const REWARD = blockReward(BLOCK_HEIGHT)
const totalHash = final.reduce((s, r) => s + r.kills * 100, 0) || 1
final.forEach(r => {
  r.hash = r.kills * 100
  r.blood = Math.floor(REWARD * (r.hash / totalHash))
})
final.sort((x, y) => y.hash - x.hash)

mkdirSync(OUT_DIR, { recursive: true })
const ladder = eloUpdate(existsSync(LADDER) ? JSON.parse(readFileSync(LADDER, 'utf8')) : {}, final)
writeFileSync(LADDER, JSON.stringify(ladder, null, 2))

const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 19)
const report = [
  `# FragBench run — ${stamp}`,
  ``,
  `- Model: ${MODEL} (5 strategist personas, raw-intent division)`,
  `- Block: height ${BLOCK_HEIGHT}, window ${MINUTES} min, reward ${REWARD} $BLOOD`,
  `- Hash formula: kills x 100 (v0 subset — assists/objective/pickup hash NOT yet implemented)`,
  ``,
  `| # | strategist | model | kills | deaths | hash | $BLOOD | Elo | decisions | errors |`,
  `|---|-----------|-------|-------|--------|------|--------|-----|-----------|--------|`,
  ...final.map((r, i) =>
    `| ${i + 1} | ${r.name} | ${r.model} | ${r.kills} | ${r.deaths} | ${r.hash} | ${r.blood} | ${ladder[r.name].rating} | ${r.decisions} | ${r.errors} |`),
  ``,
  `## Model ranking (best entrant per model)`,
  ``,
  `| # | model | Elo | top entrant | matches |`,
  `|---|-------|-----|-------------|---------|`,
  ...modelBoard(ladder).map(([m, e], i) => `| ${i + 1} | ${m} | ${e.rating} | ${e.top} | ${e.matches} |`),
  ``,
].join('\n')
writeFileSync(OUT_DIR + `run-${stamp}.md`, report)
console.log('\n' + report)
console.log(`ladder: ${LADDER}`)

agents.forEach(a => a.ws.close())
process.exit(0)
