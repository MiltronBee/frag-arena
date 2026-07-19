// 用中文让 Kimi 重做我们的菜单/各屏（主菜单、splash、加载、设置、how-to-play）——现在「太 vibecode」。
// 和 HUD 那个并行跑。reasoning 设上限 + max_tokens 拉高，逼它真正输出可粘贴代码。
import { readFileSync } from 'node:fs'
const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key')

const ROOT = '/home/miltron/unreal'
const files = ['public/index.html', 'public/css/styles-v0.0.1.css']
const bundle = files.map(f => {
  const body = readFileSync(`${ROOT}/${f}`, 'utf8')
  const lang = f.endsWith('.css') ? 'css' : 'html'
  return `\n===== FILE: ${f} =====\n\`\`\`${lang}\n${body}\n\`\`\``
}).join('\n')

const PERSONA = `你是世界顶级的游戏「前端菜单/UI」设计师兼前端工程师：品味是「3A 射击游戏主菜单主美（Halo /
Destiny / Valorant / CoD）」×「现代 Web 设计系统工程师」的交集。你能流畅读原始 HTML+CSS，就信息层级、
排版、栅格、间距、动效、状态、加载体验、品牌一致性做判断。每条建议都落到具体选择器/id/CSS 变量/代码行，
给可直接粘贴的 CSS/HTML。用中文答，代码用英文。`

const BRIEF = `
Frag Arena / 「Degen Tournament」——已上线 sol-pkmn.fun 的浏览器竞技射击。下面是它的 index.html + 全部 CSS。
品牌：工业风「D」logo，深色战术风，Solana 主题，青色强调色 #14F195。字体 Chakra Petch / Teko / Inter。

**核心痛点：菜单和各个屏「太 vibecode」——不精致、不成体系、不像一个用心做的 3A 游戏前端。** 把它们提升到
「像真的大作主菜单」的水准：有品牌感、有层级、有节奏、加载体验讲究、桌面+移动端都好。

涉及的屏 / 组件（见文件里的具体 id/class）：
- **Splash / 开屏门**（首次点击手势前的 SOLANA 卡片门）。
- **主菜单 = #entry-overlay**：PLAY 按钮会随加载进度填充（同时兼作加载屏），还有一个分段数码管式的加载读数
  （#seg-int / #seg-frac 等）。菜单背景 --menu-bg + .entry-bg 层 + 遮罩 scrim。
- **HOW TO PLAY 弹窗**。
- **SETTINGS 暂停菜单**。
- 品牌标记（logo）、标题「Degen Tournament」。

请给出**具体、可直接粘贴、按性价比排序**的改造，覆盖：

1. **统一设计系统 / token**：:root 里定义颜色（含 Solana 青 #14F195 的用法克制化）、间距刻度、圆角、描边、发光、
   字号阶梯、动效时长；指出现在的魔法数字/不一致并替换。让 splash、菜单、弹窗、设置看起来是**同一套系统**。
2. **主菜单 #entry-overlay 逐项重做**：布局与层级（logo/标题/PLAY/副操作的视觉重量与位置）、背景层+遮罩的
   处理（别糊）、PLAY 按钮（默认/悬停/按下/禁用/**加载填充中**各态），给具体 CSS 与 keyframes。
3. **加载体验**：PLAY 兼加载屏 + 分段数码管读数怎么做得高级（进度填充动画、数字用 tabular-nums 稳定跳动、
   完成态的反馈）。给具体选择器的 CSS。
4. **Splash 开屏门 / HOW TO PLAY / SETTINGS**：各自的排版、卡片/弹窗质感（描边/发光/背板模糊）、进入退出动效。
5. **移动端**：小屏下菜单/弹窗/PLAY 的缩放与安全区、触控目标尺寸。
6. **克制**：指出哪些是过度设计/该删的，让它更干净高级。

基于真实文件推理，落到具体选择器与代码。
${bundle}
`

const reqBody = {
  model: 'moonshotai/kimi-k3',
  messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: BRIEF }],
  temperature: 0.5,
  max_tokens: 40000,
  reasoning: { max_tokens: 12000 },
}
try {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  })
  const json = await res.json()
  if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(json, null, 2)); process.exit(1) }
  const out = json.choices?.[0]?.message?.content
  if (!out) { console.error('EMPTY (finish=' + json.choices?.[0]?.finish_reason + '):', JSON.stringify(json, null, 2).slice(0, 1500)); process.exit(2) }
  console.log(out)
} catch (e) { console.error('FETCH ERROR:', e && e.stack || String(e)); process.exit(3) }
