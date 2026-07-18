// 中文版聚焦审查：让 Kimi K3 审计 Frag Arena 的 SFX 缺口，为每个缺失音效设计
// ElevenLabs 生成 prompt（对齐现有 arcade-aggressive 风格），并给出接线方案
// （clip vs 程序化 WebAudio 的取舍 + 具体 file:line 挂点）。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-sfx-review-cn.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const PERSONA = `你是一位世界级的游戏音频设计师与音频程序员——兼具 AAA 竞技射击（Halo/UT/Apex/CoD）的 SFX 设计品味、Web Audio API 的实现功底，以及用 ElevenLabs sound-generation API 批量生成游戏音效的实战经验。你深知竞技 FPS 的音频是"信息系统"而非装饰：武器切换、换弹、命中确认、菜单反馈都要在高压下瞬间可辨、不糊、不疲劳。

项目：Frag Arena——网页端竞技 FPS（Babylon.js + Web Audio）。现有音频是"ElevenLabs 整段 clip（fire/reload/impact 等）叠加程序化 WebAudio 合成层，程序化兜底"。UI/菜单类音效目前几乎全缺。

风格锚点（现有 clip 的 prompt 风格，务必对齐）：arcade shooter、aggressive、dry、close up、punchy、高 prompt_influence（fire/impact 0.75–0.85，reload 0.4）。UI 音效要短、脆、克制、不刺耳、可高频触发不疲劳。

要求：直接、可落地。给出的每个音效都要能立即投产。所有代码/标识符/文件名/参数保持英文原样并放代码块；分析说明用中文。`

// —— 现有音效清单（已覆盖） ——
const CTX_EXISTING = `// 已有 clip（public/assets/sfx/*.mp3，由 scripts/generate-sfx.mjs 生成）：
rifle_fire smg_fire shotgun_fire pistol_fire | rifle_reload smg_reload shotgun_reload pistol_reload | impact_flesh pain_grunt kill_confirm
// 程序化（WeaponAudio.js，无 clip）：hitMarker tick(方波 1400Hz 60ms) / kill 两音(880→1760Hz) / explosion(sine 160→38Hz + noise) / megaHum(90Hz+270Hz) / megaPickup 上行两音(660→990,990→1480) / shotgun pump

// generate-sfx.mjs 的 ElevenLabs 调用（每条 = 一个 mp3）：
// POST https://api.elevenlabs.io/v1/sound-generation  body {text, duration_seconds, prompt_influence}
// MANIFEST 风格示例（要严格对齐这种写法）：
rifle_fire:  { text:'heavy assault rifle single gunshot, huge punchy mechanical slap, sharp crisp transient crack, aggressive, dry, close up, arcade shooter', duration:0.5, influence:0.8 }
kill_confirm:{ text:'high pitched retro video game kill confirmation, metallic synthetic chime, sharp satisfying ding', duration:0.5, influence:0.8 }`

// —— 缺口清单 + 现有接线挂点（file:line） ——
const CTX_GAPS = `// 【缺失音效 + 触发点 file:line】（由代码审计得到，均为当前 ABSENT）：
// 高频/高冲击：
weapon_swap    : 换武器  -> client/Simulator.js:675-702 switchWeapon()      // 无声
ui_click       : 所有菜单按钮点击 -> #enter-arena Simulator.js:1118 / HOW TO MenuControls.js:57 / RESUME / sliders
ui_hover       : 按钮 hover/focus -> 全部按钮，无
menu_open/close: HOW TO 弹窗 MenuControls.js:55/56/62；设置菜单 _openSettings Simulator.js:1235 / _closeSettings:1259
settings_toggle: 暂停/继续（指针锁变化）Simulator.js:1127-1139
death          : 本地玩家死亡 -> Simulator.js onKilled ~162   // 无声
respawn        : 本地玩家重生 -> Simulator.js ~186            // 无声
local_hurt     : 【自己】被打中 -> 目前只有红闪，无音频反馈
// 中频：
grenade_throw  : 投掷手雷 -> Simulator.js:862（只有爆炸有声，投掷无声）
dry_fire/empty : 空弹匣扣扳机 / 弹药见底 -> 无（low-ammo 只有 CSS class）
ready/play_go  : 加载完成 PLAY 解锁 -> Simulator.js:1202-1205（只有发光，无声）

// 播放 API：clip 走 audio.playClip(name,{gain}); 程序化可仿照 hitMarker() 直接合成。`

const BITS = [
  { t: 'SFX 缺口设计：为每个缺失音效给出 ElevenLabs prompt（或判定为程序化）',
    ctx: `${CTX_EXISTING}\n\n${CTX_GAPS}`,
    q: `请为上面每一个【缺失音效】给出投产方案。对每个音效：
1) 判定用 ElevenLabs clip 还是程序化 WebAudio（UI tick/hover/click/dry-fire 这类高频短音通常程序化更优——零加载、零延迟、可微调；死亡/重生/切枪等"有质感"的用 clip）。给出判断理由（一句话）。
2) 若走 clip：给出与现有 MANIFEST 完全同格式的一行（name: { text:'...', duration:X, influence:Y }），text 用英文、对齐 arcade/dry/close-up 风格。UI 音效要"短、脆、克制、不刺耳、可高频不疲劳"。
3) 若走程序化：给出具体合成参数（波形/频率/时长/包络），可仿 hitMarker/megaPickup 的写法。
按优先级排序（高频/高冲击优先）。目标是一份能直接喂给 generate-sfx.mjs 的新 MANIFEST 增量 + 一份程序化音效清单。`
  },
  { t: 'SFX 接线方案：每个新音效挂到哪、避免刺耳/重复疲劳',
    ctx: CTX_GAPS,
    q: `给出把这些新音效接进代码的最小可行方案：
1) 对每个音效，指出应在哪个 file:line / 哪个函数里加一行播放调用（weapon_swap→switchWeapon、ui_click→按钮 handler、death→onKilled、grenade_throw→throwInput 边沿 等），并给出建议的调用签名（如 audio.uiClick() / audio.weaponSwap(idx) / audio.playClip('death')）。
2) 高频音效（ui_click/hover、切枪）如何防止"密集触发时糊成一片/疲劳"：节流、随机微调 pitch(±%)、gain 上限、同一时刻只留最新一个（voice steal）等，给出具体做法。
3) menu_open/close、settings_toggle 这类"转场"音，怎样和视觉动效（发光脉冲、卡片入场）在时机上对齐才不脱节。
4) local_hurt（自己被打）要不要出声、出什么声才有用而不烦（方向性？低血时才更明显？），给出建议。`
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `聚焦 (${n}/${BITS.length})：${bit.t}\n\n${bit.q}\n\n相关清单/上下文：\n\`\`\`\n${bit.ctx}\n\`\`\`` },
    ],
    temperature: 0.5,
    max_tokens: 12000,
  }
  const MAX = 40
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res, json
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://sol-pkmn.fun',
          'X-Title': 'Frag Arena SFX review (zh)',
        },
        body: JSON.stringify(body),
      })
      json = await res.json()
    } catch (e) {
      console.error(`  net error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    if (res.ok) {
      const txt = json.choices?.[0]?.message?.content
      if (txt && txt.trim()) return txt
      console.error(`  empty body (attempt ${attempt}) — retrying`); await sleep(4000); continue
    }
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
      const wait = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000))
      console.error(`  ${res.status} busy — wait ${(wait / 1000).toFixed(0)}s (attempt ${attempt}/${MAX})`); await sleep(wait); continue
    }
    return `**ERROR ${res.status}:** ${JSON.stringify(json?.error ?? json).slice(0, 400)}`
  }
  return `**GAVE UP after ${MAX} attempts.**`
}

writeFileSync(OUT, `# Frag Arena — Kimi K3 SFX 缺口审计 + ElevenLabs prompts（中文）\n\n`)
for (let i = 0; i < BITS.length; i++) {
  const n = i + 1
  process.stderr.write(`\n[${n}/${BITS.length}] ${BITS[i].t} …\n`)
  const ans = await ask(BITS[i], n)
  const block = `\n## ${n}. ${BITS[i].t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500)
}
process.stderr.write(`\nDONE -> ${OUT}\n`)
