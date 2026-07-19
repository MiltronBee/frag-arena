// 让 Kimi K3 给 Frag Arena 移动端触屏 UI + HUD 一套【AAA 级视觉设计语言】。
// 诉求：现状「一眼 vibecoded」，要提升到 3A 移动射击（CoD Mobile / 暗区突围 / Apex Mobile）质感。
// 工作流（按 [[kimi-consult-workflow]]）：
//   - persona 用简体中文，且已过 gemini-refine-cn.mjs 润色（_work/ui/design-persona-refined.txt）。
//   - persona 里明确要求 Kimi 全程用中文 reasoning（K3 用中文推理明显更强）。
//   - K3 只有 max 级 reasoning、很慢 → 流式 + idle-timeout，给足 max_tokens 让思考不挤掉交付。
// 用法:  node scripts/kimi-mobile-design-cn.mjs
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-mobile-design-cn.md`
mkdirSync(dirname(OUT), { recursive: true })
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')
const PERSONA = readFileSync(`${ROOT}/_work/ui/design-persona-refined.txt`, 'utf8').trim()

const FILES = {
  T: 'client/TouchControls.js',
  C: 'public/css/styles-v0.0.1.css',
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

// 设计语言是整体的 → 一次给全部移动端相关代码：DOM 树 + 触屏层 + 移动重排 + 断点 + ADS。
const BUNDLE = [
  ['T', 60, 90],       // 触屏控件 DOM 树（元素 + 当前的 Unicode glyph）
  ['C', 2019, 2211],   // 触屏层：容器/区/摇杆/动作键基础样式（当前的白块 + backdrop blur）
  ['C', 2212, 2412],   // 移动端 HUD 重排
  ['C', 2413, 2478],   // 断点
  ['C', 2718, 2739],   // ADS aim 按钮
].map(slice).join('\n')

const USER = `这是一次完整的移动端视觉设计语言重构（不是找 bug，是重新定调质感）。请通读下面全部移动端相关代码——触屏控件 DOM 树 + 触屏层样式 + HUD 重排 + 断点 + ADS 按钮——然后按 persona 里的输出规范，给出一套成体系、可直接粘贴落地的 AAA 级设计语言：设计总纲 → 设计变量(tokens) → 落地实现(玻璃材质基类 / 每个动作键的 SVG 图标 / 状态与动效 / HUD 排版) → 最高收益。

务必做到：\n- 图标系统给出全部 7 个动作键（fire/aim/jump/reload/switch/throw/gear）各自的内联 SVG（data-uri），线宽与视觉量感统一。\n- 玻璃材质用 alpha 底色 + 双重描边 + 内阴影实现，绝不用 backdrop-filter: blur。\n- 所有代码精确到选择器/行号，可直接替换或追加。\n\n以下是全部相关代码：\n${BUNDLE}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask() {
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: USER },
    ],
    temperature: 0.5,
    max_tokens: 40000, // 设计交付含大量 SVG/CSS，给足；K3 max reasoning 也吃预算。
    stream: true,
  }
  const IDLE_MS = 120000
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
          'X-Title': 'Frag Arena mobile AAA design (zh)',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      clearTimeout(idle); console.error(`  net error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    if (!res.ok) {
      clearTimeout(idle)
      let json = {}; try { json = await res.json() } catch {}
      if ([429, 502, 503].includes(res.status)) {
        const ra = Number(json?.error?.metadata?.retry_after_seconds) || 0
        const wait = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000))
        console.error(`  ${res.status} busy — wait ${(wait / 1000) | 0}s (attempt ${attempt}/${MAX})`); await sleep(wait); continue
      }
      return `**ERROR ${res.status}:** ${JSON.stringify(json?.error ?? json).slice(0, 400)}`
    }
    let content = '', rlen = 0, buf = ''
    const dec = new TextDecoder()
    const t0 = Date.now(); let lastLog = 0
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
      clearTimeout(idle); console.error(`  stream error (attempt ${attempt}): ${e.message}`); await sleep(5000); continue
    }
    clearTimeout(idle)
    if (content.trim()) {
      process.stderr.write(`  ok (${((Date.now() - t0) / 1000) | 0}s, reasoning≈${rlen}, answer ${content.length})\n`)
      return content
    }
    console.error(`  empty answer (attempt ${attempt}, reasoning≈${rlen}) — retrying`); await sleep(4000)
  }
  return `**GAVE UP after ${MAX} attempts.**`
}

writeFileSync(OUT, `# Frag Arena — Kimi K3 移动端 AAA 视觉设计语言（中文）\n\n`)
process.stderr.write(`\n[design] 生成 AAA 移动端设计语言 …\n`)
const ans = await ask()
appendFileSync(OUT, ans + '\n')
process.stdout.write(ans + '\n')
process.stderr.write(`\nDONE -> ${OUT}\n`)
