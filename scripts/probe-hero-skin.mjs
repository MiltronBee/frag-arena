// Introspect the hero GLB skinning + mesh data.
// Extracts:
//   - node names (so we can identify head/hand/foot joints)
//   - skin joints (indexed list of node indices)
//   - body mesh vertex data (POSITION, TEXCOORD_0, JOINTS_0, WEIGHTS_0, indices)
// Writes a JSON summary to <name>.skin.json alongside the GLB.
import fs from "node:fs";

const inPath = process.argv[2];
if (!inPath) { console.error("usage"); process.exit(1); }
const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
const binHeaderStart = 20 + jsonLen;
const binLen = buf.readUInt32LE(binHeaderStart);
const binStart = binHeaderStart + 8;

function bvSlice(bvIdx) {
  const bv = json.bufferViews[bvIdx];
  const off = binStart + (bv.byteOffset || 0);
  return { buf, off, len: bv.byteLength, stride: bv.byteStride || 0 };
}

function readAccessor(accIdx) {
  const a = json.accessors[accIdx];
  const bv = json.bufferViews[a.bufferView];
  const base = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
  const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const stride = bv.byteStride || compSize * compCount;
  const out = new Array(a.count);
  for (let i = 0; i < a.count; i++) {
    const off = base + i * stride;
    const row = new Array(compCount);
    for (let c = 0; c < compCount; c++) {
      const p = off + c * compSize;
      switch (a.componentType) {
        case 5120: row[c] = buf.readInt8(p); break;
        case 5121: row[c] = buf.readUInt8(p); break;
        case 5122: row[c] = buf.readInt16LE(p); break;
        case 5123: row[c] = buf.readUInt16LE(p); break;
        case 5125: row[c] = buf.readUInt32LE(p); break;
        case 5126: row[c] = buf.readFloatLE(p); break;
      }
    }
    out[i] = compCount === 1 ? row[0] : row;
  }
  return { data: out, type: a.type, componentType: a.componentType, count: a.count };
}

// find the body mesh: the one attached to the skinned node
// walk scene nodes, find the one with mesh + skin (that is the body)
let bodyNodeIdx = -1;
(json.nodes || []).forEach((n, ni) => {
  if (n.mesh != null && n.skin != null) bodyNodeIdx = ni;
});
if (bodyNodeIdx < 0) {
  // pick node whose mesh has the largest primitive
  let best = { count: -1, ni: -1 };
  (json.nodes || []).forEach((n, ni) => {
    if (n.mesh == null) return;
    const m = json.meshes[n.mesh];
    const p = m.primitives[0];
    const acc = json.accessors[p.attributes.POSITION];
    if (acc && acc.count > best.count) best = { count: acc.count, ni };
  });
  bodyNodeIdx = best.ni;
}
const bodyNode = json.nodes[bodyNodeIdx];
const mesh = json.meshes[bodyNode.mesh];
const skinIdx = bodyNode.skin;
const skin = json.skins[skinIdx];
console.log("body node:", bodyNodeIdx, bodyNode.name, "mesh:", bodyNode.mesh, mesh.name,
  "skin:", skinIdx, "joints:", skin.joints.length);

const prim = mesh.primitives[0];
const positions = readAccessor(prim.attributes.POSITION);
const uvs = readAccessor(prim.attributes.TEXCOORD_0);
const joints = readAccessor(prim.attributes.JOINTS_0);
const weights = readAccessor(prim.attributes.WEIGHTS_0);
const indices = prim.indices != null ? readAccessor(prim.indices) : null;

const jointNames = skin.joints.map((n) => (json.nodes[n] && json.nodes[n].name) || ("joint_" + n));
console.log("vertex count:", positions.count, "  index count:", indices ? indices.count : "n/a");
console.log("joint names sample:", jointNames.slice(0, 20).join(", "), "...");

const summary = {
  path: inPath,
  bodyNodeIdx,
  meshName: mesh.name,
  skinJoints: jointNames,
  vertexCount: positions.count,
  indexCount: indices ? indices.count : null,
};
const outPath = inPath.replace(/\.glb$/, ".skin.json");
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log("wrote", outPath);
