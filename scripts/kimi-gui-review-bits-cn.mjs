// 中文版：Kimi K3（moonshotai/kimi-k3，经 OpenRouter）逐块审查 Frag Arena 的 GUI。
//
// 为什么用中文：Kimi 是月之暗面（Moonshot）的模型，用母语中文提问通常能提升其推理质量。
// 人设（persona）经 Gemini 3.5-flash 润色技术术语。所有选择器/CSS 属性名/行号/可粘贴代码
// 一律保持英文原样；分析说明用中文。
//
// 为什么逐块（bit-by-bit）：整份 GUI 一次性发送会触发 OpenRouter 对该高热度模型的
// 单请求 token 速率限制（429 风暴）。所以拆成 20 个聚焦小问题，每个只带自己那一小片代码。
//
// 用法:  node scripts/kimi-gui-review-bits-cn.mjs [startBit]
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-20bit-review-cn.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

// file shortcuts
const FILES = {
  H: 'public/index.html',
  C: 'public/css/styles-v0.0.1.css',
  R: 'client/graphics/BABYLONRenderer.js',
  F: 'client/graphics/firingFx.js',
  G: 'client/graphics/FragLayer.js',
}
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')])
)
const lang = (f) => (f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'js')

function slice([k, a, b]) {
  const f = FILES[k]
  const body = SRC[k].slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')
  return `\n----- ${f}  (lines ${a}-${b}) -----\n\`\`\`${lang(f)}\n${body}\n\`\`\``
}

const PERSONA = `你是一位世界级的竞技射击游戏 UI/UX 与实时图形工程师——兼具已发售 3A 大作（如《光环》/《虚幻竞技场》/《Apex 英雄》）HUD 主创的审美、现代 Web 设计系统工程师的严谨，以及 Babylon.js/WebGL 技术美术的功底。你能流畅阅读原始 HTML/CSS/Babylon.js 代码，并对 DOM 结构、CSS 自定义属性（Design Tokens）、动效、高压对局下的可读性、移动端交互行为进行深度推理；同时也精通光照、材质、后处理、粒子/枪口火光特效、镜头手感，以及让每一次开火都极具打击感（Juice）的细节调优。

项目：Frag Arena——一款快节奏的网页端竞技 FPS（基于 Babylon.js，融合 UT99 与《光环》风格），已在 sol-pkmn.fun 上线，是一部独立游戏作品。视觉风格：暗黑、战术、竞技。字体：Chakra Petch、Teko、Inter。同时支持桌面端与移动端。你的任务是在现有代码基础上进行提升与打磨，而非推倒重来。

你每次只审查一个聚焦的代码切片（Slice）。请紧扣给定的切片范围。每一个优化点都必须精准定位到代码中具体的选择器、ID、CSS 自定义属性或行号。给出具体、可直接粘贴的修复方案（即修改后的确切 CSS/HTML/JS 代码）——杜绝泛泛而谈，不要出现"或许可以考虑"等含糊词汇。务必直接、具体、一针见血。

请严格按照以下结构输出，保持语言精炼：
- 结论（VERDICT）：1-2 句直白犀利的判断——评估该元素是达到了顶级射击游戏水准，还是处于业余水平，并简述原因。
- 问题（ISSUES）：按优先级排列的优化要点，格式为：\`[选择器/行号] 问题描述 -> 可直接粘贴的修复代码\`。
- 最高收益（ONE WIN）：该切片中性价比最高、改动后体验提升最显著的单项优化。
保持简短。无需任何开场白，不要复述任务。

重要：所有选择器、ID、CSS 属性名、行号以及可直接粘贴的代码修复，都必须保持英文/代码原样并包裹在代码块中；分析与说明文字使用专业中文。`

const BITS = [
  { t: '准星（按武器切换、随散射反应）', s: [['C', 179, 223], ['H', 45, 68]],
    q: '这是动态的按武器切换准星（SVG）。它在明亮和黑暗场景下是否都清晰可读？散射/开花（bloom）反馈是否读得清楚？霰弹枪的圆环是否诚实反映实际散射？请针对可读性、描边对比、以及散射动画手感给出修复。' },
  { t: '命中标记（命中显示骨头 / 击杀显示血）', s: [['C', 224, 299], ['H', 69, 69]],
    q: '命中标记 + 击杀/骷髅弹出及其关键帧动画。命中 vs 重击 vs 击杀的层级递进在交火中能否瞬间读懂？请针对时机、缩放、颜色，以及"我到底有没有拿到确认击杀"的清晰度给出意见。' },
  { t: '血量面板', s: [['C', 300, 314], ['C', 382, 443], ['H', 71, 82]],
    q: '血量读数 + 填充条 + 低血/超额治疗状态。交火中数字的可读性、阈值变色、低血脉冲、以及超额治疗（>100）的可读性。' },
  { t: '武器 / 弹药面板（Halo 风格计数器）', s: [['C', 315, 532], ['H', 84, 95]],
    q: '武器+弹药面板：弹匣/备弹计数、武器类别图标蒙版、换弹与低弹药状态、四角括号。一眼可读性，以及换弹/低弹药提示。' },
  { t: '手雷面板', s: [['C', 533, 568], ['H', 100, 103]],
    q: '手雷充能指示器。它是否读起来像"弹药类"的东西？空状态是否清晰？是否契合整个 HUD 的视觉语言？' },
  { t: '死亡 / 重生卡片', s: [['C', 569, 610], ['H', 105, 110]],
    q: 'YOU DIED / RESPAWNING 卡片。冲击力 vs 过度煽情、入场动效，它能否占据屏幕又不挡住重生读取？' },
  { t: '受击闪红 + 低血边缘暗角', s: [['C', 611, 634], ['C', 437, 443]],
    q: '方向性/无方向受击闪红，以及持续的低血边缘暗角（vignette）。受伤反馈是否既有力又诚实，还是要么看不见、要么让人眩晕？' },
  { t: '顶部对局条（连接 / 延迟 / 击杀数）', s: [['C', 119, 178], ['H', 29, 43]],
    q: '顶部 HUD 条：品牌标识、连接状态芯片、延迟/构建号、玩家数、击杀/死亡统计。层级、是否分散屏幕中心注意力、连接状态是否一眼可读？' },
  { t: '击杀信息 / 击杀横幅（FragLayer）', s: [['C', 635, 740], ['G', 32, 120]],
    q: '击杀信息行 + 大号击杀横幅。一次击杀是否让人觉得"值"且清晰可读？横幅时机是否合适？信息流是否杂乱？请同时评判 CSS 和它驱动的 FragLayer DOM。' },
  { t: '入场菜单 + PLAY 加载按钮', s: [['C', 741, 1024], ['H', 114, 160]],
    q: '入场/主菜单，同时兼作加载画面（PLAY 按钮随加载进度填充，完成后解锁）。从一个冷启动链接进来的第一印象。布局、加载->解锁动效、呼号（callsign）输入、钱包/教程按钮。' },
  { t: 'HOW TO PLAY 弹窗', s: [['C', 1025, 1074], ['H', 162, 183]],
    q: 'HOW TO PLAY 半透明弹窗 + 操作列表。对全新玩家的清晰度、桌面 vs 触屏说明、面板规格一致性。' },
  { t: '设置 / 暂停菜单', s: [['C', 1075, 1238], ['H', 185, 208]],
    q: '设置暂停菜单：FOV/灵敏度/触屏滑块、反转开关、继续。range 输入控件样式、布局，它感觉像一个真正的设置面板，还是一个粗糙的表单？' },
  { t: '开屏画面', s: [['C', 1540, 1630], ['H', 249, 261]],
    q: '启动时的即时品牌开屏（logo 描边入场、自动跳过）。它是奠定了高级基调，还是拖慢了玩家？动效 + 时机。' },
  { t: '字体、颜色变量与 CSS 设计系统', s: [['C', 10, 72]],
    q: ':root 设计变量（颜色 + 弹药 HUD 配色 + 字体）。这是否是一套连贯、可维护的设计系统？命名、缺口、重复、配色对比度。给出具体到变量层面的修复。' },
  { t: '移动端：触屏操作 + 响应式 HUD', s: [['C', 1287, 1430], ['C', 1431, 1539]],
    q: '触屏摇杆/按钮 + 移动端/粗指针（coarse-pointer）HUD 重排。拇指触及范围、对屏幕中心的遮挡、HUD 在小/矮屏幕上是否还能撑得住？' },
  { t: '光照系统 + 镜头设置', s: [['R', 66, 162]],
    q: '场景光照（黄昏环境光 + 太阳光 + 阴影）、独立的手部模型（viewmodel）光照，以及双镜头设置 + 图像处理暗角。是什么让竞技场看起来扁平而非高级？光照系统上性价比高的小改动 vs 值得大改的地方。' },
  { t: '材质 / 竞技场 PBR 观感', s: [['R', 168, 231]],
    q: '地面 + 障碍物材质、自发光描边点缀、PhotoDome 天空。这些材质读起来像一个真实的竞技场，还是像灰色盒子？给出具体的材质/自发光/雾效改动，以达到竞技射击的观感。' },
  { t: '特效池化 + 后处理 + 枪口光', s: [['R', 73, 84], ['R', 232, 340]],
    q: '图像处理管线（色调映射/对比度/暗角）、精灵/特效池化，以及场景中唯一的枪口火光点光源。哪些后处理通道（辉光 glow/泛光 bloom/色差 chromatic）或枪口光调优，能以最低成本带来最强的"打击感"？' },
  { t: '各武器开火特效辨识度', s: [['F', 1, 140]],
    q: '各武器开火特效配置（弹道 tracer、枪口火光、弹着点、后坐力 kick、枪口光）。每把武器是否都有独特、爽快的签名式手感？给出具体参数改动，以强化各武器辨识度与后坐力打击感。' },
  { t: '后坐力 / 镜头晃动 与 手部模型手感', s: [['F', 20, 140]],
    q: '后坐力模型：镜头位移 kick + 抖动 shake + 上跳 climb，以及手部模型的程序化 kick 个性。开火是否感觉有分量且不影响瞄准？怎样能让 kick 读起来有冲击力却不伤害瞄准？' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const bundle = bit.s.map(slice).join('\n')
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `聚焦切片 (${n}/20)：${bit.t}\n\n${bit.q}\n\n以下仅为相关代码：\n${bundle}` },
    ],
    temperature: 0.5,
    // kimi-k3 是推理模型：会先在隐藏的 reasoning 字段消耗 token。整块代码下 reasoning
    // 本身可吃掉约 2k token，低上限会导致截断（finish=length）甚至 content:null。8000 留足空间。
    max_tokens: 8000,
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
          'X-Title': 'Frag Arena GUI review (bits, zh)',
        },
        body: JSON.stringify(body),
      })
      json = await res.json()
    } catch (e) {
      console.error(`  net error (attempt ${attempt}): ${e.message}`)
      await sleep(5000)
      continue
    }
    if (res.ok) {
      const txt = json.choices?.[0]?.message?.content
      if (txt && txt.trim()) return txt
      console.error(`  empty body (attempt ${attempt}) — retrying`)
      await sleep(4000)
      continue
    }
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
      const wait = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000))
      console.error(`  ${res.status} busy — wait ${(wait / 1000).toFixed(0)}s (attempt ${attempt}/${MAX})`)
      await sleep(wait)
      continue
    }
    return `**ERROR ${res.status}:** ${JSON.stringify(json?.error ?? json).slice(0, 400)}`
  }
  return `**GAVE UP after ${MAX} attempts (still 429/503).**`
}

const start = Math.max(1, Number(process.argv[2]) || 1)
if (start === 1) writeFileSync(OUT, `# Frag Arena — Kimi K3 逐块 GUI 审查（中文）\n\n`)

for (let i = start - 1; i < BITS.length; i++) {
  const n = i + 1
  const bit = BITS[i]
  process.stderr.write(`\n[${n}/20] ${bit.t} …\n`)
  const ans = await ask(bit, n)
  const block = `\n## ${n}. ${bit.t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500)
}

process.stderr.write(`\nDONE -> ${OUT}\n`)
