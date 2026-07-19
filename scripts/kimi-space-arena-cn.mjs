// 用中文咨询 Kimi (moonshotai/kimi-k3 via OpenRouter) —— 它在中文下 3D 推理最强。
// 目标：为我们「面对世界(Facing Worlds)」风格的 CTF 地图打造惊艳的太空竞技场视觉。
// 调用方式沿用 scripts/kimi-gui-review.mjs。
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const ROOT = '/home/miltron/unreal'
const files = [
  'client/graphics/BABYLONRenderer.js',
  'client/graphics/arenaDressing.js',
  'common/arenaConfig.js',
]
const bundle = files.map(f => {
  const body = readFileSync(`${ROOT}/${f}`, 'utf8')
  return `\n===== FILE: ${f} =====\n\`\`\`js\n${body}\n\`\`\``
}).join('\n')

const PERSONA = `你是世界顶级的实时图形技术美术 + Babylon.js 专家，专门为 3A 竞技射击游戏做「让人惊叹」的
画面。你精通灯光布置、PBR / StandardMaterial 取舍、后处理（bloom / 色调映射 / 暗角）、自定义
着色器（ShaderMaterial / NodeMaterial）、大气散射、天空盒、LOD、drawcall 预算，以及移动端 GPU
限制。你会阅读给你的真实引擎代码，并给出具体的、可直接粘贴的 Babylon.js 4.0.3 代码——绝不给
「你可以试试」这种空话。请用中文回答，代码和文件名保留英文。`

const BRIEF = `
目标：把我们的 CTF 地图做成一个「惊艳」的太空竞技场。情感目标就是经典的画面——两座塔矗立在
小行星上，地球在轨道下方悬挂，远处有月亮，漫天繁星——但要用现代手法渲染得非常漂亮，比 1999 年
的老游戏强得多。这是我们**原创**的致敬（自己的几何体：双塔、塔之间一条长而暴露的中央平台、每座
塔顶有旗帜台、跳板电梯）。它跑在浏览器里（Babylon.js 4.0.3），必须同时兼容桌面和移动端，而且是
快节奏竞技射击，所以画面必须保持清晰可读且性能便宜。

我们现有的东西（见下方文件）：
- BABYLONRenderer.js：场景本体。目前是一个平淡的「黄昏」PhotoDome 天空盒（skybox_dusk.png），
  一个 HemisphericLight 环境光 + 一个暖色 DirectionalLight 太阳 + 阴影，StandardMaterial 层级的
  色调映射/对比度/暗角，EXP2 雾，一块深色地面。相机 minZ 0.05，maxZ 2000，fov 1.0。已有一个只
  作用于 FX 精灵的 GlowLayer（白名单）。
- 服务器上已经有这些贴图：/assets/space/stars.jpg、earth_day.jpg、earth_night.jpg（城市灯光）、
  moon.jpg。还没接进任何视觉。
- arenaDressing.js：用一套很小的 Quaternius 科幻套件（8 个部件：金属/暗色平台、高墙+矮墙、空心
  柱、板条箱、小风扇、地面灯）给碰撞盒「贴皮」。
- arenaConfig.js：面对世界的盒子几何（塔在 x=±48，高度 8，长平台，跳板，外围墙），全部在 ±64 单位
  的盒子内。

请给出具体的、可直接粘贴的 Babylon.js 4.0.3 代码，覆盖：

1. 太空视觉（整个东西的主角）。请给我确切代码来构建：
   - 一个可信的星空背景（自发光、不受雾和场景灯影响、在 maxZ 2000 内的正确尺度）。如果值得，做分层
     视差星空。
   - 一个又大又美、悬挂在平台下方/旁边的**地球**，带**真实的昼夜分界线**：白天面用 earth_day.jpg 被
     太阳照亮，城市灯光 earth_night.jpg 只在黑夜面发光。在 StandardMaterial 里自发光夜面贴图会渗到
     白天面——在 4.0.3 里你如何干净地解决（自定义 ShaderMaterial？fresnel？emissiveFresnelParameters？
     便宜的分界线技巧？）。给出着色器/材质代码。
   - 地球边缘一圈微妙的**大气辉光**（蓝色 fresnel），这是让它「成立」的细节。
   - 远处一颗月亮，光照方向与地球、竞技场一致。
   - 确切的位置/尺度，让它在双塔背后成景，不穿帮、不裁掉 ±64 的战斗区，也不超过 maxZ 2000，从约
     1.8 米高的玩家相机看过去效果最好。

2. 与之匹配的灯光/氛围：太阳应该是同一颗照亮地球、塔和玩家的恒星（方向一致）。哪些环境光/地面反射色
   + 色调映射/曝光的改动，能让太空场景读起来清爽（漆黑虚空、边缘高光的金属），而不是现在这种浑浊黄昏？
   地球要不要给平台底部投一点柔和的补光（反弹光）？怎样做才便宜？

3. Bloom：我们现在只对 FX 精灵做 bloom。星空 / 地球边缘 / 套件自发光条要不要也 bloom？如何扩展
   GlowLayer 或加一个便宜的阈值 bloom，而不炸掉移动端预算、不把 HUD 冲淡？

4. 双塔剪影：只用那 8 个套件部件，你会怎么让塔读起来是标志性的、威严的、分队色（红 vs 蓝）的地标，
   衬在地球前面？给每个部件具体的贴图/材质/自发光点子。

5. 还有什么能让人第一次出生进场就「卧槽」的？以及移动端性能上要**避免**什么？请按「性价比（影响/工作量）」
   给你的建议排序。

请具体、给代码、基于我们真实的文件推理。
${bundle}
`

const reqBody = {
  model: 'moonshotai/kimi-k3',
  messages: [
    { role: 'system', content: PERSONA },
    { role: 'user', content: BRIEF },
  ],
  temperature: 0.7,
  max_tokens: 16384,
}

try {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  })
  const json = await res.json()
  if (!res.ok) {
    console.error('HTTP', res.status, JSON.stringify(json, null, 2))
    process.exit(1)
  }
  const out = json.choices?.[0]?.message?.content
  if (!out) { console.error('EMPTY RESPONSE:', JSON.stringify(json, null, 2)); process.exit(2) }
  console.log(out)
} catch (e) {
  console.error('FETCH ERROR:', e && e.stack || String(e))
  process.exit(3)
}
