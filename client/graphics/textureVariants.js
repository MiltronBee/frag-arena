// ============================================================================
// TEXTURE VARIANTS — per-cluster texture variation on the mesh-map materials.
//
// The map OBJ ships ONE mesh per material, so a single 512px diffuse tiles across
// a whole floor/wall and the repetition reads. mapMaterialPop.js already breaks
// this at the MICRO scale (per-fragment hex-grid stochastic sampling + detail
// grunge). This module breaks it at the MACRO scale, with no shader work:
//
//   1. For each eligible material that has variant textures (declared in the map's
//      textures/variants.json manifest — NO runtime 404-probing), bucket its
//      triangles by world-space grid cell (~CELL m).
//   2. Deterministically hash (mapId | material | clusterCell) -> a variant index
//      in [0..N]  (0 = the base v1 texture; 1..N = <tex>.v2..v(N+1).webp). Every
//      client hashes the same world -> everyone sees the same layout, stable
//      across reloads.
//   3. PURE MESH SPLIT: reorder the mesh's INDEX buffer so each variant's triangles
//      are contiguous, then give the mesh a MultiMaterial + one SubMesh per variant.
//      Mesh identity (name, vertex buffer, vertex count, collision, shadow list,
//      vertex-light ColorKind) is UNTOUCHED — so the offline vertex-light bake
//      still matches by name+vertexCount and collision/shadows keep working.
//
// COMPOSE WITH mapMaterialPop (called FIRST, at the same hook): each variant
// material is `base.clone()` of the ALREADY-popped base, so it inherits the
// StandardMaterial detail-map config; the HexTilePop material-plugin is a custom
// (unregistered) plugin that clone() cannot recreate, so we re-attach it to each
// clone from the base plugin's own constructor + the exported MAP_POP_CONFIG. No
// edit to mapMaterialPop.js — we compose from outside its public surface.
//
// DRAW CALLS: a split mesh costs (distinctVariants) draw calls instead of 1.
// Grouping triangles BY VARIANT (not per cell) keeps that <= N+1 per material;
// total EXTRA draw calls are capped at MAX_EXTRA_DRAWCALLS per map (smallest
// variant groups fold back into v1 when over; capping is logged).
//
// GATE: `?variants=0` disables the whole feature (A/B baseline), mirroring the
//       renderer's `?flat=1`.
// ============================================================================
import * as BABYLON from '../babylon.js'
import { MAP_POP_CONFIG } from './mapMaterialPop.js'
// SubMesh + MultiMaterial are not on the curated render barrel; deep-import them
// (both resolve identically under Vite/tsx/node and carry no missing side effect).
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js'
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js'

export const TEX_VARIANTS_CONFIG = {
	cell: 10,                    // world-space cluster cell size (task spec: ~8-12 m)
	maxExtraDrawCalls: 40,       // per-map budget for the extra draw calls the split adds
}

// Same eligibility as mapMaterialPop.eligible: opaque, diffuse-textured, non-sky
// map StandardMaterials only — never additive/alpha materials.
function eligible(mat) {
	if (!mat || mat.getClassName() !== 'StandardMaterial') return false
	if (!mat.diffuseTexture || !mat.diffuseTexture.url) return false
	if (/sky/i.test(mat.name || '')) return false
	if (mat.alpha < 1 || mat.opacityTexture || mat.useAlphaFromDiffuseTexture) return false
	if (mat.needAlphaBlending && mat.needAlphaBlending()) return false
	return true
}

function texNameFromUrl(url) {
	const base = String(url).split(/[?#]/)[0].split('/').pop() || ''
	return base.replace(/\.[^.]+$/, '')
}

// FNV-1a -> variant in [0..slots-1]. Pure function of the string, so every client
// derives the identical variant for a given (map|material|cell).
function hashVariant(str, slots) {
	let h = 0x811c9dc5
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i)
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
	}
	return h % slots
}

// clone the (popped) base material for one variant texture and re-attach the
// HexTilePop plugin that clone() cannot carry (custom unregistered plugin).
function cloneVariantMaterial(scene, base, variantUrl, tag) {
	const vmat = base.clone(base.name + '.' + tag)
	// swap in the variant diffuse, mirroring the base sampler settings; dispose the
	// texture clone() made of the base diffuse so it does not leak.
	const bd = base.diffuseTexture
	const old = vmat.diffuseTexture
	const vtex = new BABYLON.Texture(variantUrl, scene, bd.noMipmap, bd.invertY, bd.samplingMode)
	vtex.uScale = bd.uScale; vtex.vScale = bd.vScale
	vtex.uOffset = bd.uOffset; vtex.vOffset = bd.vOffset
	vtex.wrapU = bd.wrapU; vtex.wrapV = bd.wrapV
	vtex.coordinatesIndex = bd.coordinatesIndex
	vtex.hasAlpha = bd.hasAlpha
	vmat.diffuseTexture = vtex
	if (old && old !== bd) old.dispose()
	// share the ONE detail-map grunge texture with the base (clone() duplicated it)
	if (base.detailMap && base.detailMap.texture && vmat.detailMap) {
		if (vmat.detailMap.texture && vmat.detailMap.texture !== base.detailMap.texture) vmat.detailMap.texture.dispose()
		vmat.detailMap.texture = base.detailMap.texture
	}
	// re-attach HexTilePop from the base plugin instance's own constructor (the
	// plugin class is not exported and clone() cannot recreate an unregistered
	// plugin) — only when the base actually carries it (desktop + WebGL2 + !flat).
	const basePlugin = base.pluginManager && base.pluginManager.getPlugin('HexTilePop')
	const hasPlugin = vmat.pluginManager && vmat.pluginManager.getPlugin('HexTilePop')
	if (basePlugin && !hasPlugin) {
		try {
			const Ctor = basePlugin.constructor
			const p = new Ctor(vmat, MAP_POP_CONFIG.hexTile)
			p.isEnabled = true
		} catch (e) { /* plugin re-attach is best-effort; detail map still composes */ }
	}
	return vmat
}

// split ONE eligible mesh (its single material spans the whole map) into per-cell
// variant SubMeshes. Returns { added, distinct } draw-call bookkeeping or null.
function splitMesh(scene, mesh, base, variantUrls, mapId, budgetLeft) {
	const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind)
	const indices = mesh.getIndices()
	if (!positions || !indices || indices.length < 6) return null
	mesh.computeWorldMatrix(true)
	const wm = mesh.getWorldMatrix()
	const triCount = (indices.length / 3) | 0
	const slots = variantUrls.length + 1            // +1 for the base (variant 0)
	const cell = TEX_VARIANTS_CONFIG.cell
	const p = new BABYLON.Vector3()

	const variantOfTri = new Uint8Array(triCount)
	const counts = new Array(slots).fill(0)
	for (let t = 0; t < triCount; t++) {
		let cx = 0, cy = 0, cz = 0
		for (let k = 0; k < 3; k++) {
			const vi = indices[t * 3 + k] * 3
			cx += positions[vi]; cy += positions[vi + 1]; cz += positions[vi + 2]
		}
		p.set(cx / 3, cy / 3, cz / 3)
		const w = BABYLON.Vector3.TransformCoordinates(p, wm)
		// round to cm before bucketing so cross-machine FP jitter can't flip a cell
		const gx = Math.floor(Math.round(w.x * 100) / 100 / cell)
		const gy = Math.floor(Math.round(w.y * 100) / 100 / cell)
		const gz = Math.floor(Math.round(w.z * 100) / 100 / cell)
		const v = hashVariant(`${mapId}|${base.name}|${gx},${gy},${gz}`, slots)
		variantOfTri[t] = v
		counts[v]++
	}

	let present = []
	for (let v = 0; v < slots; v++) if (counts[v] > 0) present.push(v)
	if (present.length <= 1) return { added: 0, distinct: 1 } // one cell / uniform: nothing to split

	// budget: this mesh would add (present.length - 1) draw calls. If that busts
	// the remaining budget, fold the SMALLEST variant groups back into base (v0).
	let capped = 0
	let extra = present.length - 1
	if (extra > budgetLeft) {
		const nonBase = present.filter(v => v !== 0).sort((a, b) => counts[a] - counts[b])
		const keep = Math.max(0, budgetLeft)      // how many non-base variants we may keep
		const drop = new Set(nonBase.slice(0, nonBase.length - keep))
		if (drop.size) {
			for (let t = 0; t < triCount; t++) if (drop.has(variantOfTri[t])) variantOfTri[t] = 0
			capped = drop.size
			present = present.filter(v => !drop.has(v))
			extra = present.length - 1
		}
	}
	if (present.length <= 1) return { added: 0, distinct: 1, capped }

	// base (v0) first, then variants ascending — reorder indices contiguous per group
	present.sort((a, b) => a - b)
	const newIndices = new Array(indices.length)
	const ranges = []
	let cursor = 0
	for (const v of present) {
		const start = cursor
		for (let t = 0; t < triCount; t++) {
			if (variantOfTri[t] !== v) continue
			newIndices[cursor++] = indices[t * 3]
			newIndices[cursor++] = indices[t * 3 + 1]
			newIndices[cursor++] = indices[t * 3 + 2]
		}
		ranges.push({ v, indexStart: start, indexCount: cursor - start })
	}
	mesh.setIndices(newIndices, positions.length / 3)

	const totalVerts = mesh.getTotalVertices()
	const multi = new MultiMaterial(base.name + '__variants', scene)
	multi.subMaterials = present.map(v => v === 0
		? base
		: cloneVariantMaterial(scene, base, variantUrls[v - 1], 'v' + (v + 1)))
	mesh.material = multi
	mesh.subMeshes = []
	ranges.forEach((r, i) => new SubMesh(i, 0, totalVerts, r.indexStart, r.indexCount, mesh))
	if (mesh.refreshBoundingInfo) mesh.refreshBoundingInfo(true)

	return { added: extra, distinct: present.length, capped }
}

// ============================================================================
// ENTRY POINT — call from BABYLONRenderer._loadMeshMap AFTER applyMapMaterialPop
// (so the base materials already carry the pop upgrades the clones inherit), with
// the freshly imported OBJ meshes and the map record (needs .id and .dir).
// Async (fetches the manifest) but touches only index buffers / materials, so it
// composes safely with the vertex-light bake and shadow bake regardless of timing.
// ============================================================================
export async function applyTextureVariants(scene, meshes, map) {
	const search = (typeof location !== 'undefined' && location.search) || ''
	if (/[?&]variants=0\b/.test(search)) {
		console.log('[texVariants] ?variants=0 — per-cluster variants disabled (A/B baseline)')
		return { clusters: 0, materials: 0, addedDrawCalls: 0, capped: 0, disabled: true }
	}
	if (!map || !map.dir) return { clusters: 0, materials: 0, addedDrawCalls: 0, capped: 0 }

	// manifest: { "<TexName>": <extraVariantCount> } — NO runtime 404 probing.
	let manifest = null
	try {
		const resp = await fetch(map.dir + 'textures/variants.json')
		if (resp.ok) manifest = await resp.json()
	} catch (e) { /* no manifest for this map */ }
	if (!manifest || !Object.keys(manifest).length) {
		console.log(`[texVariants] no variants manifest for ${map.id} — skipped`)
		return { clusters: 0, materials: 0, addedDrawCalls: 0, capped: 0 }
	}

	// one mesh per material: pair each eligible, variant-having mesh with its base
	const jobs = []
	for (const m of meshes) {
		if (!m || !m.getTotalVertices || m.getTotalVertices() === 0) continue
		const base = m.material
		if (!eligible(base)) continue
		const texName = texNameFromUrl(base.diffuseTexture.url)
		const n = manifest[texName] | 0
		if (n <= 0) continue
		const urls = []
		for (let i = 0; i < n; i++) urls.push(`${map.dir}textures/${texName}.v${i + 2}.webp`)
		jobs.push({ mesh: m, base, urls, texName })
	}
	if (!jobs.length) {
		console.log(`[texVariants] ${map.id}: manifest present but no eligible in-scene material matched`)
		return { clusters: 0, materials: 0, addedDrawCalls: 0, capped: 0 }
	}

	// process the highest-coverage materials first (most triangles = most to gain)
	jobs.sort((a, b) => b.mesh.getTotalIndices() - a.mesh.getTotalIndices())
	let budgetLeft = TEX_VARIANTS_CONFIG.maxExtraDrawCalls
	let materials = 0, addedDrawCalls = 0, clusters = 0, capped = 0
	const detail = []
	for (const j of jobs) {
		const res = splitMesh(scene, j.mesh, j.base, j.urls, map.id, budgetLeft)
		if (!res || res.distinct <= 1) { detail.push(`${j.texName}:uniform`); continue }
		materials++
		addedDrawCalls += res.added
		budgetLeft -= res.added
		clusters += res.distinct
		capped += res.capped || 0
		detail.push(`${j.texName}:${res.distinct}way${res.capped ? `(capped ${res.capped})` : ''}`)
	}
	const stats = { map: map.id, materials, clusters, addedDrawCalls, capped, budgetLeft, detail }
	scene._texVariantsStats = stats
	console.log(`[texVariants] ${map.id}: split ${materials} materials into ${clusters} variant groups, `
		+ `+${addedDrawCalls} draw calls (budget ${TEX_VARIANTS_CONFIG.maxExtraDrawCalls}, ${capped} capped) — ${detail.join(', ')}`)
	return stats
}
