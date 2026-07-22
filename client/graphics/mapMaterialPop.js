// ============================================================================
// MAP MATERIAL POP — kills visible texture repetition on the OBJ mesh-map
// materials while keeping the retro UT99 look. Two mechanisms:
//
//   1. HEX-GRID STOCHASTIC TILING (Heitz/Neyret-style, per-material shader
//      plugin): the diffuse sample is re-routed through a hidden triangular
//      lattice; each lattice vertex hashes to a random UV offset (+ optional
//      rotation) and the 3 candidate samples are barycentric-blended with
//      sharpened weights + a variance-preserving gain correction (mean taken
//      from a deep mip via textureLod). Injected as a MaterialPluginBase that
//      REPLACES the one diffuse fetch in default.fragment — everything
//      downstream (vertex-color light bake, DETAIL, lights/shadows, EXP2 fog)
//      composes exactly as before because baseColor is produced at the same
//      point in the pipeline, just sampled smarter.
//
//   2. DETAIL MAP: Babylon's built-in StandardMaterial.detailMap with a
//      generated tiling grunge texture (scripts/make-detail-texture.mjs).
//      Diffuse-only (bumpLevel 0 + neutral G/B/A channels in the PNG), mean
//      0.5 so average brightness is unchanged.
//
// SCOPE: called ONLY from BABYLONRenderer._loadMeshMap with the OBJ meshes —
// never touches viewmodels, characters, pickups, coronas or any additive/
// alpha material; 'sky' MTL materials are skipped by name.
//
// GATES: `?flat=1` URL param disables BOTH features (A/B comparison).
//        Touch devices get the detail map but NO stochastic tiling (3 extra
//        fetches + textureLod per fragment is exactly the mobile fill cost
//        the 2026-07-17 perf reverts taught us to avoid).
//        WebGL1 gets no stochastic tiling (needs textureGrad/textureLod).
// ============================================================================
import * as BABYLON from '../babylon.js'

// -- ALL tunables live here ---------------------------------------------------
export const MAP_POP_CONFIG = {
	hexTile: {
		enabled: true,
		// lattice cell size in TEXTURE REPEATS: one stochastic cell per ~3
		// repeats of the 512px diffuse (spec sweet spot 2-4). Bigger = fewer,
		// larger uniform patches; smaller = busier, blendier.
		cellScale: 3.0,
		// blend width control: barycentric weights are raised to this power
		// (then renormalized). Higher = NARROWER blend band at cell borders
		// (crisper cells, more visible seams); lower = wider, softer blend.
		blendExp: 4.0,
		// per-cell random rotation strength 0..1. Default OFF: UT99 textures
		// are architectural (bricks/panels) and read wrong when rotated;
		// random offsets alone already kill the repetition. Set 1 for fully
		// rotated cells on organic materials.
		rotation: 0.0,
		// mip level used (textureLod) as the texture mean for the variance-
		// preserving gain correction. 6 on a 512px texture = 8x8 average.
		meanLod: 6.0,
	},
	detail: {
		enabled: true,
		url: '/assets/textures/detail-grunge.png',
		diffuseBlendLevel: 0.25, // 0 = off, 1 = full grunge modulation
		uvScale: 6,              // grunge tiles per texture repeat
	},
}

// ============================================================================
// Hex-grid stochastic tiling as a MaterialPluginBase. GLSL only (the game
// renders on the WebGL2 Engine; gated off elsewhere for WebGL1).
// ============================================================================
class HexTilePopPlugin extends BABYLON.MaterialPluginBase {
	constructor(material, cfg) {
		// priority 200: after Babylon's own DetailMapConfiguration (140) so
		// plugin-define ordering stays stable; injection points don't overlap.
		super(material, 'HexTilePop', 200, { HEXPOP: false })
		this._cfg = cfg
		this._isEnabled = false
	}

	get isEnabled() { return this._isEnabled }
	set isEnabled(v) {
		if (this._isEnabled === v) return
		this._isEnabled = v
		this.markAllDefinesAsDirty()
	}

	getClassName() { return 'HexTilePopPlugin' }

	prepareDefines(defines) { defines.HEXPOP = this._isEnabled }

	getUniforms() {
		return {
			// x = cellScale, y = blendExp, z = rotation strength, w = meanLod
			ubo: [{ name: 'hexPopParams', size: 4, type: 'vec4' }],
			// non-UBO (WebGL1) fallback declaration — never hit in practice
			// (plugin is gated to WebGL2) but keeps the shader well-formed.
			fragment: `#ifdef HEXPOP
uniform vec4 hexPopParams;
#endif`,
		}
	}

	bindForSubMesh(uniformBuffer) {
		if (!this._isEnabled) return
		const c = this._cfg
		uniformBuffer.updateFloat4('hexPopParams', c.cellScale, c.blendExp, c.rotation, c.meanLod)
	}

	getCustomCode(shaderType) {
		if (shaderType !== 'fragment') return null
		return {
			CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef HEXPOP
vec2 hexPopHash(vec2 p) {
	vec2 r = mat2(127.1, 269.5, 311.7, 183.3) * p;
	return fract(sin(r) * 43758.5453);
}
vec4 hexPopTap(sampler2D samp, vec2 uv, vec2 v, float cellScale, float rotAmt, vec2 dx, vec2 dy) {
	vec2 h = hexPopHash(v);
	vec2 cen = (mat2(1.0, 0.0, 0.5, 0.86602540) * v) * cellScale; // unskew lattice vertex -> uv space
	float ang = rotAmt * 6.2831853 * fract((h.x + h.y) * 7.61);
	float cs = cos(ang); float si = sin(ang);
	mat2 rot = mat2(cs, si, -si, cs);
	return textureGrad(samp, (uv - cen) * rot + cen + h, dx * rot, dy * rot);
}
vec4 hexPopSample(sampler2D samp, vec2 uv) {
	float cellScale = hexPopParams.x;
	float blendExp = hexPopParams.y;
	float rotAmt = hexPopParams.z;
	float meanLod = hexPopParams.w;
	// hidden triangular lattice: skew grid space so lattice cells are
	// equilateral triangles (pairs form the hex cells)
	vec2 st = uv / cellScale;
	vec2 skewed = mat2(1.0, 0.0, -0.57735027, 1.15470054) * st;
	vec2 base = floor(skewed);
	vec3 t = vec3(fract(skewed), 0.0);
	t.z = 1.0 - t.x - t.y;
	float w1; float w2; float w3;
	vec2 v1; vec2 v2; vec2 v3;
	if (t.z > 0.0) {
		w1 = t.z; w2 = t.y; w3 = t.x;
		v1 = base; v2 = base + vec2(0.0, 1.0); v3 = base + vec2(1.0, 0.0);
	} else {
		w1 = -t.z; w2 = 1.0 - t.y; w3 = 1.0 - t.x;
		v1 = base + vec2(1.0, 1.0); v2 = base + vec2(1.0, 0.0); v3 = base + vec2(0.0, 1.0);
	}
	// per-vertex random transform: offset in whole-texture units (the
	// sampler wraps, any fract offset is a valid re-anchor) + optional
	// rotation about the cell centre. textureGrad with the ORIGINAL screen
	// footprint (rotated with the cell) keeps mip selection continuous
	// across the fract/hash discontinuities — no seam sparkle.
	vec2 dx = dFdx(uv);
	vec2 dy = dFdy(uv);
	vec4 c1 = hexPopTap(samp, uv, v1, cellScale, rotAmt, dx, dy);
	vec4 c2 = hexPopTap(samp, uv, v2, cellScale, rotAmt, dx, dy);
	vec4 c3 = hexPopTap(samp, uv, v3, cellScale, rotAmt, dx, dy);
	// sharpened barycentric weights = tunable blend width
	vec3 w = pow(vec3(w1, w2, w3), vec3(blendExp));
	w /= (w.x + w.y + w.z);
	vec4 blended = w.x * c1 + w.y * c2 + w.z * c3;
	// variance-preserving gain correction: linear blending of N samples
	// shrinks contrast by sqrt(sum(w^2)); re-expand around the texture mean
	// (deep mip). Exact (gain=1) whenever one weight dominates.
	vec4 mean = textureLod(samp, uv, meanLod);
	return clamp(mean + (blended - mean) * inversesqrt(dot(w, w)), 0.0, 1.0);
}
#endif
`,
			// Replace THE diffuse fetch in default.fragment (Babylon 9.17:
			// `baseColor=TEXRD(diffuseSampler,vDiffuseUV+uvOffset);`). Doing it
			// at the fetch — not at CUSTOM_FRAGMENT_UPDATE_DIFFUSE, which runs
			// AFTER the vertex-color and detail multiplies — is what keeps the
			// light bake + detail map composing untouched.
			'!baseColor=TEXRD\\(diffuseSampler,vDiffuseUV\\+uvOffset\\);': `
#ifdef HEXPOP
baseColor=hexPopSample(diffuseSampler,vDiffuseUV+uvOffset);
#else
baseColor=TEXRD(diffuseSampler,vDiffuseUV+uvOffset);
#endif
`,
		}
	}
}

// -- eligibility: OBJ mesh-map StandardMaterials only -------------------------
// (never additive/alpha materials, never 'sky' MTL entries)
function eligible(mat) {
	if (!mat || mat.getClassName() !== 'StandardMaterial') return false
	if (!mat.diffuseTexture) return false
	if (/sky/i.test(mat.name || '')) return false
	if (mat.alpha < 1 || mat.opacityTexture || mat.useAlphaFromDiffuseTexture) return false
	if (mat.needAlphaBlending && mat.needAlphaBlending()) return false
	return true
}

// ============================================================================
// ENTRY POINT — call from BABYLONRenderer._loadMeshMap with the freshly
// imported OBJ meshes, BEFORE any material freeze()/scene.freezeMaterials().
// (Frozen materials are defensively unfrozen/refrozen around the mutation.)
// ============================================================================
export function applyMapMaterialPop(scene, meshes) {
	const search = (typeof location !== 'undefined' && location.search) || ''
	if (/[?&]flat=1\b/.test(search)) {
		console.log('[mapPop] ?flat=1 — texture pop disabled (A/B baseline)')
		return
	}
	// EXACT same touch condition as the renderer's post-pipeline gate
	const isTouch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0
	const engine = scene.getEngine()
	const isWebGL2 = ((engine.version !== undefined ? engine.version : engine.webGLVersion) || 1) > 1
	const wantHex = MAP_POP_CONFIG.hexTile.enabled && !isTouch && isWebGL2

	// unique materials actually used by the map's vertexed meshes
	const mats = new Set()
	for (const m of meshes) {
		if (m && m.material && m.getTotalVertices && m.getTotalVertices() > 0) mats.add(m.material)
	}

	// one shared detail texture for every map material
	let detailTex = null
	if (MAP_POP_CONFIG.detail.enabled) {
		detailTex = new BABYLON.Texture(MAP_POP_CONFIG.detail.url, scene)
		detailTex.uScale = MAP_POP_CONFIG.detail.uvScale
		detailTex.vScale = MAP_POP_CONFIG.detail.uvScale
	}

	let hexed = 0, detailed = 0, skipped = 0
	for (const mat of mats) {
		if (!eligible(mat)) { skipped++; continue }
		const wasFrozen = !!mat.isFrozen
		if (wasFrozen) mat.unfreeze() // plugins/config must attach pre-freeze
		if (detailTex) {
			mat.detailMap.texture = detailTex
			mat.detailMap.diffuseBlendLevel = MAP_POP_CONFIG.detail.diffuseBlendLevel
			mat.detailMap.bumpLevel = 0        // diffuse-only: never perturb normals
			mat.detailMap.roughnessBlendLevel = 0
			mat.detailMap.isEnabled = true
			detailed++
		}
		if (wantHex) {
			const plugin = new HexTilePopPlugin(mat, MAP_POP_CONFIG.hexTile)
			plugin.isEnabled = true
			hexed++
		}
		if (wasFrozen) mat.freeze()
	}
	console.log(`[mapPop] hexTile on ${hexed}, detailMap on ${detailed}, skipped ${skipped}`
		+ `${isTouch ? ' (touch: no hexTile)' : ''}${isWebGL2 ? '' : ' (WebGL1: no hexTile)'}`)
}
