// 用中文让 Kimi 给出「昼夜地球 + 大气边缘辉光」的可粘贴 Babylon.js 4.0.3 代码。范围收窄到只做这一件事，
// 并给 reasoning 设上限、把 max_tokens 拉高，逼它真正输出代码。
import { readFileSync } from 'node:fs'
const envRaw = readFileSync('/home/miltron/solSoccer/.env', 'utf8')
const key = envRaw.match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key')

const PERSONA = `你是世界顶级的实时图形 / 着色器技术美术，精通 Babylon.js 4.0.3、GLSL、ShaderMaterial /
Effect.ShadersStore、fresnel、大气散射近似。你只给可直接粘贴、能跑的代码，绝不空泛。用中文答，代码用英文。`

const BRIEF = `
Babylon.js 4.0.3（浏览器，桌面+移动端，快节奏射击，性能敏感）。我要给一个太空竞技场做「昼夜地球」的英雄画面。

现状（StandardMaterial，昼夜灯光会渗到白天面，且没有真正的日夜分界线，也没有大气辉光）：
\`\`\`js
const earth = BABYLON.MeshBuilder.CreateSphere('earth', { diameter: 1200, segments: 64 }, scene)
earth.position.set(-360, -320, 820); earth.applyFog = false
const earthMat = new BABYLON.StandardMaterial('earthMat', scene)
earthMat.diffuseTexture  = new BABYLON.Texture('/assets/space/earth_day.jpg', scene)     // 真实卫星昼图
earthMat.specularTexture = new BABYLON.Texture('/assets/space/earth_spec.jpg', scene)     // 海洋高光遮罩
earthMat.emissiveTexture = new BABYLON.Texture('/assets/space/earth_lights.png', scene)   // 夜面城市灯
earth.material = earthMat
\`\`\`
场景里唯一的太阳是 DirectionalLight，direction = (-0.55, -0.85, 0.35)（已归一化前的方向）。相机 minZ 0.05
maxZ 2000，已有 imageProcessing 色调映射（STANDARD）+ 对比度 1.35 + 曝光 1.05（注意：ShaderMaterial 不会
自动套用 scene 的 imageProcessing，你的输出要么自带简单色调/gamma，要么调好常数）。已有一个只作用于 FX 的
GlowLayer。贴图：earth_day.jpg、earth_night(=earth_lights).png、earth_spec.jpg（海洋高光遮罩），都可采样。

请给出**完整、可直接粘贴**的代码，做到：

1. 一个自定义 **ShaderMaterial**（含 BABYLON.Effect.ShadersStore 的 vertex + fragment GLSL）替换上面的地球材质：
   - 用 N·L（法线点乘太阳方向）驱动**真正的日夜分界线**：lit 侧显示 earth_day，dark 侧显示 earth_lights 城市灯，
     terminator 处用 smoothstep 平滑过渡（给出建议的过渡宽度）。城市灯**只在夜面**亮，别渗到白天。
   - 海洋高光：用 earth_spec 遮罩做一个朝太阳的高光（Blinn 或简单 specular），只在海洋、只在昼面。
   - 需要的 uniforms（world、worldViewProjection、sunDirection、cameraPosition）与 attributes（position、normal、uv）
     都写清楚，并给出**如何在 JS 里每帧或一次性设置 sunDirection**（和上面的 DirectionalLight 方向保持一致，注意方向
     是「光的传播方向」，N·L 要用「指向太阳」的向量，即取负）。

2. 一个独立的**大气边缘辉光**（atmosphere rim）：在地球外再套一个略大的球（比如 ×1.03），用 fresnel（朝边缘越强）
   输出蓝色辉光，**加色混合 / 背面**，不受场景灯影响。给出这个壳的 ShaderMaterial（或用 StandardMaterial +
   emissiveFresnelParameters/opacityFresnelParameters 的等效便宜写法，二选一并说明取舍），以及正确的 alpha/深度设置
   （别遮住星空、别被雾影响、别写深度导致排序问题）。

3. 性能与移动端注意事项（贴图分辨率、球体细分、shader 复杂度），以及如果要让地球边缘/城市灯参与一点 bloom，
   如何安全接入现有 GlowLayer。

只做这个地球+大气，别扩展到别的。给完整代码块，基于上面的现状推理。
`

const reqBody = {
  model: 'moonshotai/kimi-k3',
  messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: BRIEF }],
  temperature: 0.4,
  max_tokens: 32000,
  reasoning: { max_tokens: 10000 },
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
