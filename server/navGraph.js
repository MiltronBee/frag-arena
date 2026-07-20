// Runtime navigation graph for the bots — the map's OWN UT99 ReachSpec graph, baked to
// public/assets/maps/<Map>/<Map>.nav.json (see _work/astar/bake-nav.mjs) and loaded here.
//
// This is SERVER-ONLY (bots are server-only; the client never pathfinds), so it lives in
// server/ and reads the baked file straight off disk, exactly the way GameInstance loads
// the collision OBJ. The baked coordinates are in the game's NATIVE {x,z,y} space (same as
// mapMesh.js spawns); we scale them to world by MAP_MESH.scale here, once, at load — so the
// bot works purely in world units and no per-tick scaling is needed.
//
// Fit: the recovered edges carry the ReachSpec radius/height (the widest pawn that fits the
// connection). We drop any edge our player collider can't fit, and drop 'special' edges
// (teleporter / translocator / lift links) a steering bot can't traverse. What survives is
// a graph every waypoint of which is real floor the bot can walk to.
import fs from 'fs'
import { MAP_MESH } from '../common/mapMesh'

// Player collider = PlayerCharacter's ellipsoid (0.5, 0.5, 0.5) world units: horizontal
// radius 0.5, half-height 0.5. An edge must clear both (its native radius/height scaled to
// world) or the bot would wedge. Kept in sync with common/entity/PlayerCharacter.js.
const PLAYER_RADIUS = 0.5
const PLAYER_HALF_HEIGHT = 0.5

// map filename convention: the OBJ's basename with .nav.json (CTF-Visage.obj -> CTF-Visage.nav.json)
const navPathFor = (map) => 'public' + map.dir + map.file.replace(/\.obj$/i, '.nav.json')

// One graph per active map. Built lazily on first request, cached forever (the active map
// never changes at runtime — USE_MESH_MAP / MAP_MESH are fixed).
let cache // undefined = not tried, null = tried & unavailable, object = ready

const build = (map) => {
	const file = navPathFor(map)
	let data
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch (e) {
		console.log(`[bot-nav] no baked nav graph for ${map.file} (${file}) — bots use probe fallback`)
		return null
	}
	const sc = map.scale || 1
	// nodes -> world coords
	const nodes = data.nodes.map(n => ({
		x: n.x * sc, y: n.y * sc, z: n.z * sc,
		pickup: !!n.pickup, cls: n.cls,
	}))
	const N = nodes.length
	// fitted, directed adjacency. edge = [from,to,dist,radius,height,jump,special]
	const adj = Array.from({ length: N }, () => [])
	const rNeed = PLAYER_RADIUS, hNeed = PLAYER_HALF_HEIGHT
	let kept = 0, dropped = 0
	for (const [from, to, dist, radius, height, jump, special] of data.edges) {
		if (special) { dropped++; continue }               // bot can't take a teleporter/lift link
		if (radius * sc < rNeed || height * sc < hNeed) { dropped++; continue } // bot doesn't fit
		adj[from].push({ to, dist: dist * sc, jump: !!jump })
		kept++
	}
	const pickups = []
	for (let i = 0; i < N; i++) if (nodes[i].pickup && adj[i].length) pickups.push(i)
	console.log(`[bot-nav] ${map.file}: ${N} nodes, ${kept} traversable edges (${dropped} dropped: unfit/special), ${pickups.length} reachable pickups`)
	return { nodes, adj, pickups, N }
}

export const getNavGraph = () => {
	if (cache !== undefined) return cache
	cache = build(MAP_MESH)
	return cache
}

// Nearest graph node to a world point, restricted to nodes that HAVE traversable edges
// (an isolated node is a dead end for A*). Horizontal distance dominates; a modest y term
// keeps a bot on the lower deck from snapping to a node directly above it.
export const nearestNode = (g, x, y, z) => {
	let best = -1, bestD = Infinity
	const nodes = g.nodes, adj = g.adj
	for (let i = 0; i < g.N; i++) {
		if (adj[i].length === 0) continue
		const n = nodes[i]
		const dx = n.x - x, dz = n.z - z, dy = n.y - y
		const d = dx * dx + dz * dz + dy * dy * 4
		if (d < bestD) { bestD = d; best = i }
	}
	return best
}

// A* over the fitted graph. Returns an array of node indices [start..goal] or null if the
// goal is unreachable (disconnected component -> caller falls back to steering). Straight
// 3-D Euclidean heuristic; edge dist is the recovered ReachSpec length (world units), which
// agrees with node-to-node Euclidean distance to ~0.14% on Visage, so h never overestimates.
export const aStar = (g, start, goal) => {
	if (start < 0 || goal < 0) return null
	if (start === goal) return [start]
	const nodes = g.nodes, adj = g.adj, N = g.N
	const gx = nodes[goal].x, gy = nodes[goal].y, gz = nodes[goal].z
	const h = (i) => {
		const n = nodes[i], dx = n.x - gx, dy = n.y - gy, dz = n.z - gz
		return Math.sqrt(dx * dx + dy * dy + dz * dz)
	}
	const gScore = new Float64Array(N).fill(Infinity)
	const came = new Int32Array(N).fill(-1)
	const closed = new Uint8Array(N)
	gScore[start] = 0
	// binary min-heap of [f, node]
	const heap = [[h(start), start]]
	const push = (f, n) => {
		heap.push([f, n]); let i = heap.length - 1
		while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p }
	}
	const pop = () => {
		const top = heap[0], last = heap.pop()
		if (heap.length) {
			heap[0] = last; let i = 0
			for (;;) {
				const l = 2 * i + 1, r = l + 1; let s = i
				if (l < heap.length && heap[l][0] < heap[s][0]) s = l
				if (r < heap.length && heap[r][0] < heap[s][0]) s = r
				if (s === i) break;[heap[s], heap[i]] = [heap[i], heap[s]]; i = s
			}
		}
		return top
	}
	while (heap.length) {
		const [, u] = pop()
		if (u === goal) {
			const path = [u]; let c = u
			while ((c = came[c]) !== -1) path.push(c)
			return path.reverse()
		}
		if (closed[u]) continue
		closed[u] = 1
		const edges = adj[u]
		for (let k = 0; k < edges.length; k++) {
			const e = edges[k]
			if (closed[e.to]) continue
			const ng = gScore[u] + e.dist
			if (ng < gScore[e.to]) { gScore[e.to] = ng; came[e.to] = u; push(ng + h(e.to), e.to) }
		}
	}
	return null
}
