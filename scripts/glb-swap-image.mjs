// Replace one image inside a GLB by swapping its bufferView bytes.
// Handles the (very common) case where the new PNG has a DIFFERENT byte length —
// re-serializes the JSON, adjusts subsequent bufferView byteOffsets, updates the
// buffer byteLength, and rewrites the chunk headers + total file length.
//
//   node scripts/glb-swap-image.mjs <in.glb> <imgIndex> <replacement.png> <out.glb>
//
// Does NOT touch the mesh/skin/animation JSON — so all 120 animation clips + rig
// survive. Safe for our hero repaint (image is a leaf bufferView with a single
// user: the material baseColor texture).
import fs from "node:fs";

const [,, inPath, idxStr, pngPath, outPath] = process.argv;
if (!inPath || idxStr == null || !pngPath || !outPath) {
  console.error("usage: node scripts/glb-swap-image.mjs <in.glb> <imgIndex> <new.png> <out.glb>");
  process.exit(1);
}
const idx = Number(idxStr);
const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error("first chunk not JSON");

const binHeaderStart = 20 + jsonLen;
const binLen = buf.readUInt32LE(binHeaderStart);
if (buf.readUInt32LE(binHeaderStart + 4) !== 0x004e4942) throw new Error("second chunk not BIN");
const binStart = binHeaderStart + 8;
const binOld = buf.slice(binStart, binStart + binLen);

const img = json.images[idx];
if (!img) throw new Error("no image #" + idx);
const targetBv = img.bufferView;
const targetBvObj = json.bufferViews[targetBv];
const oldOffset = targetBvObj.byteOffset || 0;
const oldLen = targetBvObj.byteLength;
console.log("swapping image #" + idx, img.name, "at bv#" + targetBv,
  "old bytes:", oldLen, "@" + oldOffset);

const newImg = fs.readFileSync(pngPath);
console.log("new PNG bytes:", newImg.length);

// Rebuild the BIN chunk: same layout, but the target bv is a different length,
// so all subsequent bvs need their byteOffsets adjusted by (newLen - oldLen).
const delta = newImg.length - oldLen;
console.log("delta:", delta);

// Sort bvs by byteOffset so we can rebuild the chunk in order (this preserves
// their relative packing without gaps). Some GLBs pad bvs to 4-byte boundaries;
// we honor the same padding scheme by aligning each bv start to a 4-byte boundary
// within the new buffer.
const bvOrder = json.bufferViews.map((bv, i) => ({ i, off: bv.byteOffset || 0 }))
  .sort((a, b) => a.off - b.off);

// build new BIN chunk piece by piece
const pieces = [];
let cursor = 0;
for (const { i } of bvOrder) {
  const bv = json.bufferViews[i];
  // pad to 4-byte boundary (glTF requires this for accessors of certain types
  // but is safe for all)
  const align = (4 - (cursor % 4)) % 4;
  if (align) { pieces.push(Buffer.alloc(align, 0)); cursor += align; }
  bv.byteOffset = cursor;
  if (i === targetBv) {
    pieces.push(newImg);
    bv.byteLength = newImg.length;
    cursor += newImg.length;
  } else {
    const src = binOld.slice(bv.byteOffset != null ? undefined : 0);
    // Note: we already overwrote bv.byteOffset above. Use the ORIGINAL byte offset.
    const origOff = bvOrder.find((o) => o.i === i).off;
    pieces.push(binOld.slice(origOff, origOff + bv.byteLength));
    cursor += bv.byteLength;
  }
}
// pad BIN chunk to 4-byte boundary (with 0x00 per spec)
{
  const align = (4 - (cursor % 4)) % 4;
  if (align) { pieces.push(Buffer.alloc(align, 0)); cursor += align; }
}
const newBin = Buffer.concat(pieces);

// update buffer[0] byteLength
if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = newBin.length;

// re-serialize JSON, pad to 4-byte with spaces (0x20)
let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

// assemble the new GLB
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
const newTotal = 12 + 8 + jsonBytes.length + 8 + newBin.length;
header.writeUInt32LE(newTotal, 8);

const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(jsonBytes.length, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4); // JSON

const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(newBin.length, 0);
binHead.writeUInt32LE(0x004e4942, 4); // BIN

fs.writeFileSync(outPath, Buffer.concat([header, jsonHead, jsonBytes, binHead, newBin]));
console.log("wrote", outPath, newTotal, "bytes (was", buf.length + ")");
