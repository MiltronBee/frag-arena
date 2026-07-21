// Bake the map's original 1999 light actors (export_lights.py sidecar JSON) into
// per-vertex colors. pos_m/radius_m in the JSON are in the OBJ's LOCAL Z-up meter
// space — the same space as the raw vertex buffers — so the bake runs on local
// positions/normals and needs no rotation/scale handling; the map root's
// transform applies to the result for free.
//
// Why a bake and not Babylon lights: 340 actors vs StandardMaterial's ~4
// simultaneous lights. Vertex colors multiply the diffuse texture in the shader
// (VERTEXCOLOR path), cost nothing per frame, and read like UT99's lightmaps
// at BSP-vertex resolution.

// Flickery types get a reduced steady weight instead of animation (bake is static).
const TYPE_WEIGHT = { Steady: 1, Pulse: 0.75, SubtlePulse: 0.85, Blink: 0.5, Strobe: 0.55 }

// Calibrated against the vertex-brightness histogram (340 overlapping actors
// blanket the map): p50 ≈ 0.78, p90 ≈ 1.13, ~20% of verts reach the clamp as
// hotspots, nothing below 0.4. Higher gains saturate everything to the cap and
// the lighting reads flat.
export const LIGHT_AMBIENT = 0.25 // floor so unlit BSP never goes pitch black
export const LIGHT_GAIN = 0.8

// `occlude` (optional) is the OFFLINE bake hook (scripts/bake-map-lighting.mjs):
// occlude(vertexIndex, px,py,pz, nx,ny,nz, lightEntry, dist) -> true means a shadow
// ray from the vertex to that light hit level geometry, so the light contributes 0.
// The runtime (client) bake passes nothing and keeps the distance-only behaviour.
export function bakeVertexColors(positions, normals, lights, ambient = LIGHT_AMBIENT, gain = LIGHT_GAIN, occlude = null) {
	const count = positions.length / 3
	const out = new Float32Array(count * 4)
	const L = []
	for (const l of lights) {
		const w = (l.brightness / 255) * (TYPE_WEIGHT[l.type] !== undefined ? TYPE_WEIGHT[l.type] : 1)
		if (w <= 0.003) continue
		L.push({
			x: l.pos_m[0], y: l.pos_m[1], z: l.pos_m[2],
			r: Math.max(l.radius_m || 15, 0.001),
			w, c: l.rgb || [1, 1, 1]
		})
	}
	for (let i = 0; i < count; i++) {
		const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
		const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2]
		let r = ambient, g = ambient, b = ambient
		for (let j = 0; j < L.length; j++) {
			const l = L[j]
			const dx = l.x - px, dy = l.y - py, dz = l.z - pz
			if (dx > l.r || dx < -l.r || dy > l.r || dy < -l.r || dz > l.r || dz < -l.r) continue
			const d2 = dx * dx + dy * dy + dz * dz
			if (d2 >= l.r * l.r) continue
			const d = Math.sqrt(d2)
			if (occlude !== null && occlude(i, px, py, pz, nx, ny, nz, l, d)) continue
			const att = 1 - d / l.r
			// soft incidence: faces turned away keep a 0.35 bounce floor so thin
			// walls don't split into day/night halves at shared edges
			let inc = 1
			if (d > 1e-4) {
				const dot = (dx * nx + dy * ny + dz * nz) / d
				inc = 0.35 + 0.65 * Math.max(dot, 0)
			}
			const e = l.w * att * att * inc * gain
			r += l.c[0] * e; g += l.c[1] * e; b += l.c[2] * e
		}
		// allow mild overbright at hotspots; hard-cap so torches don't blow out
		out[i * 4] = Math.min(r, 1.5)
		out[i * 4 + 1] = Math.min(g, 1.5)
		out[i * 4 + 2] = Math.min(b, 1.5)
		out[i * 4 + 3] = 1
	}
	return out
}
