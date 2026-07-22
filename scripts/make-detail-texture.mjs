// ============================================================================
// make-detail-texture.mjs — generates the tiling 512x512 detail-grunge texture
// used by client/graphics/mapMaterialPop.js (StandardMaterial.detailMap).
//
//   node scripts/make-detail-texture.mjs
//   -> public/assets/textures/detail-grunge.png
//
// Layered (fBm) tileable value noise, normalized to MEAN 0.5 so the detail
// blend (baseColor * 2 * mix(0.5, detail.r, level)) never darkens the map on
// average — it only adds local micro-contrast.
//
// CHANNEL PACKING (matters!): Babylon's detail map reads
//   .r = diffuse grunge  (the only channel we use)
//   .g + .a = detail NORMAL xy (bumpFragment: detailColor.wy*2-1)
//   .b = roughness (PBR only)
// G/B/A are written as 128 (= 0.5 -> normal (0,0,1), neutral) so the detail
// map NEVER perturbs normals even if bumpLevel is nonzero. Do not "optimize"
// the alpha channel to 255 — alpha 128 is the neutral normal-X.
//
// Zero deps: PNG (RGBA, filter 0) encoded by hand via zlib.
// ============================================================================
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'textures', 'detail-grunge.png')

// --- seeded PRNG (mulberry32) — deterministic output, re-runs are stable ----
function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// --- tileable value noise: random lattice sampled with wraparound + smooth
// (quintic) interpolation. Lattice period divides SIZE -> seamless tiling. ---
function valueNoiseLayer(period, seed) {
	const rand = mulberry32(seed)
	const lattice = new Float32Array(period * period)
	for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
	const fade = t => t * t * t * (t * (t * 6 - 15) + 10)
	const out = new Float32Array(SIZE * SIZE)
	const cell = SIZE / period
	for (let y = 0; y < SIZE; y++) {
		const gy = y / cell, y0 = Math.floor(gy), fy = fade(gy - y0)
		const y0i = y0 % period, y1i = (y0 + 1) % period
		for (let x = 0; x < SIZE; x++) {
			const gx = x / cell, x0 = Math.floor(gx), fx = fade(gx - x0)
			const x0i = x0 % period, x1i = (x0 + 1) % period
			const a = lattice[y0i * period + x0i], b = lattice[y0i * period + x1i]
			const c = lattice[y1i * period + x0i], d = lattice[y1i * period + x1i]
			out[y * SIZE + x] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
		}
	}
	return out
}

// --- fBm stack: 5 octaves, halving amplitude. Octave 3 doubled-up with a
// different seed for a streakier, grungier read than pure fBm. --------------
const octaves = [
	{ period: 4, amp: 1.0, seed: 1337 },
	{ period: 8, amp: 0.55, seed: 2026 },
	{ period: 16, amp: 0.3, seed: 4242 },
	{ period: 32, amp: 0.18, seed: 777 },
	{ period: 64, amp: 0.1, seed: 90210 },
	{ period: 128, amp: 0.05, seed: 555 },
]
const acc = new Float32Array(SIZE * SIZE)
let ampSum = 0
for (const o of octaves) {
	const layer = valueNoiseLayer(o.period, o.seed)
	for (let i = 0; i < acc.length; i++) acc[i] += layer[i] * o.amp
	ampSum += o.amp
}
// normalize to [0,1]-ish, then re-center on EXACT mean 0.5
let mean = 0
for (let i = 0; i < acc.length; i++) { acc[i] /= ampSum; mean += acc[i] }
mean /= acc.length
const CONTRAST = 1.6 // stretch around the mean so the grunge reads at blendLevel .25
for (let i = 0; i < acc.length; i++) acc[i] = Math.min(1, Math.max(0, 0.5 + (acc[i] - mean) * CONTRAST))
// contrast clamp can drift the mean a hair — re-measure and shift back
let mean2 = 0
for (let i = 0; i < acc.length; i++) mean2 += acc[i]
mean2 /= acc.length
for (let i = 0; i < acc.length; i++) acc[i] = Math.min(1, Math.max(0, acc[i] + (0.5 - mean2)))

// --- pack RGBA scanlines: R = grunge, G/B/A = 128 (neutral, see header) -----
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
let finalMean = 0
for (let y = 0; y < SIZE; y++) {
	const row = y * (SIZE * 4 + 1)
	raw[row] = 0 // filter: none
	for (let x = 0; x < SIZE; x++) {
		const v = Math.round(acc[y * SIZE + x] * 255)
		finalMean += v
		const p = row + 1 + x * 4
		raw[p] = v; raw[p + 1] = 128; raw[p + 2] = 128; raw[p + 3] = 128
	}
}
finalMean /= SIZE * SIZE * 255

// --- minimal PNG writer ------------------------------------------------------
const crcTable = new Int32Array(256).map((_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
	return c
})
function crc32(buf) {
	let c = -1
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
	return (c ^ -1) >>> 0
}
function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4)
	out.writeUInt32BE(data.length, 0)
	out.write(type, 4, 'ascii')
	data.copy(out, 8)
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
	return out
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
	chunk('IHDR', ihdr),
	chunk('IDAT', deflateSync(raw, { level: 9 })),
	chunk('IEND', Buffer.alloc(0)),
])
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE}, R-channel mean ${finalMean.toFixed(4)})`)
