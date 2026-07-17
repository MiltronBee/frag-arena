// Extract a PNG image from a GLB by its 0-based image index.
//   node scripts/extract-glb-image.mjs <hero.glb> <imgIndex> <out.png>
import fs from "node:fs";
const [,, inPath, idxStr, outPath] = process.argv;
if (!inPath || idxStr == null || !outPath) { console.error("usage"); process.exit(1); }
const idx = Number(idxStr);
const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8; // skip BIN chunk header (8 bytes)
const img = json.images[idx];
const bv = json.bufferViews[img.bufferView];
const start = binStart + (bv.byteOffset || 0);
const end = start + bv.byteLength;
fs.writeFileSync(outPath, buf.slice(start, end));
console.log("wrote", outPath, bv.byteLength, "bytes  (image", idx, img.name, img.mimeType + ")");
