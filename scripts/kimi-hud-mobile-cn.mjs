// 中文版聚焦审查：让 Kimi K3 审计 Frag Arena 的 HUD UI 与移动端 HUD 布局。
// 背景：HUD 刚经历 Overwatch 风格的重做（统一右下组、chrome 瘦身、Barlow 数字、
// 三通道低血 vignette、移动端重排），本次是对重做后成品的复检 + 打磨。
// 用法:  node scripts/kimi-hud-mobile-cn.mjs [startBit]
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-hud-mobile-cn.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const FILES = {
  H: 'public/index.html',
  C: 'public/css/styles-v0.0.1.css',
}
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')])
)
const lang = (f) => (f.endsWith('.css') ? 'css' : 'html')

function slice([k, a, b]) {
  const f = FILES[k]
  const body = SRC[k].slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')
  return `\n----- ${f}  (lines ${a}-${b}) -----\n\`\`\`${lang(f)}\n${body}\n\`\`\``
}

const PERSONA = `你是一位世界级的竞技射击游戏 HUD/UI 设计师兼前端工程师——有《守望先锋》/《Apex 英雄》/《光环 Infinite》级别 HUD 主创的审美，也有移动端 FPS（CoD Mobile / PUBG Mobile）触屏布局的实战经验，能流畅阅读原始 HTML/CSS 并精确到选择器/行号给出修复。

项目：Frag Arena——网页端竞技 FPS（Babylon.js，UT99 血统），已上线 sol-pkmn.fun，桌面+移动双端。HUD 刚完成一次 Overwatch 风格重做：统一右下 HUD 组（血量/武器/手雷）、去 chrome 化（只让数据发光）、Barlow Condensed 数字、颜色纪律（accent 只给关键状态）、三通道低血 vignette、移动端 coarse-pointer 重排。本次审查是对重做后成品的复检：找出残留的业余感、层级失衡、移动端触达/遮挡问题。

你每次只审查一个聚焦切片。每个优化点必须定位到具体选择器/行号，并给出可直接粘贴的修复代码。杜绝"或许可以考虑"式含糊。

输出结构（保持精炼，无开场白）：
- 结论（VERDICT）：1-2 句直白判断——顶级水准还是仍有业余感，为什么。
- 问题（ISSUES）：按优先级：\`[选择器/行号] 问题 -> 可粘贴修复代码\`。
- 最高收益（ONE WIN）：性价比最高的单项改动。

所有选择器/CSS 属性/行号/代码保持英文原样放代码块；分析用专业中文。`

const BITS = [
  { t: 'HUD 整体骨架与信息层级（桌面端）：顶栏 + 准星 + 命中标记', s: [['H', 29, 127], ['C', 131, 374]],
    q: '完整 HUD DOM 骨架 + 顶部对局条/准星/命中标记的样式。信息层级是否成立：交火 3 秒内玩家的眼睛应该只需要准星→血量→弹药，顶栏是否安分？各元素的屏幕锚位（安全边距、与画面中心的距离）是否专业？z-index/pointer-events 分层有没有隐患？' },
  { t: '右下统一 HUD 组：血量/武器/弹药/手雷（重做后的核心成果）', s: [['C', 375, 645]],
    q: '这是 Overwatch 式重做的核心：#hud-right-group 内血量条+25HP 刻度、武器/弹药面板、"只让数据发光"的处理。用最挑剔的眼光复检：数字字重/字号节奏、条与数字的图底、低血/换弹/低弹药状态的递进是否瞬间可读、组内间距节奏（4/8px 网格？）。哪里还残留"网页感"而非"游戏感"？' },
  { t: '手雷面板 + 死亡卡片 + 低血 vignette / 受击反馈', s: [['C', 646, 821]],
    q: '手雷充能、YOU DIED/RESPAWNING 卡片、三通道低血 vignette、受击闪红。死亡→重生的情绪节奏是否到位？vignette 三通道（描边/呼吸/暗角？）在真实对局里会不会过载或没存在感？' },
  { t: '击杀信息流 + 击杀横幅（FragLayer 皮肤）', s: [['C', 822, 943]],
    q: '击杀 feed 行 + 大号 frag 横幅样式。击杀的"值回票价感"够不够？feed 在密集对局下会不会失控？横幅与命中标记/骷髅弹出会不会互相抢戏？' },
  { t: '移动端：触屏摇杆/按钮布局（拇指工效学）', s: [['C', 1550, 1734]],
    q: '触屏控件样式：摇杆、开火/跳跃/换弹/手雷/切枪按钮。用 CoD Mobile 的标准审：按钮尺寸/命中区（≥44px？）、拇指弧线触达、开火键与视角滑动区的冲突、按钮视觉是否克制（半透明描边而非实心块）。给出具体的尺寸/定位修复。' },
  { t: '移动端 HUD 重排：coarse-pointer / 小屏 / 横屏矮屏', s: [['C', 1735, 1970]],
    q: '响应式重排：pointer-coarse 定控制方案、宽度定尺寸，外加 460px 和 max-height 400px 两个极端断点。复检：HUD 组在小屏是否仍撑得住层级？触屏按钮与 HUD 组会不会打架（重叠/太近误触）？矮横屏（iPhone 横持）下顶栏+底组+摇杆同屏的空间预算是否成立？' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const bundle = bit.s.map(slice).join('\n')
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `聚焦切片 (${n}/${BITS.length})：${bit.t}\n\n${bit.q}\n\n以下仅为相关代码：\n${bundle}` },
    ],
    temperature: 0.5,
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
          'X-Title': 'Frag Arena HUD/mobile review (zh)',
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

const start = Math.max(1, Number(process.argv[2]) || 1)
if (start === 1) writeFileSync(OUT, `# Frag Arena — Kimi K3 HUD UI + 移动端布局审查（中文）\n\n`)

for (let i = start - 1; i < BITS.length; i++) {
  const n = i + 1
  process.stderr.write(`\n[${n}/${BITS.length}] ${BITS[i].t} …\n`)
  const ans = await ask(BITS[i], n)
  const block = `\n## ${n}. ${BITS[i].t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500)
}
process.stderr.write(`\nDONE -> ${OUT}\n`)
