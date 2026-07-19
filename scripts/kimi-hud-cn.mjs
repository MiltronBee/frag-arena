// 用中文让 Kimi (moonshotai/kimi-k3 via OpenRouter) 重做我们的 HUD —— 它现在「一看就是随手糊的」。
// 关键：给 reasoning 设上限并把 max_tokens 拉高，逼它真正写出可粘贴的代码，而不是把预算全烧在推理上。
import { readFileSync, writeFileSync } from 'node:fs'
const OUTFILE = '/mnt/echostore/kimi-hud.out'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const ROOT = '/home/miltron/unreal'
const files = [
  'public/index.html',                 // HUD + 菜单标记
  'public/css/styles-v0.0.1.css',       // 全部样式
  'client/graphics/FragLayer.js',       // 击杀反馈/HUD 叠加层（killfeed、frag banner、hitmarker、伤害弧、死亡镜头）
]
const bundle = files.map(f => {
  const body = readFileSync(`${ROOT}/${f}`, 'utf8')
  const lang = f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'js'
  return `\n===== FILE: ${f} =====\n\`\`\`${lang}\n${body}\n\`\`\``
}).join('\n')

const PERSONA = `你是世界顶级的游戏 UI / HUD 设计师兼前端工程师：你的品味是「3A 射击游戏 HUD 主美（Halo /
UT / Apex / Valorant）」×「现代 Web 设计系统工程师」×「Babylon.js 技术美术」的交集。你能流畅阅读原始
HTML + CSS + JS，能就 DOM 结构、CSS 架构、设计 token、层级、间距、排版、栅格、动效、压力下的可读性、
移动端和无障碍做出判断。你给的每一条建议都必须落在**具体的选择器 / 元素 id / CSS 自定义属性 / 代码行**
上，绝不空泛。你提出的每个改动都要给出**可直接粘贴的 CSS/HTML**。请用中文回答，代码保留英文。`

const BRIEF = `
这是一个快节奏浏览器竞技射击游戏 Frag Arena（Babylon.js，UT99×Halo 手感），已上线 sol-pkmn.fun。
下面是它**整个呈现层**：游戏内 HUD + 菜单/加载屏 + FragLayer 击杀反馈。

**核心痛点：HUD 现在「一看就是随手 vibecode 出来的」——不精致、不成体系、不像一个用心做的竞技射击
HUD。** 我要你把它提升到「像真的 3A 射击游戏 HUD」的水准：有意图、有层级、有节奏、在战斗压力下极度
清晰。**重点是游戏内 HUD**（菜单其次）。

当前 HUD 元素（见文件）：
- 顶部对局条：ONLINE 状态、ping、玩家数、frags·deaths。
- 左上生命面板：大号 100 + HP + 绿色血条。
- 右上武器/弹药面板：武器名（RIFLE）+ 弹匣/备弹（30 / 90）+ 武器小图标。
- 手雷指示（右上「x2」+ 三格）。
- 动态准星（按武器变化）、命中标记 hitmarker、受击伤害闪、方向伤害弧、YOU DIED 状态。
字体：Chakra Petch、Teko、Inter。深色、战术、竞技风。必须桌面 + 移动端都好用。

请给出**具体的、可直接粘贴的**改造，按「性价比（影响/工作量）」排序，覆盖：

1. **整体 HUD 语言 / 设计系统**：定义一套 CSS 自定义属性（颜色、间距刻度、圆角、描边、发光、字号阶梯、
   动效时长）作为 HUD 的统一 token，让所有面板看起来是**同一个系统**。给出 :root 变量块 + 如何套用到
   现有选择器。指出现在哪些地方是「魔法数字 / 不一致」并给出替换。

2. **每个 HUD 组件逐个重做**（顶部对局条、生命面板、武器/弹药面板、手雷、准星、hitmarker、伤害反馈）：
   针对现有的具体选择器/id，给出改进后的 CSS（层级、间距、排版对齐、切角/描边、发光、状态色——低血量、
   命中、重装）。低血量脉冲、命中/击杀的动效反馈要具体到 keyframes。

3. **排版与层级**：Teko/Chakra Petch/Inter 各自该用在哪、字重字距行高，数字如何做等宽跳动（tabular-nums）
   让弹药/血量跳动不抖。

4. **移动端**：HUD 在小屏怎么缩放/重排（安全区、触控不遮挡、尺寸）。

5. **克制**：竞技射击 HUD 要极简、不遮视野、不喧宾夺主。指出现在哪些是**过度设计/该删**的。

请基于我们真实的文件推理，落到具体选择器与代码。
${bundle}
`

const reqBody = {
  model: 'moonshotai/kimi-k3',
  messages: [
    { role: 'system', content: PERSONA },
    { role: 'user', content: BRIEF },
  ],
  temperature: 0.5,
  max_tokens: 18000,
  // reasoning=low：加快出结果、给 content 留足空间（上次 max_tokens 太大导致请求超时被 kill、输出丢失）。
  reasoning: { effort: 'low' },
}

const t0 = Date.now()
console.error(`[kimi-hud] request sent, prompt ~${Math.round(BRIEF.length/1000)}k chars ...`)
try {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  })
  const json = await res.json()
  const c = json.choices?.[0]
  console.error(`[kimi-hud] http=${res.status} ${Date.now()-t0}ms finish=${c?.finish_reason} content_len=${(c?.message?.content||'').length} reasoning_len=${(c?.message?.reasoning||'').length} err=${json.error?.message||''}`)
  const out = c?.message?.content
  if (out && out.length) { writeFileSync(OUTFILE, out); console.log(out) }
  else { writeFileSync(OUTFILE, '[EMPTY] ' + JSON.stringify(json).slice(0, 3000)); process.exit(2) }
} catch (e) {
  console.error('FETCH ERROR:', e && e.stack || String(e))
  process.exit(3)
}
