// 让 Kimi K3 把 Frag Arena 移动端【操控布局/工效学】做到 AAA 标准（皮肤已单独重构，这轮只碰布局）。
// 工作流（[[kimi-consult-workflow]]）：Mandarin persona（已过 gemini-refine）+ 全程中文 reasoning +
// 流式 + idle-timeout。关键教训：这次喂 Kimi 全量当前代码（含 TouchControls.js 全部 bindings），
// 不再只给切片——上次只给 DOM 切片导致两个假 finding。
// 用法:  node scripts/kimi-mobile-controls-cn.mjs
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-mobile-controls-cn.md`
mkdirSync(dirname(OUT), { recursive: true })
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key')
const PERSONA = readFileSync(`${ROOT}/_work/ui/controls-persona-refined.txt`, 'utf8').trim()

const FILES = { T: 'client/TouchControls.js', C: 'public/css/styles-v0.0.1.css' }
const SRC = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')]))
const lang = (f) => (f.endsWith('.css') ? 'css' : f.endsWith('.js') ? 'js' : 'html')
function slice([k, a, b]) {
  const f = FILES[k]
  const body = SRC[k].slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')
  return `\n----- ${f}  (lines ${a}-${b}) -----\n\`\`\`${lang(f)}\n${body}\n\`\`\``
}

// 全量喂：交互模型(JS 全文) + 触屏控件样式段 + 全部响应式断点。
const BUNDLE = [
  ['T', 1, 383],       // TouchControls.js 全文 — 交互模型（浮动摇杆/drag-look/fire+aim 也看/pulse 键）
  ['C', 2094, 2350],   // 触屏控件：zones + 摇杆 + 按钮基座/图标/定位/状态
  ['C', 2352, 2660],   // 全部响应式断点（HUD 重排 + 菜单 + 窄屏/矮横屏）
].map(slice).join('\n')

const USER = `这是一次移动端【操控布局/工效学】达标重构（皮肤已单独做完，勿动配色/材质，只碰布局几何与响应式）。下面是全量当前代码：触屏交互模型（TouchControls.js 全文）+ 触屏控件样式段 + 全部响应式断点。请通读后按 persona 的输出规范，给出一套达到 AAA 标准的操控布局系统：VERDICT → 几何契约(CSS 变量) → 落地实现(基础横屏/竖屏/矮横屏 三段，每颗键 rect + @media) → 工效学与碰撞自检(坐标算给我看) → ONE WIN。

务必：\n- 竖屏必须让所有动作键彻底离开左半屏（move 摇杆生成区），否则一落点就误触。\n- 高频键(fire/aim/jump/reload)收进拇指可达弧(≤130px)，低频(switch/throw)合理外放。\n- 用几何契约变量派生所有 rect，改一处不叠键；全程 env(safe-area-inset-*)。\n- 代码精确到选择器/行号，可直接替换现有定位规则(#touch-fire/#touch-aim/... 约 L2245-2320)与响应式段。\n\n以下是全部相关代码：\n${BUNDLE}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function ask() {
  const body = { model: 'moonshotai/kimi-k3', messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: USER }], temperature: 0.4, max_tokens: 40000, stream: true }
  const IDLE_MS = 120000, MAX = 40
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const ctrl = new AbortController()
    let idle = setTimeout(() => ctrl.abort(), IDLE_MS)
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_MS) }
    let res
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://sol-pkmn.fun', 'X-Title': 'Frag Arena mobile controls ergonomics (zh)' },
        body: JSON.stringify(body), signal: ctrl.signal,
      })
    } catch (e) { clearTimeout(idle); console.error(`  net error ${attempt}: ${e.message}`); await sleep(5000); continue }
    if (!res.ok) {
      clearTimeout(idle); let j = {}; try { j = await res.json() } catch {}
      if ([429, 502, 503].includes(res.status)) { const ra = Number(j?.error?.metadata?.retry_after_seconds) || 0; const w = Math.min(25000, Math.max(5000, ra * 1000 || 4000 + attempt * 2000)); console.error(`  ${res.status} busy ${(w / 1000) | 0}s (${attempt}/${MAX})`); await sleep(w); continue }
      return `**ERROR ${res.status}:** ${JSON.stringify(j?.error ?? j).slice(0, 400)}`
    }
    let content = '', rlen = 0, buf = ''; const dec = new TextDecoder(); const t0 = Date.now(); let lastLog = 0
    try {
      for await (const chunk of res.body) {
        bump(); buf += dec.decode(chunk, { stream: true }); let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim(); if (data === '[DONE]') continue
          let j; try { j = JSON.parse(data) } catch { continue }
          const d = j.choices?.[0]?.delta; if (d?.content) content += d.content; if (d?.reasoning) rlen += d.reasoning.length
        }
        const s = ((Date.now() - t0) / 1000) | 0; if (s - lastLog >= 20) { lastLog = s; process.stderr.write(`    …${s}s reasoning≈${rlen} answer≈${content.length}\n`) }
      }
    } catch (e) { clearTimeout(idle); console.error(`  stream error ${attempt}: ${e.message}`); await sleep(5000); continue }
    clearTimeout(idle)
    if (content.trim()) { process.stderr.write(`  ok (${((Date.now() - t0) / 1000) | 0}s, reasoning≈${rlen}, answer ${content.length})\n`); return content }
    console.error(`  empty answer ${attempt} (reasoning≈${rlen}) — retry`); await sleep(4000)
  }
  return `**GAVE UP after ${MAX} attempts.**`
}

writeFileSync(OUT, `# Frag Arena — Kimi K3 移动端操控布局 · AAA 标准重构（中文）\n\n`)
process.stderr.write(`\n[controls] 生成操控布局系统 …\n`)
const ans = await ask()
appendFileSync(OUT, ans + '\n')
process.stdout.write(ans + '\n')
process.stderr.write(`\nDONE -> ${OUT}\n`)
