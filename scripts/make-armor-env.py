#!/usr/bin/env python3
"""Author the tiny equirectangular environment the gold armour reflects.

WHY THIS EXISTS
---------------
The arena scene has NO `scene.environmentTexture` (see the "IT'S JUST GREY" note in
client/graphics/CharacterModel.js): a glTF PBR material with metallic=1 has almost no
diffuse term, so with nothing to reflect it renders as a flat grey/black blob. Every
other metal prop in the project is rescued by de-metalizing it (`_fixUnlitMetal`), but
the armour plates are UNTEXTURED gold — de-metalizing an untextured gold plate just
yields a flat cream wash that reads as painted plastic.

So the armour gets its OWN reflection environment, assigned per-material
(`PBRMaterial.reflectionTexture`) rather than scene-wide, which keeps the rest of the
scene's lighting bit-for-bit unchanged. This script paints that environment.

WHY IT IS STYLIZED, NOT THE REAL SKY
------------------------------------
The real arena sky is a space/void starfield. A starfield environment is ~black, and a
metal reflecting black IS black — using it would land us back at the grey-blob bug.
What flatters gold is a classic three-band studio setup, so that is what we paint:

  * a DARK warm floor (bottom) -> gold's underside goes deep amber, not muddy grey
  * a hot AMBER horizon band   -> the saturated gold midtone, and the band's sharp
                                  edge is what draws the moving "waterline" streak
                                  across a curved pauldron as the camera orbits
  * a cooler, brighter SKY     -> a cool topside keeps the gold from going monochrome
                                  (warm/cool split is what makes metal read as metal)
  * one big elongated WINDOW   -> the primary specular. An anisotropic, off-centre
                                  bright bar is the single strongest "polished" cue;
                                  a uniform gradient alone still reads as plastic.
  * a small cool KICKER window -> opposite azimuth, so a piece is never fully dark on
                                  its shadow side and there is a second highlight to
                                  track when the first swings off-surface.

Output: public/assets/props/armor_env.png, 256x128 (~15 KB). It is expanded once at
load into a 128px cube (EquiRectangularCubeTexture) and sampled by 2 materials, so the
per-pixel cost is one extra cubemap fetch on armour pixels only.
"""
import math
import os
import numpy as np
from PIL import Image, ImageFilter

W, H = 256, 128
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'public', 'assets', 'props', 'armor_env.png')

# ---- palette (linear-ish 0..1 RGB, gamma-encoded at the very end) ------------
# CONTRAST IS THE WHOLE POINT. A metal's value range is its environment's value
# range: paint a gently-lit env and the plate lands in one narrow midtone, which is
# exactly what "plastic" looks like. So the ambient (sky + floor) is kept DARK and
# almost all the energy is concentrated in the horizon band and the two windows —
# that is what puts near-black right beside a hot highlight on a single plate.
FLOOR_DEEP = np.array([0.016, 0.011, 0.008])  # straight down: near black, warm
FLOOR_NEAR = np.array([0.075, 0.050, 0.028])  # just under the horizon
HORIZON    = np.array([1.000, 0.600, 0.210])  # the hot amber band
SKY_LOW    = np.array([0.135, 0.150, 0.195])  # just above the horizon
SKY_HIGH   = np.array([0.048, 0.062, 0.098])  # zenith: cool slate, nearly dark
WINDOW     = np.array([1.000, 0.945, 0.840])  # main key: warm white
KICKER     = np.array([0.400, 0.540, 0.780])  # fill: cool blue-white


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# v: 0 at the zenith (straight up) -> 1 at the nadir (straight down).
# u: 0..1 around the horizon.
u = (np.arange(W) + 0.5) / W
v = (np.arange(H) + 0.5) / H
U, V = np.meshgrid(u, v)

img = np.zeros((H, W, 3), dtype=np.float32)

# ---- 1. sky: zenith -> horizon --------------------------------------------
sky_t = smoothstep(0.0, 0.50, V)                       # 0 at top, 1 at horizon
sky = SKY_HIGH[None, None, :] * (1.0 - sky_t)[..., None] + SKY_LOW[None, None, :] * sky_t[..., None]

# ---- 2. ground: horizon -> nadir ------------------------------------------
gnd_t = smoothstep(0.50, 1.0, V)
gnd = FLOOR_NEAR[None, None, :] * (1.0 - gnd_t)[..., None] + FLOOR_DEEP[None, None, :] * gnd_t[..., None]

img = np.where((V < 0.5)[..., None], sky, gnd)

# ---- 3. the amber horizon band --------------------------------------------
# Narrow and bright: a wide soft band washes out, a narrow one draws a crisp
# travelling highlight across curved plate. Slightly wider below the line than
# above (the "ground bounce" side), which is what warms the underside of a pauldron.
d = V - 0.50
band = np.where(d < 0,
                np.exp(-(d / 0.055) ** 2),
                np.exp(-(d / 0.085) ** 2))
# gently modulate the band's intensity around the compass so orbiting the camera
# sweeps through hot and cool sectors instead of a featureless ring.
band = band * (0.72 + 0.28 * np.cos((U - 0.30) * 2.0 * math.pi))
img = img + HORIZON[None, None, :] * band[..., None]

# ---- 4. the key "window": one big elongated soft-box -----------------------
# Placed above and to one side of the horizon. Anisotropic (4x wider than tall)
# because a stretched highlight is the signature of a polished, slightly
# brushed metal; a round blob reads as a lightbulb.
def softbox(cu, cv, su, sv, power=2.0):
    du = np.abs(U - cu)
    du = np.minimum(du, 1.0 - du)            # wrap around the seam
    dv = V - cv
    r = np.sqrt((du / su) ** 2 + (dv / sv) ** 2)
    return np.clip(1.0 - r, 0.0, 1.0) ** power


# PEAK BUDGET — why the windows are dimmer than they "should" be.
# The armour is sampled at environmentIntensity ~2, through gold's own reflectance
# (0.82, 0.63, 0.24). So an env value P shows up on screen at roughly
# P * 2 * (0.82, 0.63, 0.24). Push P past ~0.75 and the GREEN channel clips too, the
# highlight goes WHITE, and a white highlight on gold reads as a shiny plastic bead.
# Held just under that, only RED clips — which is exactly what real gold does: the
# hot spot stays a saturated orange-gold instead of blowing out to paper.
PEAK = 0.75

key = softbox(0.28, 0.285, 0.155, 0.055, power=1.35)
img = img + WINDOW[None, None, :] * (key * PEAK * 0.78)[..., None]

# a second, much smaller and hotter core inside the key -> a tight glint that
# survives the low roughness and pops as a specular star on convex edges.
core = softbox(0.28, 0.285, 0.050, 0.019, power=1.0)
img = img + WINDOW[None, None, :] * (core * PEAK * 0.22)[..., None]

# ---- 5. the cool kicker, roughly opposite ---------------------------------
kick = softbox(0.76, 0.245, 0.115, 0.070, power=1.5)
img = img + KICKER[None, None, :] * (kick * 0.60)[..., None]

# a narrow high strip-light, well above the horizon and offset again in azimuth:
# a THIRD feature so that as the camera swings there is always something entering
# or leaving the plate. With only two, a piece can sit visually dead for a whole
# quarter-turn.
strip = softbox(0.52, 0.135, 0.230, 0.030, power=1.6)
img = img + WINDOW[None, None, :] * (strip * 0.42)[..., None]

# ---- 6. a couple of dim vertical "pillars" --------------------------------
# Faint darker columns straddling the horizon. Nearly invisible on their own, but
# on a curved plate they break the reflection into moving bands, which is the
# difference between "shiny" and "reflective".
for cu, amt in ((0.03, 0.35), (0.50, 0.28), (0.63, 0.22)):
    du = np.abs(U - cu)
    du = np.minimum(du, 1.0 - du)
    col = np.exp(-(du / 0.035) ** 2) * np.exp(-((V - 0.5) / 0.30) ** 2)
    img = img * (1.0 - (col * amt)[..., None])

# ---- 7. encode -------------------------------------------------------------
img = np.clip(img, 0.0, 1.0)
img = img ** (1.0 / 2.2)                                   # linear -> sRGB-ish
out = Image.fromarray((img * 255.0 + 0.5).astype(np.uint8), 'RGB')
# Blur AFTER encoding, in image space: softens the softbox edges into believable
# falloff. Small radius — over-blurring flattens the band back into the gradient
# and the "polished" read dies with it.
out = out.filter(ImageFilter.GaussianBlur(radius=1.6))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
out.save(OUT, optimize=True)
print('wrote', os.path.normpath(OUT), out.size, os.path.getsize(OUT), 'bytes')
