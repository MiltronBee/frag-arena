// TDM team uniforms: ask gemini-3.1-flash-image to repaint the hero body's
// clothing regions (image-to-image on the GLB's own UV atlas) as a detailed
// sci-fi tactical suit with RED / BLUE team accents. Follows the pattern of
// scripts/gemini-texture-remaster.mjs (same model, same key source).
//
// UV-SAFETY: the model is prompted to keep every island in place, but we do NOT
// trust it near skin — after generation we composite: pixels that were GARMENT
// in the original atlas (navy suit / black boots+gloves / gray soles, all
// max(r,g,b)<100 — skin is >=140 red everywhere) take the Gemini repaint;
// everything else (face/skin/hands) stays byte-identical to the original. So a
// drifted island can only miscolor the suit, never break the face.
//
//   node scripts/gemini-uniform-texture.mjs [--force]
//
// Outputs (client picks these up via assets.playerBody.teamSkins):
//   public/assets/characters/hero_male_uniform_red.webp
//   public/assets/characters/hero_male_uniform_blue.webp
// Raw un-composited candidates land in the scratch dir passed via UNIFORM_TMP
// (default /tmp) for eyeballing.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Key: ALT= or GEMINI_API_KEY=. NOTE: ~/solSoccer moved to /mnt/echostore/solSoccer
// (2026-07-22, per user) — the older gemini-*.mjs scripts still hardcode the dead
// home path. Echostore path first; home candidates kept as fallbacks.
const ENV_CANDIDATES = [
  '/mnt/echostore/solSoccer/.env',
  '/home/miltron/solSoccer/.env',
  '/home/miltron/unreal/.env',
  '/home/miltron/.env',
]
let key = process.env.GEMINI_API_KEY || process.env.ALT || null
for (const p of ENV_CANDIDATES) {
  if (key) break
  let envRaw
  try { envRaw = fs.readFileSync(p, 'utf8') } catch { continue }
  key =
    envRaw.match(/^ALT=(.+)$/m)?.[1]?.trim() ||
    envRaw.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim() || null
  if (key) console.log(`[key] using ${p}`)
}
if (!key) throw new Error('no ALT or GEMINI_API_KEY found (env or ' + ENV_CANDIDATES.join(', ') + ')')

const ROOT = path.resolve(process.env.HOME, 'unreal')
const GLB = path.join(ROOT, 'public/assets/characters/hero_male.glb')
const OUTDIR = path.join(ROOT, 'public/assets/characters')
const TMP = process.env.UNIFORM_TMP || '/tmp'
const FORCE = process.argv.includes('--force')

const MODEL = 'gemini-3.1-flash-image'

// ---- pull an embedded image (by name) straight out of the GLB ----
function extractImage(name) {
  const buf = fs.readFileSync(GLB)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString())
  const binStart = 20 + jsonLen + 8
  const img = json.images.find((i) => i.name === name)
  if (!img) throw new Error(name + ' not found in GLB')
  const bv = json.bufferViews[img.bufferView]
  return buf.slice(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength)
}
const extractAtlas = () => extractImage('T_Superhero_Male_Dark')

// Team accent descriptions. Base stays charcoal/graphite on BOTH teams so the
// suits look like the same military kit — only panels/trim carry the team hue.
const TEAMS = [
  ['red', 'deep crimson RED (like #b23028) accent panels: chest plate trim, shoulder yokes, a thick vertical stripe down each leg panel, glove cuffs and boot trim'],
  ['blue', 'strong cobalt BLUE (like #2f66c8) accent panels: chest plate trim, shoulder yokes, a thick vertical stripe down each leg panel, glove cuffs and boot trim'],
]

// low-level i2i call: full prompt in, PNG buffer out.
async function generateRaw(b64, prompt, temperature = 0.6) {
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/png', data: b64 } },
      { text: prompt },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], temperature },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
  if (!img) throw new Error('no image in response: ' + JSON.stringify(json).slice(0, 300))
  return Buffer.from(img.data, 'base64')
}

async function generate(b64, accentDesc) {
  const prompt = `This is the UV texture atlas (flat albedo) of a low-poly game character. It contains skin islands (face, arms, hands — the tan/orange regions) and CLOTHING islands: flat dark-navy suit panels (sleeveless tactical suit torso + trouser legs), black boots and black gloves.
Repaint ONLY the dark clothing regions as a highly detailed sci-fi tactical combat suit: woven ripstop fabric with visible weave, molded armor plating segments, webbing straps, zips and seams, utility pouches, knee pads, subtle wear and scuffed edges — on a dark charcoal/graphite base, with ${accentDesc}.
HARD RULES: this is a UV atlas, NOT a picture of a person — keep every island EXACTLY where it is, identical silhouettes and boundaries, so it can be applied to the same 3D model. Do NOT move, resize, restyle or redraw the skin, face or hand regions — leave all skin areas untouched. Square image, no text, no watermark, no borders. Flat albedo only — no dramatic lighting, no cast shadows.`
  return generateRaw(b64, prompt, 0.6)
}

// Composite in python/PIL: garment mask from the ORIGINAL atlas (max channel <100),
// feathered 2px, Gemini repaint only inside the mask. Output 1024px webp.
function composite(origPng, genPng, outWebp) {
  const py = `
from PIL import Image, ImageFilter
import numpy as np
SIZE = 1024
orig = Image.open(${JSON.stringify(origPng)}).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
gen = Image.open(${JSON.stringify(genPng)}).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
o = np.asarray(orig).astype(np.int16)
mask = (o.max(axis=2) < 100).astype(np.uint8) * 255
m = Image.fromarray(mask, 'L').filter(ImageFilter.GaussianBlur(1.2))
out = Image.composite(gen, orig, m)
out.save(${JSON.stringify(outWebp)}, 'WEBP', quality=90, method=6)
print('composited ->', ${JSON.stringify(outWebp)})
`
  execFileSync('python3', ['-c', py], { stdio: 'inherit' })
}

const atlasPng = path.join(TMP, 'uniform_atlas_orig.png')
fs.writeFileSync(atlasPng, extractAtlas())
const b64 = fs.readFileSync(atlasPng).toString('base64')

// ===========================================================================
// V2 (--v2): the "banger brief" pipeline. Per-zone GENERATION intent realised
// against THIS atlas, whose garment is one large FUSED connected island (a
// component scan shows a single 1.5M-px blob spanning the whole lower atlas +
// left torso — the navy panels touch in UV space). Cutting that blob into crops
// and repainting each separately would seam ACROSS one physical panel, so a
// naive per-crop-repaint is the wrong tool here. Instead:
//   - a BASE whole-atlas repaint (seam-free) paints every garment panel with a
//     QUIET accent (thin trim only, legs/boots desaturated);
//   - an optional CHEST whole-atlas repaint (UNIFORM_CHEST!=0) is feathered into
//     the chest box only, giving the "hero" splash its own tuned prompt while its
//     feathered boundary lands inside the torso panel interior;
//   - the value hierarchy (dark feet->bright chest), the SINGLE dominant chest
//     accent splash + quiet legs, and the warm/cool base shift are then enforced
//     DETERMINISTICALLY per body-part zone in _uniform-bake.py (seam-free, exact,
//     which is what the brief's high-impact S1/S2 items actually need);
//   - DeepBump makes the normal map from the finished albedo, and its top-left
//     relight is baked back into the albedo at 35% (see _uniform-bake.py).
// Zone boxes are normalized [x0,y0,x1,y1] over the 2048 atlas, read off the
// component scan + a visual inspect (front-torso panel = chest; the two boot-
// shaped blobs top-right + mid = boots).
// ===========================================================================
if (process.argv.includes('--v2')) {
  const normalPng = path.join(TMP, 'uniform_atlas_normal.png')
  fs.writeFileSync(normalPng, extractImage('T_Superhero_Male_Normal'))
  const DEEPBUMP_DIR = process.env.DEEPBUMP_DIR ||
    '/tmp/claude-1000/-home-miltron-unreal/04e52fd2-39e9-46b1-ac42-e6ddfd88dafe/scratchpad/DeepBump'
  const DO_CHEST = process.env.UNIFORM_CHEST !== '0'
  const CHEST_BOX = [0.0, 0.355, 0.24, 0.62]
  const BOOT_BOXES = [[0.70, 0.005, 1.0, 0.285], [0.475, 0.265, 0.735, 0.47]]

  // §5 prompt skeleton, one variant per zone. accent = colourblind-safe bright
  // hue (warm orange-red / cobalt), base charcoal shifted warm|cool.
  const zonePrompt = (zone, accent, shift) => {
    // PUNCH-UP (v2.1): the charcoal v2 read as flat colour on a small model in
    // dark maps — 1024px fine detail averages to grey. So: a MEDIUM GUNMETAL GREY
    // base (mid-tone, NOT black/charcoal — must survive being shrunk), FEW but
    // BIG chunky plates (512px-visible shapes, not 2048px filigree), and THICK
    // hard black seam lines for maximum panel contrast.
    const common = `This is a UV texture atlas (flat albedo) of a low-poly game character — NOT a picture of a person. Skin islands (tan/orange face, arms, hands) MUST stay EXACTLY as-is: do not move, resize, restyle or recolour any skin. Keep every island/shape exactly in place; repaint colour and surface detail only. Flat game albedo: clean FLAT shading, NO painterly brush texture, NO cast lighting or drop shadows, NO soft gradients except the single accent gradient noted below. HIGH CONTRAST read: a MEDIUM GUNMETAL / STEEL GREY base (clearly mid-tone, NOT black or charcoal — it must still read when the texture is shrunk to 512px), broken by THICK hard-edged BLACK panel lines and deep AO only in the seams. FEW but BIG chunky armor plates — bold large segments, not fine filigree; every shape must be legible at low resolution. Video-game texture style, Team Fortress 2 / Quake material read. Square, no text, no watermark, no borders. Base grey shifted ${shift}.`
    if (zone === 'chest') {
      return `${common}\nFocus: the CHEST plate and shoulder yokes carry ONE bold ${accent} accent SPLASH with a single clean gradient — bright, high-saturation, the big panel the eye lands on. A few LARGE molded armor plates with thick hard black panel edges. Overall brightness increases toward the collar.`
    }
    if (zone === 'boots') {
      return `${common}\nFocus: the BOOT islands — repaint them as chunky tactical COMBAT BOOTS that clearly read as boots, not suit legs: molded dark composite upper, a distinct hard SOLE line along the bottom edge, a big reinforced toe cap, two thick calf straps with simple buckles, lightly scuffed/worn toe. Mid-dark grey (a step darker than the suit, NOT black), with one thin ${accent} trim line on the upper strap only.`
    }
    return `${common}\nRepaint the dark navy clothing as a tactical composite suit built from a FEW big chunky armor plates and panels: thick hard black seams between large segments, bold knee pads, a couple of large webbing straps — keep it simple and readable, no busy micro-detail. Keep the team accent QUIET everywhere — only a thin ${accent} trim on a couple of panel edges; legs and boots are the darker (but still mid-grey, not black) quiet end of the value range.`
  }

  const V2_TEAMS = [
    // accentHue = HSV hue of the accent hex (d94a35 -> ~10deg, 2f66c8 -> ~218deg),
    // used by the chest-plate injection to hard-tint a weak (grey) chest splash.
    { team: 'red', accent: 'bright warm orange-red (#d94a35)', shift: 'slightly WARM', accentHueRange: [335, 45], accentHue: 12 },
    { team: 'blue', accent: 'cobalt blue (#2f66c8)', shift: 'slightly COOL', accentHueRange: [195, 255], accentHue: 218 },
  ]

  for (const t of V2_TEAMS) {
    const finalOut = path.join(OUTDIR, `hero_male_uniform_${t.team}.webp`)
    const normalOut = path.join(OUTDIR, `hero_male_uniform_${t.team}_n.webp`)
    const baseRaw = path.join(TMP, `uniform_v2_${t.team}_base.png`)
    const chestRaw = path.join(TMP, `uniform_v2_${t.team}_chest.png`)

    if (!fs.existsSync(baseRaw) || FORCE) {
      const buf = await generateRaw(b64, zonePrompt('base', t.accent, t.shift), 0.35)
      fs.writeFileSync(baseRaw, buf)
      console.log(`gen  ${t.team} base (${(buf.length / 1024).toFixed(0)}KB)`)
    } else console.log(`reuse ${t.team} base`)

    const gens = [baseRaw]
    if (DO_CHEST) {
      if (!fs.existsSync(chestRaw) || FORCE) {
        const buf = await generateRaw(b64, zonePrompt('chest', t.accent, t.shift), 0.4)
        fs.writeFileSync(chestRaw, buf)
        console.log(`gen  ${t.team} chest (${(buf.length / 1024).toFixed(0)}KB)`)
      } else console.log(`reuse ${t.team} chest`)
      gens.push(chestRaw)
    }
    // boots pass (user ask 2026-07-22 "add some boots"): a real boot read for the
    // two boot islands — composited by _uniform-bake.py as gens[2] into bootBoxes.
    const bootsRaw = path.join(TMP, `uniform_v2_${t.team}_boots.png`)
    if (!fs.existsSync(bootsRaw) || FORCE) {
      const bbuf = await generateRaw(b64, zonePrompt('boots', t.accent, t.shift), 0.4)
      fs.writeFileSync(bootsRaw, bbuf)
      console.log(`gen  ${t.team} boots (${(bbuf.length / 1024).toFixed(0)}KB)`)
    } else console.log(`reuse ${t.team} boots`)
    gens.push(bootsRaw)

    const bakeCfg = {
      orig: atlasPng, origNormal: normalPng, gens,
      chestBox: CHEST_BOX, bootBoxes: BOOT_BOXES,
      // punch (v2.1): lift garment midtones so the base clears the ~35% luminance
      // that dark maps eat, and deepen panel-line contrast. bootDark eased (0.10)
      // so boots stay mid-grey, not black.
      punchGamma: 0.68, punchContrast: 1.32,
      chestBright: 0.12, bootDark: 0.10,
      accentHueRange: t.accentHueRange, accentHue: t.accentHue, chestInject: 0.55,
      baseShift: t.team === 'red' ? 'warm' : 'cool',
      outAlbedo: finalOut, outNormal: normalOut,
      deepbumpDir: DEEPBUMP_DIR, size: 1024,
    }
    const py = path.join(ROOT, 'scripts/_uniform-bake.py')
    const out = execFileSync('python3', [py, JSON.stringify(bakeCfg)], { encoding: 'utf8' })
    console.log(`bake ${t.team}: ${out.trim()}`)
  }
  console.log('v2 done')
} else {
  // ---- V1 (legacy): single whole-atlas pass per team, mask composite only ----
  for (const [team, accent] of TEAMS) {
    const rawOut = path.join(TMP, `uniform_${team}_raw.png`)
    const finalOut = path.join(OUTDIR, `hero_male_uniform_${team}.webp`)
    if (fs.existsSync(finalOut) && !FORCE) { console.log(`skip ${team} (exists; --force to regen)`); continue }
    const buf = await generate(b64, accent)
    fs.writeFileSync(rawOut, buf)
    console.log(`gen  ${team} raw (${(buf.length / 1024).toFixed(0)}KB) -> ${rawOut}`)
    composite(atlasPng, rawOut, finalOut)
  }
  console.log('done')
}
