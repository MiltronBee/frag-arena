import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF loader with SceneLoader
import { ARENA_SIZE, SPAWN_POINTS } from '../../common/arenaConfig'

// Cosmetic arena skin built from the Quaternius Modular SciFi MegaKit (CC0,
// public/assets/scifi/). The server's collision boxes stay authoritative and
// pickable — they just render invisible once the kit dressing is attached, so
// netcode, hit rays, and movement are untouched. Every piece is loaded ONCE,
// then stamped as instances (draw calls stay at ~one per source submesh no
// matter how many tiles the arena needs).
//
// Kit pieces are authored on a 4m grid at meter scale, which matches arena
// units exactly (ARENA_SIZE 44 = 11 floor tiles).

const BASE = '/assets/scifi/'
const TILE = 4
const GROUND_Y = -1 // visual floor level (player feet); collision boxes bottom out at -0.5

const PIECES = [
	'Platform_Metal',
	'Platform_DarkPlates',
	'WallAstra_Straight',
	'ShortWall_MetalPlates_Straight',
	'Column_Hollow',
	'Prop_Fan_Small',
	'Prop_Crate4',
	'Prop_Light_Floor'
]

export default class ArenaDressing {
	constructor(scene, shadowGenerator) {
		this.scene = scene
		this.shadowGenerator = shadowGenerator
		this.enabled = true
		this._pieces = new Map() // name -> { entries, min, max, size, center }
		this._nodes = new Map() // obstacle nid -> [TransformNode]
		this._dead = new Set() // nids deleted while assets were still loading
		this._matCache = new Map()
		this._texCache = new Map()
		this._count = 0
		this._ready = this._loadAll()
			.then(() => true)
			.catch(err => {
				// keep the legacy box-material look if the kit fails to load
				this.enabled = false
				console.warn('[arenaDressing] load failed, keeping legacy look', err)
				return false
			})
	}

	async _loadAll() {
		// the emissive strip texture isn't wired in the kit's glTF materials;
		// invertY=false matches the loader's glTF UV convention
		this._trimEmissive = new BABYLON.Texture(BASE + 'T_Trim_01_Emissive.png', this.scene, false, false)
		// STAGGER the piece imports. Every kit .gltf references the SAME shared
		// trim-sheet textures (T_Trim_01/02_ORM etc.), and the browser CANNOT dedupe
		// identical requests fired in parallel — a plain Promise.all fetched each
		// multi-MB texture once PER piece (6x in the live waterfall). So we load ONE
		// piece fully first, which warms all the shared trim textures into the HTTP
		// cache; the remaining pieces then load with the existing concurrency and hit
		// that cache instead of re-fetching. WallAstra_Straight is the pick because it
		// references BOTH T_Trim_01_ORM and T_Trim_02_ORM (the two 6x-duplicated maps)
		// plus the Trim_03 sheet — one sequential load warms the whole shared set.
		const FIRST = 'WallAstra_Straight'
		const rest = PIECES.filter(name => name !== FIRST)
		if (PIECES.includes(FIRST)) await this._loadPiece(FIRST)
		await Promise.all(rest.map(name => this._loadPiece(name)))
		this._buildStatic()
	}

	async _loadPiece(name) {
		const result = await BABYLON.SceneLoader.ImportMeshAsync('', BASE, name + '.gltf', this.scene)
		const root = result.meshes.find(m => !m.parent) || result.meshes[0]
		root.computeWorldMatrix(true)
		const bounds = root.getHierarchyBoundingVectors(true)
		const geo = result.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
		const entries = geo.map(m => {
			m.material = this._convertMaterial(m.material)
			m.isVisible = false // instance source: never rendered itself
			m.isPickable = false
			m.receiveShadows = true
			const pos = new BABYLON.Vector3()
			const rot = new BABYLON.Quaternion()
			const scale = new BABYLON.Vector3()
			// bake the full world matrix (including the loader's RH->LH root fix)
			// into each instance so handedness/winding survives reparenting
			m.computeWorldMatrix(true).decompose(scale, rot, pos)
			return { src: m, pos, rot, scale }
		})
		const size = bounds.max.subtract(bounds.min)
		const center = bounds.min.add(bounds.max).scale(0.5)
		this._pieces.set(name, { entries, min: bounds.min, max: bounds.max, size, center })
	}

	// The kit ships PBR materials, but the scene's art direction (and mobile GPU
	// budget) is StandardMaterial + dusk lights. Convert once per material name so
	// every piece shares the same few trim-sheet materials.
	_convertMaterial(mat) {
		if (!mat) return null
		const cached = this._matCache.get(mat.name)
		if (cached) {
			this._reclaimTextures(mat)
			mat.dispose()
			return cached
		}
		const std = new BABYLON.StandardMaterial('scifi_' + mat.name, this.scene)
		std.diffuseTexture = this._tex(mat.albedoTexture)
		std.bumpTexture = this._tex(mat.bumpTexture)
		if (std.bumpTexture) {
			std.invertNormalMapX = !!mat.invertNormalMapX
			std.invertNormalMapY = !!mat.invertNormalMapY
		}
		if (!std.diffuseTexture && mat.albedoColor) {
			std.diffuseColor = mat.albedoColor.clone()
		}
		std.specularColor = new BABYLON.Color3(0.07, 0.07, 0.08)
		if (mat.emissiveTexture) {
			std.emissiveTexture = this._tex(mat.emissiveTexture)
		} else if (mat.emissiveColor && mat.emissiveColor.r + mat.emissiveColor.g + mat.emissiveColor.b > 0.01) {
			std.emissiveColor = mat.emissiveColor.clone() // light lenses (M_Light)
		}
		if (mat.name === 'MI_Trim_01') std.emissiveTexture = this._trimEmissive
		// drop the PBR-only maps we don't use
		if (mat.metallicTexture) mat.metallicTexture.dispose()
		mat.dispose()
		this._matCache.set(mat.name, std)
		return std
	}

	_tex(t) {
		if (!t) return null
		const key = t.url || t.name
		if (!key) return t
		const hit = this._texCache.get(key)
		if (hit && hit !== t) {
			t.dispose()
			return hit
		}
		this._texCache.set(key, t)
		return t
	}

	_reclaimTextures(mat) {
		const dupes = [mat.albedoTexture, mat.bumpTexture, mat.emissiveTexture, mat.metallicTexture]
		dupes.forEach(t => {
			if (t && this._texCache.get(t.url || t.name) !== t) t.dispose()
		})
	}

	// Stamp one placement of a piece. w/h/d are target dims along the piece's
	// LOCAL axes (pre-rotation); unspecified axes reuse the mean specified scale
	// so props keep their proportions. The piece footprint is centered on x/z
	// with its base resting at y.
	_place(name, { x, z, y = GROUND_Y, rotY = 0, w, h, d, cast = true }) {
		const piece = this._pieces.get(name)
		const node = new BABYLON.TransformNode('dress_' + name + '_' + this._count++, this.scene)
		const axis = (target, natural) => (target !== undefined && natural > 0.01 ? target / natural : null)
		const sx = axis(w, piece.size.x)
		const sy = axis(h, piece.size.y)
		const sz = axis(d, piece.size.z)
		const given = [sx, sy, sz].filter(s => s !== null)
		const fallback = given.length ? given.reduce((a, b) => a + b, 0) / given.length : 1
		node.scaling.set(sx === null ? fallback : sx, sy === null ? fallback : sy, sz === null ? fallback : sz)
		node.rotation.y = rotY
		node.position.set(x, y, z)
		const anchor = new BABYLON.TransformNode(node.name + '_a', this.scene)
		anchor.parent = node
		anchor.position.set(-piece.center.x, -piece.min.y, -piece.center.z)
		const shadowList = this.shadowGenerator ? this.shadowGenerator.getShadowMap().renderList : null
		piece.entries.forEach(e => {
			const inst = e.src.createInstance(node.name + '_i')
			inst.parent = anchor
			inst.position = e.pos.clone()
			inst.rotationQuaternion = e.rot.clone()
			inst.scaling = e.scale.clone()
			inst.isPickable = false
			inst.checkCollisions = false
			inst.metadata = { fragSurface: 'metal' }
			if (cast && shadowList) shadowList.push(inst)
			inst.computeWorldMatrix(true)
			inst.freezeWorldMatrix() // static scenery: skip per-frame matrix updates
		})
		return node
	}

	// Floor tiles + spawn-pad lights. Obstacle-independent, built once at load.
	_buildStatic() {
		const half = ARENA_SIZE / 2
		for (let x = -half + TILE / 2; x < half; x += TILE) {
			for (let z = -half + TILE / 2; z < half; z += TILE) {
				const ring = Math.max(Math.abs(x), Math.abs(z)) > half - TILE
				const spin = ((Math.abs(x * 7 + z * 3) / TILE) | 0) % 4 // deterministic variety
				this._place(ring ? 'Platform_DarkPlates' : 'Platform_Metal', {
					x, z, w: TILE, d: TILE, rotY: spin * Math.PI / 2, cast: false
				})
			}
		}
		SPAWN_POINTS.forEach(p => {
			this._place('Prop_Light_Floor', {
				x: p.x, z: p.z, rotY: Math.atan2(-p.x, -p.z), cast: false
			})
		})
	}

	// Called by the obstacle factory for every spawned obstacle entity. Resolves
	// once assets are in; returns true when the box was successfully re-skinned.
	async attachObstacle(entity) {
		const ok = await this._ready
		if (!ok || !this.enabled) return false
		const nid = entity.nid
		if (this._dead.has(nid) || !entity.mesh || entity.mesh.isDisposed()) {
			this._dead.delete(nid)
			return false
		}
		const nodes = this._buildObstacle(entity)
		if (!nodes.length) return false
		this._nodes.set(nid, nodes)
		// hide the collision box but KEEP it pickable — hit rays and surface FX
		// must land exactly on server collision, not on the cosmetic shell
		entity.mesh.visibility = 0
		entity.mesh.renderOutline = false
		const cosmetics = (entity.mesh.metadata && entity.mesh.metadata.cosmetics) || []
		cosmetics.forEach(c => c.dispose())
		entity.mesh.metadata = { cosmetics: [], fragSurface: 'metal' }
		return true
	}

	_buildObstacle(entity) {
		const { x, z, width: w, height: h, depth: d, style } = entity
		const top = entity.y + h / 2
		const H = top - GROUND_Y // dressing fills down to the visual floor
		const horiz = w >= d // long axis along world X?
		const len = horiz ? w : d
		const across = horiz ? d : w

		if (style === 1) return this._buildPerimeter(x, z, len, across, horiz, top)

		if (style === 2) {
			// reactor: squat hollow column housing with a slow-fan cap
			return [
				this._place('Column_Hollow', { x, z, w, h: H, d }),
				this._place('Prop_Fan_Small', { x, z, y: top, w: w * 0.8, d: d * 0.8 })
			]
		}

		if (style === 3) {
			return [this._place('Column_Hollow', { x, z, w, h: H, d })]
		}

		// style 0 cover: a pair of heavy crates filling the collision box
		const nodes = []
		const seg = len / 2
		for (let i = -1; i <= 1; i += 2) {
			const off = i * len / 4
			nodes.push(this._place('Prop_Crate4', {
				x: horiz ? x + off : x,
				z: horiz ? z : z + off,
				w: horiz ? seg * 0.96 : across,
				h: H,
				d: horiz ? across : seg * 0.96
			}))
		}
		return nodes
	}

	_buildPerimeter(x, z, len, across, horiz, top) {
		const nodes = []
		const count = Math.max(1, Math.round(len / TILE))
		const tileLen = len / count
		// face the greebled side toward the arena center (piece front = local +X)
		const fx = horiz ? 0 : (x > 0 ? -1 : 1)
		const fz = horiz ? (z > 0 ? -1 : 1) : 0
		const rotY = Math.atan2(-fz, fx)
		// wall body (natural 3m) plus a 1m plate band caps out exactly at the
		// collision top, so shots clear the visual wall where they clear the real one
		const bandH = 1
		const wallH = top - GROUND_Y - bandH
		for (let i = 0; i < count; i++) {
			const off = -len / 2 + tileLen * (i + 0.5)
			const px = horiz ? x + off : x
			const pz = horiz ? z : z + off
			nodes.push(this._place('WallAstra_Straight', {
				x: px, z: pz, rotY, h: wallH, d: tileLen, w: across
			}))
			nodes.push(this._place('ShortWall_MetalPlates_Straight', {
				x: px, z: pz, y: GROUND_Y + wallH, rotY, h: bandH, d: tileLen
			}))
		}
		return nodes
	}

	detachObstacle(nid) {
		const nodes = this._nodes.get(nid)
		if (nodes) {
			nodes.forEach(n => n.dispose())
			this._nodes.delete(nid)
		} else {
			this._dead.add(nid) // deleted before assets finished loading
		}
	}
}
