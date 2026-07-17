// Strip a trailing suffix from every animation name in a GLB, in place.
//
// Blender 4.2's glTF exporter (ACTIONS + NLA strips) names each exported
// animation `<action>_<armatureObjectName>`, so build-hero-character produces
// clips like `Idle_Loop_Armature`. This rewrites the GLB's JSON chunk to drop
// that suffix, giving clean clip names (`Idle_Loop`) for the asset manifest.
//
//   node scripts/glb-rename-clips.mjs <in.glb> [out.glb] [suffixRegex]
//
// Default suffix: /_Armature(\.\d+)?$/. out defaults to in (overwrite).
import fs from 'fs'

const [, , inPath, outArg, suffixArg] = process.argv
if (!inPath) {
  console.error('usage: node scripts/glb-rename-clips.mjs <in.glb> [out.glb] [suffixRegex]')
  process.exit(1)
}
const outPath = outArg || inPath
const suffix = suffixArg ? new RegExp(suffixArg) : /_Armature(\.\d+)?$/

const buf = fs.readFileSync(inPath)
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)')
const total = buf.readUInt32LE(8)

// chunk 0 = JSON
const jsonLen = buf.readUInt32LE(12)
const jsonType = buf.readUInt32LE(16)
if (jsonType !== 0x4e4f534a) throw new Error('first chunk is not JSON')
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))

let renamed = 0
;(json.animations || []).forEach((a) => {
  if (a.name && suffix.test(a.name)) { a.name = a.name.replace(suffix, ''); renamed++ }
})

// remaining bytes after the JSON chunk = the BIN chunk(s), copied verbatim
const binStart = 20 + jsonLen
const binChunk = buf.slice(binStart, total)

// re-serialize JSON, pad to 4-byte boundary with spaces (0x20) per glTF spec
let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
const pad = (4 - (jsonBytes.length % 4)) % 4
if (pad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)])

const newTotal = 12 + 8 + jsonBytes.length + binChunk.length
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0)     // magic 'glTF'
header.writeUInt32LE(2, 4)              // version
header.writeUInt32LE(newTotal, 8)
const jsonHeader = Buffer.alloc(8)
jsonHeader.writeUInt32LE(jsonBytes.length, 0)
jsonHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'

fs.writeFileSync(outPath, Buffer.concat([header, jsonHeader, jsonBytes, binChunk]))
console.log(`renamed ${renamed} clips; wrote ${outPath} (${newTotal} bytes)`)
