// One-off: refine my draft Mandarin (the Kimi persona) via Gemini 3.5-flash.
// Reads a draft from stdin arg file, asks Gemini to polish technical zh-CN.
import { readFileSync } from 'node:fs'
const env = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = env.match(/^ALT=(.+)$/m)?.[1]?.trim() || env.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim()
const draft = readFileSync(process.argv[2], 'utf8')

const SYS = `你是一位精通简体中文技术文案的双语校对专家，尤其熟悉游戏开发、前端 Web（HTML/CSS/DOM/设计系统）、以及实时图形（Babylon.js/WebGL、光照、材质、后处理、特效）领域的中文术语惯用法。
任务：把用户给出的中文草稿润色成地道、专业、简洁的简体中文，供一个中国大模型（Kimi）作为"系统提示词/人设"使用。
要求：
1. 术语要用中文技术圈真实惯用的说法（例如 juice=打击感/手感、readability=可读性、design tokens=设计变量/设计令牌、viewmodel=手部模型/第一人称模型、recoil=后坐力、muzzle flash=枪口火光）。
2. 保持所有英文代码标识、选择器、CSS 属性名、行号、以及"可粘贴代码保持原样"的指令不变。
3. 不要增删语义，只做地道化润色。语气要直接、专业。
4. 只输出润色后的中文全文，不要任何解释、不要开场白。`

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    systemInstruction: { parts: [{ text: SYS }] },
    contents: [{ role: 'user', parts: [{ text: `请润色以下草稿：\n\n${draft}` }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
  }),
})
const json = await res.json()
if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(json).slice(0, 500)); process.exit(1) }
process.stdout.write(json.candidates?.[0]?.content?.parts?.[0]?.text || '(no text)\n')
