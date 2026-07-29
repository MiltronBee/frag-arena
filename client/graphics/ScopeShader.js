// ============================================================================
// SNIPER SCOPE — GLSL COMPOSITE SHADER (code-only, ZERO asset files)
//
// Registers BABYLON.Effect.ShadersStore["scopeFragmentShader"], a screen-space
// PostProcess fragment shader that turns the flat CSS-sticker scope into a real
// optical disc. It runs over the COMBINED main-camera + viewmodel frame (see
// BABYLONRenderer.initScopePipeline — the pass is attached to both cameras via a
// PostProcessRenderPipeline exactly like `post2030`, so `textureSampler` already
// holds world + raised gun) and composites, per the 2026-07-29 expert-panel spec
// (_work/sniper-scope-panel/4-judge.md, Step 2):
//
//   • PERIPHERY (r > rOuter): the live world+gun, dimmed ~40% toward --x30-void
//     with a soft corner vignette. NOT solid black — peripheral awareness is the
//     whole point (failure #2). The raised gun body stays visible here, dimmed.
//   • OCULAR BEZEL (rInner..rOuter): a thin metallic ring with a specular edge —
//     the physical rim of the optic.
//   • INNER GLASS (r < rInner): the magnified sight picture from the 25° scope
//     camera RTT (`scopeSampler`), with barrel distortion, chromatic fringe at the
//     rim, a transmission lift, and an edge roll-off — glass depth (failure #1).
//     In the single-camera perf fallback (uLowResFallback==1) it samples the main
//     frame instead, so there are ZERO extra draw calls but the disc/bezel/reticle
//     still read.
//   • RETICLE: a shader-drawn etched crosshair in the game palette (--x30-ink dot +
//     hairlines + heavy stadia posts + corner chevrons, each with a --x30-void drop
//     shadow) — belongs to THIS game, no mil-ticks (failure #3).
//
// The disc RADIUS scales with uAdsT (rInner = 0.34*uAdsT), so as the gun swings up
// the glass grows into the frame and gun+FOV+disc all arrive together on the same
// 0.24s-in / 0.16s-out ramp. At uAdsT≈0 the shader is a pure pass-through (the pass
// is also hard-detached when un-scoped, so this branch is only hit for a frame or
// two at the very start/end of the ramp).
//
// GLSL ES 1.0 (WebGL). Every branch assigns gl_FragColor. No loops, no dynamic
// array indexing, no texture files.
// ============================================================================
import { Effect } from '../babylon.js'

export const SCOPE_FRAGMENT_NAME = 'scope' // PostProcess fragmentUrl -> "scopeFragmentShader"

let _registered = false

export function registerScopeShader() {
  if (_registered) return
  Effect.ShadersStore['scopeFragmentShader'] = FRAG
  _registered = true
}

const FRAG = `
precision highp float;

varying vec2 vUV;
uniform sampler2D textureSampler; // Combined main frame (world + raised viewmodel)
uniform sampler2D scopeSampler;   // 25° scope camera RTT (magnified world, no gun)

uniform float uAdsT;           // eased ADS ramp 0..1 (disc grows with this)
uniform float uAspect;         // renderWidth / renderHeight
uniform vec2  uEyeOffset;      // recoil / eye-box shear (small, decays to 0)
uniform float uLowResFallback; // 1.0 = single-camera fallback (no RTT sampling)

// --x30 palette (index identity)
const vec3 VOID = vec3(0.02, 0.027, 0.031); // #050708
const vec3 INK  = vec3(0.956, 0.968, 0.976); // #F4F7F9

void main(void) {
    vec2 st = vUV - vec2(0.5);
    vec2 aspectSt = vec2(st.x * uAspect, st.y);
    float r = length(aspectSt);

    // Ocular ring radii ramp open with the aim amount.
    float rInner = 0.34 * uAdsT;
    float rOuter = 0.36 * uAdsT;

    // ---- 1. PERIPHERY (outside the ocular bell) --------------------------------
    if (r > rOuter || uAdsT < 0.01) {
        vec4 mainColor = texture2D(textureSampler, vUV);
        if (uAdsT > 0.01) {
            float cornerVignette = smoothstep(0.5, 0.85, length(st));
            mainColor.rgb = mix(mainColor.rgb, VOID, 0.40 * uAdsT);
            mainColor.rgb = mix(mainColor.rgb, VOID, cornerVignette * 0.5 * uAdsT);
        }
        gl_FragColor = vec4(mainColor.rgb, 1.0);
        return;
    }

    // ---- 2. METALLIC OCULAR BEZEL (rInner <= r <= rOuter) ----------------------
    if (r >= rInner) {
        float ringT = (r - rInner) / max(rOuter - rInner, 1e-5);
        vec3 metallicBase = vec3(0.03, 0.04, 0.045);
        vec3 rimHighlight = vec3(0.40, 0.45, 0.48);
        float spec = pow(1.0 - abs(ringT - 0.5) * 2.0, 3.0);
        vec3 bezelColor = mix(metallicBase, rimHighlight, spec * 0.55);
        gl_FragColor = vec4(bezelColor, 1.0);
        return;
    }

    // ---- 3. INSIDE THE GLASS (r < rInner) --------------------------------------
    // Map the disc region to 0..1 glass UVs; shear by the eye offset (recoil kick).
    vec2 glassUV = (aspectSt - uEyeOffset * 0.08) / (rInner * 2.0) + vec2(0.5);

    // Barrel distortion (pincushion inverse): pushes edges out, sells a lens.
    vec2 p = glassUV - vec2(0.5);
    float glassR2 = dot(p, p);
    vec2 distortedUV = glassUV + p * (0.15 * glassR2);

    vec3 glass;
    if (uLowResFallback > 0.5) {
        // No second camera this session: sample the main frame straight (already
        // FOV-narrowed to 70° in Simulator). No magnification, but full optic dress.
        glass = texture2D(textureSampler, vUV).rgb;
    } else {
        // Chromatic aberration grows toward the glass rim. max() guards the smoothstep
        // edge order at tiny adsT (rInner -> 0.1) where edge0>=edge1 is undefined.
        float chroma = 0.025 * smoothstep(0.1, max(rInner, 0.101), r);
        float cr = texture2D(scopeSampler, distortedUV + p * chroma).r;
        float cg = texture2D(scopeSampler, distortedUV).g;
        float cb = texture2D(scopeSampler, distortedUV - p * chroma).b;
        glass = vec3(cr, cg, cb);
    }

    // Optical edge roll-off (darker toward the glass rim). Written with ascending
    // edges (edge0<edge1); 1.0 at centre, 0.0 at the rim — spec-defined on all drivers.
    float glassVignette = 1.0 - smoothstep(rInner * 0.5, rInner, r);
    glass *= mix(0.62, 1.0, glassVignette);

    // Transmission lift + gentle contrast (coated-glass look).
    glass = pow(max(glass, 0.0), vec3(0.92));
    glass += vec3(0.02, 0.025, 0.028);

    // ---- 4. ETCHED RETICLE (screen-space, palette-locked) ----------------------
    // aspectSt is height-normalised; *1000 gives a resolution-independent "unit"
    // space where the full screen height spans 1000 units (center at 0).
    vec2 rc = aspectSt * 1000.0;
    float rd = length(rc);
    float discEdge = rInner * 1000.0;

    float ink = 0.0;    // bright line coverage
    float shadow = 0.0; // etched drop-shadow coverage (offset, --x30-void)

    // A. Center micro-dot (radius ~1.2 units) floating in a clear aperture.
    if (rd <= 1.2) ink = max(ink, 1.0 - smoothstep(0.8, 1.2, rd));

    // B. Inner hairlines: 8..100 units, ~1.2 units wide, with a 1px drop shadow.
    if (rd > 8.0 && rd < 100.0) {
        if (abs(rc.x) <= 0.6 || abs(rc.y) <= 0.6) ink = 1.0;
        vec2 sp = rc - vec2(1.0, -1.0);
        if (abs(sp.x) <= 0.6 || abs(sp.y) <= 0.6) shadow = 0.8;
    }

    // C. Outer heavy stadia posts: 100 units out to the bezel, ~4 units wide.
    if (rd >= 100.0 && rd < discEdge) {
        if (abs(rc.x) <= 2.0 || abs(rc.y) <= 2.0) ink = 1.0;
        vec2 sp = rc - vec2(1.5, -1.5);
        if (abs(sp.x) <= 2.0 || abs(sp.y) <= 2.0) shadow = 0.8;
    }

    // D. Stenciled corner chevrons at ~140 units (locks the eye to center quadrant).
    vec2 ac = abs(rc);
    if (abs(ac.x - 140.0) < 12.0 && abs(ac.y - 140.0) < 1.6) ink = 1.0;
    if (abs(ac.y - 140.0) < 12.0 && abs(ac.x - 140.0) < 1.6) ink = 1.0;

    // Composite: shadow first (etch), then ink. Faded in with uAdsT.
    vec3 finalGlass = mix(glass, VOID, shadow * 0.8 * uAdsT);
    finalGlass = mix(finalGlass, INK, ink * uAdsT);

    // ---- 5. EXIT-PUPIL BLACKOUT on extreme shear (heavy recoil) ----------------
    float eyeClip = length(uEyeOffset);
    if (eyeClip > 0.85) {
        float shadowMask = smoothstep(0.85, 1.1, length(aspectSt + uEyeOffset * 0.25));
        finalGlass = mix(finalGlass, vec3(0.0), shadowMask);
    }

    gl_FragColor = vec4(finalGlass, 1.0);
}
`
