// Bake per-region UV masks from a hero GLB using vertex-group weights.
// Pure Node — no Blender, no PIL. Reads the GLB binary chunk, computes for each
// vertex the dominant bone (head/hand/foot/body), then rasterizes each triangle
// in UV space with per-vertex region colors, taking the largest bary weight
// per texel as the winning region.
//
//   node scripts/bake-hero-mask.mjs <hero.glb> <out_mask.png> [texW]
//
// Colors:  RED=head  BLUE=hands+fingers  YELLOW=feet+toes  GREEN=torso/arms/legs
//          BLACK=no coverage (transparent alpha)
import fs from "node:fs";
import zlib from "node:zlib";

const inPath = process.argv[2];
const outPath = process.argv[3];
const TEX_W = Number(process.argv[4] || 1024);
const TEX_H = TEX_W;
if (!inPath || !outPath) { console.error("usage: node scripts/bake-hero-mask.mjs <hero.glb> <out.png> [texW]"); process.exit(1); }

const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8;

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
  return out;
}

// find the body node/mesh (skinned mesh)
let bodyNodeIdx = -1;
json.nodes.forEach((n, ni) => { if (n.mesh != null && n.skin != null) bodyNodeIdx = ni; });
if (bodyNodeIdx < 0) throw new Error("no skinned mesh");
const bodyNode = json.nodes[bodyNodeIdx];
const mesh = json.meshes[bodyNode.mesh];
const skin = json.skins[bodyNode.skin];
const prim = mesh.primitives[0];
const uvs = readAccessor(prim.attributes.TEXCOORD_0);
const joints = readAccessor(prim.attributes.JOINTS_0);
const weights = readAccessor(prim.attributes.WEIGHTS_0);
const indices = readAccessor(prim.indices);
const jointNames = skin.joints.map((n) => (json.nodes[n] && json.nodes[n].name) || "j" + n);
console.log("body:", mesh.name, "verts:", uvs.length, "tris:", indices.length / 3);

// map joint index -> region code
const HEAD = /^(head|face|jaw|eye|tongue)/i; // NOTE: neck deliberately excluded so it paints as suit (helmet ring is small; naked-neck gap looks bad)
const HAND = /(hand|thumb|index|middle|ring|pinky|finger)/i;
const FOOT = /(foot|ball|toe)/i;
function regionForBone(name) {
  if (HEAD.test(name)) return "H";
  if (HAND.test(name)) return "N";
  if (FOOT.test(name)) return "F";
  return "B";
}
const jointRegion = jointNames.map(regionForBone);
console.log("region breakdown:",
  { H: jointRegion.filter((r) => r === "H").length,
    N: jointRegion.filter((r) => r === "N").length,
    F: jointRegion.filter((r) => r === "F").length,
    B: jointRegion.filter((r) => r === "B").length });

// per-vertex region: pick joint with largest weight
const vertRegion = new Array(uvs.length);
for (let i = 0; i < uvs.length; i++) {
  const j = joints[i], w = weights[i];
  let best = -1, bestIdx = 0;
  for (let k = 0; k < 4; k++) {
    if (w[k] > best) { best = w[k]; bestIdx = k; }
  }
  vertRegion[i] = jointRegion[j[bestIdx]];
}

// rasterize
// (r, g, b, a) for each region
const REG = { H: [255, 0, 0, 255], N: [0, 0, 255, 255], F: [255, 255, 0, 255], B: [0, 255, 0, 255] };
const px = Buffer.alloc(TEX_W * TEX_H * 4, 0);
function putPx(x, y, rgba) {
  const p = (y * TEX_W + x) * 4;
  px[p] = rgba[0]; px[p + 1] = rgba[1]; px[p + 2] = rgba[2]; px[p + 3] = rgba[3];
}

function raster(p0, p1, p2, r0, r1, r2) {
  const x0 = p0[0] * (TEX_W - 1), y0 = p0[1] * (TEX_H - 1);
  const x1 = p1[0] * (TEX_W - 1), y1 = p1[1] * (TEX_H - 1);
  const x2 = p2[0] * (TEX_W - 1), y2 = p2[1] * (TEX_H - 1);
  const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxx = Math.min(TEX_W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxy = Math.min(TEX_H - 1, Math.ceil(Math.max(y0, y1, y2)));
  const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (denom === 0) return;
  const c0 = REG[r0], c1 = REG[r1], c2 = REG[r2];
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denom;
      const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denom;
      const l2 = 1 - l0 - l1;
      if (l0 >= -0.001 && l1 >= -0.001 && l2 >= -0.001) {
        if (l0 >= l1 && l0 >= l2) putPx(x, y, c0);
        else if (l1 >= l2) putPx(x, y, c1);
        else putPx(x, y, c2);
      }
    }
  }
}

for (let ti = 0; ti < indices.length; ti += 3) {
  const a = indices[ti], b = indices[ti + 1], c = indices[ti + 2];
  raster(uvs[a], uvs[b], uvs[c], vertRegion[a], vertRegion[b], vertRegion[c]);
}
console.log("rasterized", indices.length / 3, "tris");

// dilate region-colored pixels slightly to close small seams (1-pixel dilation)
function dilate(times = 1) {
  for (let t = 0; t < times; t++) {
    const src = Buffer.from(px);
    for (let y = 1; y < TEX_H - 1; y++) {
      for (let x = 1; x < TEX_W - 1; x++) {
        const p = (y * TEX_W + x) * 4;
        if (src[p + 3] !== 0) continue; // already filled
        for (let dy = -1; dy <= 1 && px[p + 3] === 0; dy++) {
          for (let dx = -1; dx <= 1 && px[p + 3] === 0; dx++) {
            if (dx === 0 && dy === 0) continue;
            const q = ((y + dy) * TEX_W + (x + dx)) * 4;
            if (src[q + 3] !== 0) {
              px[p] = src[q]; px[p + 1] = src[q + 1]; px[p + 2] = src[q + 2]; px[p + 3] = 255;
            }
          }
        }
      }
    }
  }
}
dilate(2);

// write PNG (grayscale via crc32 + zlib deflate; here RGBA 8-bit)
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let x = n; for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1); t[n] = x >>> 0; }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // RGBA
  // scanlines: 1 filter byte (0) + w*4 bytes per row
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  const iend = Buffer.alloc(0);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", iend)]);
}

fs.writeFileSync(outPath, encodePNG(TEX_W, TEX_H, px));
console.log("wrote mask", outPath, TEX_W + "x" + TEX_H);
