// Probe hero_*.glb layout for repaint planning.
//   node scripts/probe-hero.mjs public/assets/characters/hero_male.glb
// Prints summary + writes <same>.probe.json alongside.
import fs from "node:fs";

const inPath = process.argv[2];
if (!inPath) { console.error("usage: node scripts/probe-hero.mjs <hero.glb>"); process.exit(1); }
const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
const total = buf.readUInt32LE(8);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
const bvs = json.bufferViews || [];
const images = json.images || [];
const materials = json.materials || [];
const meshes = json.meshes || [];
const anims = json.animations || [];

const imgInfo = images.map((img, i) => {
  const bv = bvs[img.bufferView];
  return { i, name: img.name || "img_" + i, mime: img.mimeType,
    bufferView: img.bufferView, byteOffset: bv.byteOffset || 0,
    byteLength: bv.byteLength, buffer: bv.buffer };
});

const imgUsers = imgInfo.map(() => []);
materials.forEach((m, mi) => {
  const push = (t, tag) => {
    if (!t) return;
    const tex = json.textures[t.index];
    const src = tex && tex.source;
    if (src != null && imgUsers[src]) imgUsers[src].push(mi + ":" + (m.name || "unnamed") + "(" + tag + ")");
  };
  const pbr = m.pbrMetallicRoughness || {};
  push(pbr.baseColorTexture, "base");
  push(pbr.metallicRoughnessTexture, "mr");
  push(m.normalTexture, "nrm");
  push(m.occlusionTexture, "occ");
  push(m.emissiveTexture, "emi");
});

console.log("=== GLB", inPath);
console.log("total=", total, " jsonLen=", jsonLen);
console.log("images=", images.length, " materials=", materials.length, " meshes=", meshes.length, " anims=", anims.length);
imgInfo.forEach((im) => {
  console.log("  img #" + im.i, im.name.padEnd(34), im.mime, im.byteLength, "@ off " + im.byteOffset, " bv#" + im.bufferView);
  console.log("       used-by:", imgUsers[im.i].join(", ") || "(none)");
});
materials.forEach((m, i) => {
  const t = m.pbrMetallicRoughness || {};
  const tex = t.baseColorTexture ? json.textures[t.baseColorTexture.index] : null;
  const srcIdx = tex ? tex.source : null;
  const srcName = srcIdx != null ? (images[srcIdx].name || "img_" + srcIdx) : "-";
  console.log("  mat #" + i, (m.name || "unnamed").padEnd(34), "baseColor img #" + srcIdx + "=" + srcName);
});
meshes.forEach((m, mi) => {
  console.log("  mesh #" + mi, m.name);
  m.primitives.forEach((p, pi) => {
    const mat = materials[p.material];
    console.log("     prim", pi, "-> mat #" + p.material, "(" + (mat && mat.name) + ")");
  });
});
console.log("anims count=" + anims.length);
if (anims[0]) console.log("  [0]", anims[0].name);
if (anims.length > 1) console.log("  [" + (anims.length - 1) + "]", anims[anims.length - 1].name);

const outJson = inPath.replace(/\.glb$/, ".probe.json");
fs.writeFileSync(outJson, JSON.stringify({
  path: inPath, total, jsonLen, images: imgInfo, imgUsers,
  materials: materials.map((m, i) => ({ i, name: m.name,
    baseColorSource: (m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture)
      ? json.textures[m.pbrMetallicRoughness.baseColorTexture.index].source : null })),
  meshes: meshes.map((m, mi) => ({ i: mi, name: m.name,
    prims: m.primitives.map((p, pi) => ({ pi, material: p.material })) })),
  animations: anims.map((a) => a.name),
}, null, 2));
console.log("wrote", outJson);
