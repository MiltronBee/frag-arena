# Team Uniform "Banger" Brief — research-backed recipe (2026-07-22)

Distilled from a multi-source research sweep (TF2/Valve NPAR paper, OW art-team interviews,
practitioner atlas-repaint workflows, Babylon docs). Impact-ranked. Sources inline.

## 1. Value hierarchy beats detail (HIGHEST impact — costs nothing)
The Blizzard-stated readability hierarchy is **silhouette → value → color → saturation →
micro-detail** (Cook & Becker OW art-team interview). Valve's TF2 paper codifies it:
- **Bake a vertical value gradient into the albedo: darker feet/legs → brightest at the
  chest**, so the eye lands where the weapon/action is (Valve NPAR07; Coelho-Kostolny).
- **One dominant team-color splash with a single gradient** reads better than distributed
  accents everywhere (Tracer cited as the positive example). Chest plate + shoulder yokes
  = the splash; keep legs/gear desaturated neutral.
- "Visual noise" (uniform micro-detail everywhere) is the #1 distance-readability killer.
  Detail budget goes to the chest/shoulders; thighs/boots stay quiet.

## 2. Colorblind + dark-map safety (HIGH impact — prompt + palette rule)
- Protans see red as MUCH darker → team distinction must survive on **luminance contrast,
  not hue**: make RED team's accents a bright warm orange-red (#d94a35-ish) rather than
  deep crimson, and keep ≥3:1 luminance vs the suit base (Smashing Mag colorblind guide).
- Warm-vs-cool coding (TF2's actual system): RED = warm base tint overall, BLU = cool
  base tint — the whole suit shifts temperature slightly, not just accent panels (80.lv).
- Keep the subtle team emissive glow (current implementation) — in dark maps it is the
  strongest cue and colorblind-safe if RED-team glow biases orange. 12-15% is right.

## 3. Normal map from the repainted albedo (MEDIUM-HIGH — one command, big look)
- **DeepBump** (free, ML albedo→normal, github.com/HugoTini/DeepBump) on the finished
  uniform atlas gives plating/fabric relief for free. Babylon: StandardMaterial
  `bumpTexture` works today — no PBR migration needed (Babylon docs; DeepWiki compare).
- Cheaper fallback (zero extra texture): composite the normal map's shading back into the
  albedo ("baked lighting cues", Autodesk forum trick) — best for our dark maps since
  baked highlights read even where dynamic light is weak. DO BOTH: bake highlights into
  albedo AND ship the normal map for the muzzle-flash/corona lights to catch.

## 4. Atlas-repaint technique upgrades (MEDIUM — reliability, not look)
- Practitioner consensus (Richard Fu writeup): general i2i models NEVER preserve islands
  pixel-perfectly — our mask-composite is the correct guard. Upgrade: **per-island (or
  per-garment-zone) repaint passes with tight scoped prompts**, composited back, instead
  of one whole-atlas pass. Islands can only miscolor themselves, never bleed.
- Keep generation at moderate res then upscale (practitioner guide: whole-character
  single-pass generations degrade; 640-960px regions are the sweet spot).
- If Gemini output stays painterly: dedicated tools with "keep original UV" modes exist
  (Meshy Retexture API, Scenario's Use-Original-UV, StableProjectorz free/local) — real
  options for the buy-don't-author pipeline if we outgrow Gemini i2i.

## 5. Prompt pattern (apply verbatim-ish)
Per-zone prompt skeleton, one zone per pass:
  "Flat game albedo texture atlas region, [ZONE: chest armor plate]. Repaint as
  [worn tactical composite plating / ripstop weave]: crisp hard-edged panel lines,
  clean flat shading with baked ambient occlusion in crevices, NO painterly brush
  texture, NO soft gradients except the single [team] accent gradient, video-game
  texture style (Team Fortress 2 material read). Keep every shape exactly in place;
  repaint colors and surface detail only. Team accent: [bright orange-red #d94a35 |
  cobalt #2f66c8] on the plate trim, base suit charcoal shifted [warm|cool]."
Negative/state cues that matter: "no painterly", "flat shading", "hard edges",
"baked AO in crevices", "keep shapes in place". Value-gradient instruction: "overall
brightness increases from waist to collar".

## Execution order for v2 uniforms
1. Regenerate red/blue atlases: per-zone passes + mask composite + value gradient +
   warm/cool base shift + single chest accent splash.
2. DeepBump normal map from each finished atlas; bake its shading into albedo at ~35%;
   ship `bumpTexture` too.
3. Keep 12-15% team emissive; bias RED glow toward orange.
4. Probe screenshots at 5m AND ~30m in a dark map corner; the 30m shot decides.
