// Compose tactical-suit repaint from original body PNG + region mask PNG.
//   node scripts/paint-hero-suit.mjs <orig.png> <mask.png> <out.png>
// Rules:
//   RED   (head/face) -> keep original skin
//   BLUE  (hands)     -> keep original skin
//   GREEN (torso/arms/legs) -> paint charcoal tactical suit (#2a2d33 base)
//   YELLOW (feet/toes)      -> paint dark boot (#141518 base)
//   BLACK/none              -> keep original (behind-atlas padding)
//
// Uses skin-mask DILATION before painting so 1-2 texel bleed at UV edges cannot
// stain face/hands. Suit gets low-freq noise + darker vertical seams so it does
// not look like flat plastic; boot is uniform matte black. All-diffuse (arena
// has no IBL). Uses pure Node — zlib for PNG codec.
import fs from "node:fs";
import zlib from "node:zlib";

const [,, origPath, maskPath, outPath] = process.argv;
if (!origPath || !maskPath || !outPath) {
  console.error("usage: node scripts/paint-hero-suit.mjs <orig.png> <mask.png> <out.png>");
  process.exit(1);
}

// ---------- PNG codec (RGBA / RGB 8-bit) ----------
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let x = n; for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1); t[n] = x >>> 0; }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
function encPNGChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}
function encodePNG_RGBA(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, encPNGChunk("IHDR", ihdr), encPNGChunk("IDAT", idat), encPNGChunk("IEND", Buffer.alloc(0))]);
}
// Minimal PNG decoder: 8-bit RGB or RGBA, filter type 0-4 supported.
function decodePNG(buf) {
  if (buf[0] !== 137 || buf[1] !== 80) throw new Error("not PNG");
  let p = 8; let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idats = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.slice(p, p + 4).toString("ascii"); p += 4;
    const data = buf.slice(p, p + len); p += len;
    p += 4; // CRC
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8) throw new Error("only 8-bit PNGs supported (got " + bitDepth + ")");
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!chans) throw new Error("unsupported colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  // unfilter scanlines
  const stride = w * chans;
  const out = Buffer.alloc(h * stride);
  const prevRow = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= chans ? dst[x - chans] : 0;
      const up = prevRow[x];
      const ul = x >= chans ? prevRow[x - chans] : 0;
      let val;
      switch (filter) {
        case 0: val = src[x]; break;
        case 1: val = (src[x] + left) & 0xff; break;
        case 2: val = (src[x] + up) & 0xff; break;
        case 3: val = (src[x] + ((left + up) >> 1)) & 0xff; break;
        case 4: { // Paeth
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul);
          val = (src[x] + pred) & 0xff; break;
        }
        default: throw new Error("bad filter " + filter);
      }
      dst[x] = val;
    }
    dst.copy(prevRow);
  }
  return { w, h, chans, data: out };
}

// deterministic hash noise for surface texture
function noise(x, y, seed = 1) {
  let n = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  n = (n ^ (n >>> 13)) * 1274126177 >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// ---------- Load original PNG + mask ----------
const orig = decodePNG(fs.readFileSync(origPath));
const mask = decodePNG(fs.readFileSync(maskPath));
if (orig.w !== mask.w || orig.h !== mask.h) {
  console.error("orig", orig.w, "x", orig.h, "mask", mask.w, "x", mask.h);
  // resize mask if not matching — for now just error out (should be same size)
  throw new Error("size mismatch — bake mask at the same size as the body texture");
}
const W = orig.w, H = orig.h;
console.log("orig channels:", orig.chans, "mask channels:", mask.chans, W + "x" + H);

// Build a "protect as skin" mask (RED or BLUE in mask) as a boolean array,
// then dilate outward to guard against 1-2 texel seam bleed.
const skinProtect = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const p = i * mask.chans;
  const r = mask.data[p], g = mask.data[p + 1], b = mask.data[p + 2];
  const a = mask.chans === 4 ? mask.data[p + 3] : 255;
  // RED = head, BLUE = hands  (both to be preserved as skin)
  if (a > 0 && ((r > 200 && g < 60 && b < 60) || (b > 200 && r < 60 && g < 60))) {
    skinProtect[i] = 1;
  }
}
function dilate(mask, W, H, times) {
  for (let t = 0; t < times; t++) {
    const src = mask.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (src[p]) continue;
        if (src[p - 1] || src[p + 1] || src[p - W] || src[p + W] ||
            src[p - W - 1] || src[p - W + 1] || src[p + W - 1] || src[p + W + 1]) {
          mask[p] = 1;
        }
      }
    }
  }
}
dilate(skinProtect, W, H, 3);

// Build boot mask (YELLOW). No need to dilate — boot texture bleed on adjacent
// suit is fine; also do NOT dilate over the skin-protect area.
const bootMask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const p = i * mask.chans;
  const r = mask.data[p], g = mask.data[p + 1], b = mask.data[p + 2];
  const a = mask.chans === 4 ? mask.data[p + 3] : 255;
  if (a > 0 && r > 200 && g > 200 && b < 80) bootMask[i] = 1;
}

// Build a "paint anything" mask (mask has any color at all) so that background
// atlas pixels stay as the original texture (harmless — never sampled).
const anyCoverage = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const p = i * mask.chans;
  const a = mask.chans === 4 ? mask.data[p + 3] : 255;
  if (a > 0) anyCoverage[i] = 1;
}

// ---------- Compose ----------
// suit base ~ #2a2d33 (charcoal, slightly cool). Add subtle noise + vertical
// darker seams for a fabric-y feel without heavy detail.
const SUIT_R = 0x2a, SUIT_G = 0x2d, SUIT_B = 0x33;
const BOOT_R = 0x14, BOOT_G = 0x15, BOOT_B = 0x18;

const out = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const op = i * orig.chans;
    const or = orig.data[op], og = orig.data[op + 1], ob = orig.data[op + 2];
    const oa = orig.chans === 4 ? orig.data[op + 3] : 255;
    const dp = i * 4;

    if (skinProtect[i] || !anyCoverage[i]) {
      // keep original pixels
      out[dp] = or; out[dp + 1] = og; out[dp + 2] = ob; out[dp + 3] = oa;
      continue;
    }

    if (bootMask[i]) {
      // matte boot with a tiny bit of noise (+/- 3 per channel)
      const n = (noise(x, y, 7) - 0.5) * 6;
      out[dp] = Math.max(0, Math.min(255, BOOT_R + n));
      out[dp + 1] = Math.max(0, Math.min(255, BOOT_G + n));
      out[dp + 2] = Math.max(0, Math.min(255, BOOT_B + n));
      out[dp + 3] = 255;
      continue;
    }

    // suit region (GREEN in mask): charcoal fabric with subtle noise + faint
    // horizontal darker banding to hint at layered gear
    const nz = (noise(x, y, 3) - 0.5) * 10;
    // low-frequency dirt/dust — slight brightening in a large sine pattern
    const dust = Math.sin(x * 0.0025) * Math.cos(y * 0.0032) * 4;
    // vertical seam every ~200 texels
    const seamX = Math.abs(((x % 220) - 110)) < 2 ? -6 : 0;
    out[dp] = Math.max(0, Math.min(255, SUIT_R + nz + dust + seamX));
    out[dp + 1] = Math.max(0, Math.min(255, SUIT_G + nz + dust + seamX));
    out[dp + 2] = Math.max(0, Math.min(255, SUIT_B + nz + dust + seamX));
    out[dp + 3] = 255;
  }
}

fs.writeFileSync(outPath, encodePNG_RGBA(W, H, out));
console.log("wrote", outPath, W + "x" + H,
  "skin-protect pixels:", Array.from(skinProtect).reduce((a, b) => a + b, 0),
  "boot pixels:", Array.from(bootMask).reduce((a, b) => a + b, 0));
