// 中文版聚焦审查：让 Kimi K3 精修 Frag Arena 的 SVG 品牌标志（骷髅+准星 logo）。
// 目标：专业级 logo 打磨——形状语言、小尺寸可读性（16px favicon 到 180px splash）、
// 渐变/配色、以及可直接落盘的改进版 SVG 代码。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-logo-review-cn.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const PERSONA = `你是一位世界级的品牌标志设计师兼 SVG 工艺大师——既有为游戏工作室（Riot/Bungie/Valve 风格）做竞技游戏品牌的品味，也有手写优化 SVG path 的硬功夫。你深知一个好的游戏 logo 必须：16px favicon 下仍可辨、单色/反白可用、形状剪影独特（squint test 过关）、几何关系严谨（光学对齐而非数学对齐）。

项目：Frag Arena——网页端竞技 FPS（快节奏 arena shooter，UT99 血统），跑在 Solana 生态（经济用 SPL token），视觉基调是"复古街机 + 现代竞技 HUD"（Overwatch 式的克制 chrome、Barlow 数字字体、暗底霓虹）。品牌色锚点是 Solana 渐变（#14F195 绿 → #9945FF 紫）。

要求：直接、可落地、毒舌但专业。所有 SVG 代码放代码块且必须完整可用（能直接存盘替换原文件）；分析说明用中文。不要泛泛而谈"可以考虑"，要给出确定的设计决策和理由。`

const LOGO_SVG = readFileSync(`${ROOT}/public/assets/brand/logo.svg`, 'utf8')
const SKULL_SVG = readFileSync(`${ROOT}/public/assets/brand/skull.svg`, 'utf8')

const CTX = `// ===== 现有主 logo：public/assets/brand/logo.svg =====
${LOGO_SVG}

// ===== 派生单色骷髅：public/assets/brand/skull.svg（HUD 血量图标/死亡画面用） =====
${SKULL_SVG}

// ===== 实际使用场景（public/index.html）=====
// favicon                      : <link rel="icon" href="logo.svg">           → 浏览器 tab ~16px
// 顶部品牌 lockup              : logo.svg 30×30 + "FRAG ARENA" 文字
// 入口卡片                     : logo.svg 52×52
// 开屏 splash                  : logo.svg 180×180（有 draw-in 动画）
// HUD 血量图标                 : skull.svg 26×26（暗底上，bone 色 #ECE6D2）
// 死亡画面                     : skull.svg 72×72
// 页面基调：极暗底（近黑），HUD 用霓虹 accent，字体 Barlow Condensed`

const BITS = [
  { t: 'Logo 精修：毒舌诊断 + 直接给出改进版 logo.svg',
    q: `先对现有 logo 做一次不留情面的专业诊断（形状语言、比例、光学对齐、渐变用法、血滴细节、reticle 与骷髅的图底关系、squint test / 16px favicon 表现），逐条列出问题并按严重度排序。

然后直接给出你的改进版 logo.svg——完整 SVG 代码，viewBox 保持 256×256，保留核心识别元素（准星 reticle + 骷髅 + Solana 渐变），但按你的诊断修正所有问题。关键设计决策（改了什么、为什么）逐条说明。

硬约束：
1) 纯手写 SVG，无滤镜/无 raster，节点数克制（这是要进 git 的手工资产）。
2) 必须在 16px（favicon）和 180px（splash）两个极端都成立——如有必要可以在 SVG 内用 <media> 之外的手段做"简化层级"取舍，但优先单一版本通吃。
3) 暗底（近黑）是主要展示环境，反白可用性优先于白底。`
  },
  { t: '派生系统：skull.svg 单色版 + favicon 策略 + 动画配合',
    q: `基于你上一轮给出的改进版主 logo（保持一致的形状语言），处理派生资产系统：

1) 给出配套的改进版 skull.svg（单色 bone #ECE6D2 描边版，26px HUD 和 72px 死亡画面两个场景），完整 SVG 代码。注意注释里说明的约束：它经 <img> 加载，currentColor/CSS 变量不生效，颜色必须硬编码。
2) favicon 策略：logo.svg 直接当 favicon 在 16px 下的取舍是否成立？如果不成立，给出专用 favicon 变体的完整 SVG（可以更激进地简化）。
3) splash 有 stroke draw-in 动画（180px）：指出改进版 logo 中哪些 path 适合做 draw-in（stroke-dasharray 技法），哪些应该 fade-in，给出建议的动画分层顺序（不用写 CSS，说清层次即可）。
4) 如果"FRAG ARENA"文字 lockup（Barlow Condensed，横排在 logo 右侧）有排版建议（间距/对齐基线/大小比例），一并给出。`
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const history = []

async function ask(bit, n) {
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      ...history,
      { role: 'user', content: `聚焦 (${n}/${BITS.length})：${bit.t}\n\n${bit.q}\n\n现有资产与使用场景：\n\`\`\`\n${CTX}\n\`\`\`` },
    ],
    temperature: 0.5,
    // kimi-k3 是推理模型：设计类任务的隐藏 reasoning 可吃掉 1 万+ token；
    // 上限太低会 finish=length 且 content:null（表现为 "empty body"）。32k 兜底。
    max_tokens: 32000,
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
          'X-Title': 'Frag Arena logo review (zh)',
        },
        body: JSON.stringify(body),
      })
      json = await res.json()
    } catch (e) {
      console.error(`  net error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    if (res.ok) {
      const c = json.choices?.[0]
      const txt = c?.message?.content
      if (txt && txt.trim()) return txt
      console.error(`  empty body (attempt ${attempt}) finish=${c?.finish_reason}/${c?.native_finish_reason} reasoning=${c?.message?.reasoning?.length ?? 0} usage=${JSON.stringify(json.usage?.completion_tokens_details)} — retrying`); await sleep(4000); continue
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

writeFileSync(OUT, `# Frag Arena — Kimi K3 SVG logo 精修（中文）\n\n`)
for (let i = 0; i < BITS.length; i++) {
  const n = i + 1
  process.stderr.write(`\n[${n}/${BITS.length}] ${BITS[i].t} …\n`)
  const ans = await ask(BITS[i], n)
  // 第二轮需要看到第一轮给出的改进版 logo，所以带上对话历史
  history.push(
    { role: 'user', content: `聚焦 (${n}/${BITS.length})：${BITS[i].t}\n\n${BITS[i].q}` },
    { role: 'assistant', content: ans },
  )
  const block = `\n## ${n}. ${BITS[i].t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500)
}
process.stderr.write(`\nDONE -> ${OUT}\n`)
