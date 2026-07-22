import fs from 'fs'
const html = fs.readFileSync('upgrade/bundle-stats.html', 'utf8')
const marker = 'const data = '
const s = html.indexOf(marker) + marker.length
let depth = 0, i = s, instr = false, esc = false
for (; i < html.length; i++) {
  const c = html[i]
  if (instr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') instr = false; continue }
  if (c === '"') { instr = true; continue }
  if (c === '{') depth++
  else if (c === '}') { depth--; if (depth === 0) { i++; break } }
}
const data = JSON.parse(html.slice(s, i))
const parts = data.nodeParts || {}, meta = data.nodeMetas || {}
const cat = {}; let tot = 0
for (const uid in parts) {
  const len = parts[uid].renderedLength || 0; tot += len
  const mu = parts[uid].metaUid
  const id = (meta[mu] && meta[mu].id) || uid
  let key
  const mm = id.match(/@babylonjs\/(core|loaders)\/([A-Za-z0-9._]+)/)
  if (mm) key = mm[1] + '/' + mm[2]
  else if (id.includes('node_modules')) key = 'npm:' + id.split('node_modules/').pop().split('/').slice(0, 2).join('/')
  else key = 'app'
  cat[key] = (cat[key] || 0) + len
}
console.log('TOTAL rendered:', (tot / 1024).toFixed(0) + ' kB across ' + Object.keys(parts).length + ' parts')
const buckets = {}
for (const [k, v] of Object.entries(cat)) {
  let b
  if (/PBR|pbr/.test(k)) b = 'PBR materials'
  else if (/^loaders\//.test(k) || /glTF|gltf/i.test(k)) b = 'loaders (glTF/OBJ)'
  else if (/Shaders/i.test(k)) b = 'Shaders/GLSL'
  else if (/Material/i.test(k)) b = 'Materials (std/bg/img-proc)'
  else if (/Texture/i.test(k)) b = 'Textures'
  else if (/Mesh|Buffers|Geometr|csg|subMesh/i.test(k)) b = 'Meshes/Geometry'
  else if (/Engine/i.test(k)) b = 'Engine(s)'
  else if (/Maths/i.test(k)) b = 'Maths'
  else if (/Lights|Shadows/i.test(k)) b = 'Lights/Shadows'
  else if (/Animations/i.test(k)) b = 'Animations'
  else if (/Layers|glow/i.test(k)) b = 'Layers/Glow'
  else if (/Helpers|photo/i.test(k)) b = 'Helpers/PhotoDome'
  else if (/Cameras/i.test(k)) b = 'Cameras'
  else if (/Rendering|PostProcess|Culling|Collisions|Loading|Misc|Actions|Behaviors|Gizmos|Audio|Particles|Instrumentation|Compat|Bones|Physics|Morph|Sprites|Events|Offline|Debug|XR|node/i.test(k)) b = 'core/misc'
  else if (k === 'app') b = 'app (game code)'
  else if (k.startsWith('npm:')) b = k
  else b = 'core/other (' + k + ')'
  buckets[b] = (buckets[b] || 0) + v
}
for (const [b, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1]))
  console.log((v / 1024).toFixed(1).padStart(9) + ' kB  ' + b)
