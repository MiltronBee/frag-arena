// 中文版聚焦审查：把 Frag Arena 第一人称"手部模型（viewmodel）+ 枪"的相关代码交给
// Kimi K3（moonshotai/kimi-k3，经 OpenRouter），诊断两件事：
//   1) 换弹（reload）时手臂显示为"被砍断/断臂"的根因；
//   2) 能否把科幻枪模型装到同一套手臂上（可行性 + 具体流程）。
//
// 代码以内联方式给出（不依赖行号切片）。所有标识符/属性名/代码保持原样；分析用中文。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/miltron/unreal'
const OUT = `${ROOT}/_work/ui/kimi-viewmodel-review-cn.md`
const key = readFileSync('/home/miltron/solSoccer/.env', 'utf8').match(/^openrouter=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error('no openrouter= key in ~/solSoccer/.env')

const PERSONA = `你是一位世界级的实时图形与游戏引擎工程师——精通 Babylon.js/WebGL、glTF/GLB 资产管线、骨骼动画（skinning / animation groups）、Blender→glTF 导出、IK 绑定与烘焙、以及第一人称射击的手部模型（viewmodel）系统。你能流畅阅读 JS 客户端渲染代码与 Blender Python 导出脚本，并据此推理"运行时看到的画面"为何是那样。

项目背景：Frag Arena 是一款网页端竞技 FPS（Babylon.js）。第一人称手臂+枪是一个 GLB：手臂骨架的 hand-IK 在 Blender 中被约束到枪的 Main 骨，导出时逐帧烘焙，所以运行时手会自动"跟住"枪。当前 4 把枪各自导出一个"手臂+枪"GLB。另有一套"科幻枪"模型（Quaternius，单位为米、无骨架、目前只用于第三人称）。

要求：直接、具体、可落地。每个结论都要落到给出的具体代码/字段/流程上。给出可执行的修复步骤或参数改动。不要泛泛而谈，不要"或许可以考虑"。所有代码/标识符保持英文原样并放代码块；分析说明用中文。`

// ---- 内联代码上下文 -------------------------------------------------------
const CTX_VM = `// client/graphics/Viewmodel.js — 加载 GLB、裁剪、接线动画、reload() 状态机
// holder 挂在相机下；GLB 的 meshes 全部 layerMask=0x10000000（专用相机 vmCamera 只渲染这一层）
const root = result.meshes[0]
this.holder = new BABYLON.TransformNode('viewmodel', this.scene)
this.holder.parent = this.camera
this.holder.scaling.setAll(this.spec.scale)   // spec.scale = 0.01
root.parent = this.holder
result.meshes.forEach((m) => {
  m.alwaysSelectAsActiveMesh = true            // 永不剔除
  m.layerMask = 0x10000000
})
// 动画组按名字接线；idle 用 enableBlending 从上一 clip 末帧混合回来
this.idleAnim   = this.groups[anims.idle]
this.fireAnim   = this.groups[anims.fire]     // 必须整段无过滤播放（IK 已在导出烘焙）
this.reloadAnim = this.groups[anims.reload]
this.drawAnim   = this.groups[anims.draw]

// —— reload()：把 idle/fire 停掉，整段播放一次 reload clip，结束回 idle ——
reload() {
  if (this._state === S.RELOADING || this._state === S.DRAWING || !this.reloadAnim) return false
  const gen = ++this._gen
  this._setState(S.RELOADING)
  if (this.idleAnim) this.idleAnim.stop()
  if (this.fireAnim) this.fireAnim.stop()
  this.reloadAnim.stop()
  this._onEndOnce(this.reloadAnim, gen, () => { this._setState(S.IDLE); if (this._wantActive) this._startIdleLoop() })
  const normalDuration = this.reloadAnim.to - this.reloadAnim.from
  const speedRatio = normalDuration / (this.spec.reloadTime || 1.5)  // 拉伸/压缩到 gameplay reloadTime
  this.reloadAnim.start(false, speedRatio)
  return true
}
// 说明：reload 期间没有任何隐藏/剔除/detach mesh 的代码；两条手臂全程 enabled 且挂在 holder 上。`

const CTX_TRIM = `# scripts/blend-to-gltf.blender.py — 导出前把"肩/上臂"顶点删掉，避免 FP 相机穿进网格内部
_cut = ('shoulder', 'upperarm')
_cut_idx = {vg.index for vg in arms_mesh.vertex_groups if any(k in vg.name.lower() for k in _cut)}
if _cut_idx:
    bm = bmesh.new(); bm.from_mesh(arms_mesh.data)
    dl = bm.verts.layers.deform.active
    # 删掉"主权重落在 shoulder/upperarm 组"的所有顶点
    doomed = [v for v in bm.verts if len(v[dl]) and max(v[dl].items(), key=lambda kv: kv[1])[0] in _cut_idx]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(arms_mesh.data); bm.free()

# 导出参数：export_apply=True 才会应用 Mirror 修改器（否则只导出单臂——这是历史上的"单臂"bug，现已修复）
bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB',
    export_animations=True, export_animation_mode='NLA_TRACKS',
    export_yup=True, use_selection=False, export_apply=True)`

const CTX_RELOAD_NOTE = `// scripts/retro-blend-actions.json 的关键说明（换弹相关）：
// attachment: "手臂 hand-IK（ctrl_HandIK_l/r + pole targets）被约束到枪的 Main 骨。
//   换弹时左手（支撑手）离开握把去压子弹——这种【左手滑移是刻意的】。"
// Rifle.reload = { arms:"Arms_Reload", gun:["Rifle_Reload"] }  // 手臂动作 + 枪动作叠在同名 NLA 轨，导出合并
// requiredNodes: ["Arms_Armature","FPS_Arms_Mesh","hand_l","hand_r","Main"]`

const CTX_GUNS = `// common/weaponsConfig.js — 第一人称：每把枪一个"手臂+枪"GLB（retro 像素风），authoredMount.scale = 0.01
weapons[0] Rifle  -> /assets/weapons/retro_rifle_arms.glb   (reloadTime 1.5)
weapons[1] SMG    -> /assets/weapons/retro_smg_arms.glb     (reloadTime 1.2)
weapons[2] Shotgun-> /assets/weapons/retro_shotgun_arms.glb (reloadTime 2.2)
weapons[3] Pistol -> /assets/weapons/retro_pistol_arms.glb  (reloadTime 1.0)
anims: { idle:'idle', fire:'fire', reload:'reload', draw:'draw' }

// 可用的"科幻枪"资产（目前只用于第三人称 tpWeapons）：
//   /assets/weapons/Gun_Rifle.gltf / Gun_SMG.gltf / Gun_Shotgun.gltf / Gun_Pistol.gltf  (Quaternius, 单位=米, 无骨架/无动画, 纯静态 prop)
//   /assets/weapons/blaster.glb (60KB, 科幻 plasma prop), blaster-repeater.glb
// assetManifest.js 注释：Quaternius 科幻枪是"米"为单位，不是 cm，所以 0.010 的 per-cm scale 不再适用。

// 第一人称枪是如何"装"到手上的（结构性、非运行时挂点）：
// blend-to-gltf.blender.py：把科幻/新枪 mesh 的 Armature 修改器重指向 gun_arm，parent 到 gun_arm；
// 手臂 hand-IK 约束到枪 Main 骨，逐帧烘焙 -> 运行时手自动跟住枪。换枪 = 在 Blender 里用【同一套手臂 rig】
// 重新绑定 + 重新导出 GLB，再改 weaponsConfig 的 url。`

const BITS = [
  { t: '换弹时"断臂/手臂被砍断"根因诊断',
    ctx: `${CTX_VM}\n\n${CTX_TRIM}\n\n${CTX_RELOAD_NOTE}`,
    q: `症状：第一人称游戏中，平时（idle/开火）手臂看起来正常，但一进入【换弹 reload】动画，就能看到手臂像"被砍断/断臂"——手臂上端是一个突兀的开口/断面，尤其是左手（支撑手）离开握把去压弹的那一段。

请据代码推断根因并按可能性排序。我的首要怀疑：blend-to-gltf 导出前把 shoulder/upperarm 的顶点整段删除了（为了让相机不穿进网格），于是手臂上端本来就是一个开放的断面；idle/fire 时这个断面在画面外或朝后看不见，但 reload 的姿势把支撑臂往下/往内拉、把那个"断口"转进了视野。

请：
1) 判断这个"顶点裁剪 → 换弹时断口入镜"的假设是否成立，还有没有别的可能（比如 Mirror 只镜像了 mesh 没镜像权重组、reload clip 把手臂拉出 FOV 边缘、near clip 把上臂裁掉、单臂 GLB 未重导等）。
2) 给出【最高性价比】的修复：是改导出脚本（例如不整段删顶点，而是在断口封一个 cap / 只删相机真正会穿模的那几圈 / 用 near-plane + 收紧 reload 姿势），还是改 reload 动画的取景，还是运行时处理。给出具体做法与取舍。
3) 如果要在 Blender 侧封口，说明用 bmesh 怎么在删完顶点后给开口补面（cap holes）而不破坏 skinning。`
  },
  { t: '把科幻枪装到现有第一人称手臂上：可行性 + 流程',
    ctx: CTX_GUNS,
    q: `目标：想把现有的"科幻枪"外观（Quaternius Gun_Rifle.gltf 等，单位=米、无骨架、纯静态 prop；或 blaster.glb）用在第一人称手臂上，替换掉现在的 retro 像素风枪，同时【保留】手臂的换弹/开火/待机动画和握持（hand-IK 已烘焙到手臂动画里）。

请给出可落地的方案：
1) 现有第一人称是"手臂+枪"烘焙在一个 GLB 里、手 IK 跟随枪 Main 骨。要换成科幻枪，最干净的做法是什么？（A：在 Blender 里把科幻枪 mesh 绑到同一套 gun rig 的 Main 骨、复用现有 arms 动作重新导出；B：运行时把科幻枪作为独立 mesh 挂到手骨/枪节点上，丢弃烘焙 IK 只对齐一个握持变换；各自的代价与画质/手感差异）。
2) 单位问题：科幻枪是"米"、retro 管线是 scale 0.01（cm）。在把科幻枪塞进管线时，缩放/对齐（枪口 muzzle、握把位置、Main 骨对齐）具体要怎么处理，才能让手不脱离握把、枪口 muzzle socket 对得上？
3) 如果走运行时挂载（不重导 Blender），在 Babylon.js 里具体怎么做：把科幻枪 mesh parent 到 viewmodel 的哪个节点、如何用一次性的对齐变换让它贴合手，换弹时左手离开握把会不会穿模，怎么权衡。给出最小可行步骤。`
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(bit, n) {
  const body = {
    model: 'moonshotai/kimi-k3',
    messages: [
      { role: 'system', content: PERSONA },
      { role: 'user', content: `聚焦 (${n}/${BITS.length})：${bit.t}\n\n${bit.q}\n\n相关代码/上下文：\n\`\`\`\n${bit.ctx}\n\`\`\`` },
    ],
    temperature: 0.4,
    // code-heavy diagnostic Qs: reasoning alone can approach 8k, so give extra
    // headroom (12k) or the answer comes back content:null (empty-body storm).
    max_tokens: 12000,
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
          'X-Title': 'Frag Arena viewmodel review (zh)',
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

writeFileSync(OUT, `# Frag Arena — Kimi K3 手部模型/换弹/科幻枪 诊断（中文）\n\n`)
for (let i = 0; i < BITS.length; i++) {
  const n = i + 1
  process.stderr.write(`\n[${n}/${BITS.length}] ${BITS[i].t} …\n`)
  const ans = await ask(BITS[i], n)
  const block = `\n## ${n}. ${BITS[i].t}\n\n${ans}\n`
  appendFileSync(OUT, block)
  process.stdout.write(block)
  await sleep(1500)
}
process.stderr.write(`\nDONE -> ${OUT}\n`)
