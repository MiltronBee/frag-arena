// 中文版聚焦审查：让 Kimi K3 撕开 Frag Arena 的【移动端 UI】——触屏控件 + 移动端 HUD 重排。
// 现状：移动端 UI 目前很差，需要一次不留情面的 teardown + 可直接粘贴的修复。
// 关键决策（2026-07 最佳实践核对后）：
//   - K3 目前只有 max 级 reasoning，无法调低 → 不去压制它思考，而是给足 token 预算，
//     让 reasoning 不会把最终答案挤掉；同时在 prompt 里死死约束【最终输出】的格式与长度。
//   - K3 上下文百万级但很慢（大 context 30–60s+）→ 每次请求加 200s 超时 + 退避重试。
// 用法:  node scripts/kimi-mobile-ui-cn.mjs [startBit]
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-mobile-ui-cn.md`
mkdirSync(dirname(OUT), { recursive: true })
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const FILES = {
  T: 'client/TouchControls.js',                  // DOM 结构（触屏控件在这里动态构建）
  C: 'public/css/styles-v0.0.1.css',             // 全部样式
}
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')])
)
const lang = (f) => (f.endsWith('.css') ? 'css' : f.endsWith('.js') ? 'js' : 'html')

function slice([k, a, b]) {
  const f = FILES[k]
  const body = SRC[k].slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')
  return `\n----- ${f}  (lines ${a}-${b}) -----\n\`\`\`${lang(f)}\n${body}\n\`\`\``
}

// 触屏控件的 DOM 树（每个 bit 都带上，很短，让 K3 始终清楚元素结构）
const DOM = slice(['T', 60, 90])

const PERSONA = `你是一位世界级的移动端竞技射击 UI/UX 设计师兼前端工程师——有 CoD Mobile / PUBG Mobile / Apex Mobile 级别触屏 HUD 主创的实战经验，深谙拇指工效学（thumb-zone / reachability）、触屏 FPS 的开火键与视角滑动区冲突、命中区（hit-target）尺寸规范，并能流畅阅读原始 HTML/CSS/JS、精确到选择器与行号给出可直接粘贴的修复。

项目：Frag Arena——网页端竞技 FPS（Babylon.js，UT99 血统），已上线 sol-pkmn.fun，桌面+移动双端。触屏控件在 client/TouchControls.js 动态构建成一棵挂在 <body> 下的 #touch-controls 树：左半屏 move 区（浮动摇杆，落点生成）、右半屏 look 区（拖动转视角），外加一圈动作键 fire/aim(ADS)/jump/reload/switch/throw/gear。样式全在 styles-v0.0.1.css，移动端靠 @media (pointer:coarse) / max-width / max-height 断点重排。

**现状：委托方明确说移动端 UI「非常非常差」。你的任务是不留情面地 teardown。** 别客气、别找补。用最挑剔的职业眼光找出：拇指够不到 / 误触 / 命中区过小 / 开火键与视角区打架 / HUD 组与按钮重叠遮挡 / 矮横屏空间预算崩掉 / 视觉上「网页感」而非「游戏感」/ z-index 与 pointer-events 埋雷。

**输出纪律（极其重要——这是最终答案，不是你的思考。思考可以尽情展开，但最终答案必须精炼、可执行）：**
- 结论（VERDICT）：2-3 句直白判断——现在到底差在哪、差到什么程度、最致命的一条是什么。
- 问题（ISSUES）：严格按【严重度】排序，每条格式：\`[选择器/行号] 问题 → 可直接粘贴的修复代码\`。宁可少而狠，不要多而虚。杜绝「或许可以考虑」式含糊。
- 最高收益（ONE WIN）：如果只改一处，改哪、怎么改、为什么。

所有选择器/CSS 属性/行号/代码一律英文原样放代码块；分析用专业中文。`

// —— 每个 bit 给相关 CSS 切片；DOM 树每次都带。CSS 移动端四块（2026-07 现网行号）：
//   触屏层+摇杆+按钮基础/落位: 2019-2211
//   移动端重排 @media coarse:   2212-2412
//   小屏/矮屏断点:              2413-2478
//   ADS 开火(aim)按钮:          2718-2739
const BITS = [
  { t: '触屏控件本体：move/look 区 + 浮动摇杆 + 动作键（拇指工效学核心）',
    s: [['C', 2019, 2211]],
    q: '这是移动端最核心的一层。用 CoD Mobile 的标准死磕：\n' +
       '1) 命中区——每个动作键的实际可点尺寸够不够（≥44–48px？触屏 FPS 常要更大）？fire 键是否明显偏小或偏边角？\n' +
       '2) 拇指弧线——右手拇指自然落点是屏幕右下角一段弧；fire/aim/reload/switch/throw/gear 这一圈是否落在够得到的弧线上，还是散落到够不到的位置？左手只管摇杆够不够？\n' +
       '3) 冲突——右半屏是 look 拖动区，fire/aim 等按钮叠在 look 区之上；开火时拇指在按钮上，会不会吃掉本该转视角的拖动？pointer-events / z-index 分层有没有埋雷？\n' +
       '4) 视觉——按钮是克制的半透明玻璃描边，还是实心「网页按钮」块？符号（◉◎▲⟳⇄☀⚙）在实机小屏上可读吗？\n' +
       '精确到选择器/行号，给可粘贴修复。' },

  { t: '移动端 HUD 重排 + 空间冲突：@media (pointer:coarse) 下 HUD 组 vs 触屏按钮',
    s: [['C', 2212, 2412]],
    q: '移动端把桌面 HUD 重排到触屏布局。复检：\n' +
       '1) 遮挡/误触——重排后 #hud-right-group（血量/武器/弹药）与右下那圈触屏按钮，会不会重叠、太近、或血量数字被 gear/throw 按钮压住？\n' +
       '2) 层级——小屏下交火 3 秒内眼睛还能不能只走 准星→血量→弹药？还是被按钮和 chrome 淹没？\n' +
       '3) 锚位与安全边距——各元素贴边距离在带圆角/刘海的手机上安不安全（env(safe-area-inset)）？\n' +
       '精确到选择器/行号给修复。' },

  { t: '极端断点：窄屏(460) / 矮横屏(max-height 560/400) 的空间预算',
    s: [['C', 2413, 2478], ['C', 2718, 2739]],
    q: '矮横屏（iPhone 横持，高度 400–560px）是移动 FPS 最挤的场景：顶栏 + 底部 HUD 组 + 摇杆 + 一圈按钮要同屏共存。复检：\n' +
       '1) 这些断点是否真的解决了空间预算，还是只是缩字体、根本没给按钮/HUD 重新腾地方？\n' +
       '2) 窄屏(460px)下按钮与 HUD 会不会直接叠死？\n' +
       '3) ADS(aim)按钮（#touch-aim）落位是否与 fire 键太近导致误触？\n' +
       '给出具体尺寸/定位修复。' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const bundle = DOM + '\n' + bit.s.map(slice).join('\n')
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `聚焦切片 (${n}/${BITS.length})：${bit.t}\n\n${bit.q}\n\n以下是触屏控件 DOM 结构 + 相关样式：\n${bundle}` },
    ],
    temperature: 0.4,
    // K3 只有 max 级 reasoning、无法调低 → 给足预算，让思考不挤掉最终答案。
    max_tokens: 30000,
    stream: true, // 流式：K3 的 max-level reasoning 会跑很久，非流式会让 socket 空转到超时。
  }
  const IDLE_MS = 120000 // 只在「真的 120s 没有任何字节」时才放弃——健康但漫长的生成不会被误杀。
  const MAX = 40
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const ctrl = new AbortController()
    let idle = setTimeout(() => ctrl.abort(), IDLE_MS)
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_MS) }
    let res
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://sol-pkmn.fun',
          'X-Title': 'Frag Arena mobile UI teardown (zh)',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      clearTimeout(idle)
      console.error(`  net error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    if (!res.ok) {
      clearTimeout(idle)
      let json = {}
      try { json = await res.json() } catch {}
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
        const wait = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000))
        console.error(`  ${res.status} busy — wait ${(wait / 1000).toFixed(0)}s (attempt ${attempt}/${MAX})`); await sleep(wait); continue
      }
      return `**ERROR ${res.status}:** ${JSON.stringify(json?.error ?? json).slice(0, 400)}`
    }
    // —— 流式解析 SSE：累积 content（最终答案）与 reasoning（思考，仅计长度）——
    let content = '', rlen = 0, buf = ''
    const dec = new TextDecoder()
    let t0 = Date.now(), lastLog = 0
    try {
      for await (const chunk of res.body) {
        bump()
        buf += dec.decode(chunk, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          let j; try { j = JSON.parse(data) } catch { continue }
          const d = j.choices?.[0]?.delta
          if (d?.content) content += d.content
          if (d?.reasoning) rlen += d.reasoning.length
        }
        const secs = ((Date.now() - t0) / 1000) | 0
        if (secs - lastLog >= 20) { lastLog = secs; process.stderr.write(`    …${secs}s reasoning≈${rlen} answer≈${content.length}\n`) }
      }
    } catch (e) {
      clearTimeout(idle)
      console.error(`  stream error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    clearTimeout(idle)
    if (content.trim()) {
      process.stderr.write(`  ok (${((Date.now() - t0) / 1000) | 0}s, reasoning≈${rlen} chars, answer ${content.length} chars)\n`)
      return content
    }
    console.error(`  empty answer (attempt ${attempt}, reasoning≈${rlen} chars) — retrying`); await sleep(4000)
  }
  return `**GAVE UP after ${MAX} attempts.**`
}

const start = Math.max(1, Number(process.argv[2]) || 1)
if (start === 1) writeFileSync(OUT, `# Frag Arena — Kimi K3 移动端 UI teardown（中文）\n\n`)

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
