import * as BABYLON from '../babylon.js'
import createPlayerFactory from './createPlayerFactory'
import createObstacleFactory from './createObstacleFactory'
import { loadPropTemplate } from '../graphics/CharacterModel'

// Real thrown-grenade model (Quaternius sci-fi prop). Loaded lazily from the
// warm cache the preloader primes, cloned per grenade, parented to the entity's
// position-holder sphere. See attachGrenadeModel below.
const GRENADE_MODEL_URL = '/assets/props/Prop_Grenade.gltf'
// Target largest world-dimension for the clone: matches the 0.22-diameter sphere
// the model replaces so it reads as the same small thrown pebble. Tune here after
// a live playtest if the grenade looks too big/small in hand or in the air.
const GRENADE_MODEL_SIZE = 0.22

// Phase 4 MEGA-HEALTH pickup model (Quaternius health-pack prop). Same warm-cache
// clone pipeline as the grenade. Sized larger so the contested power item reads
// clearly across the arena; tune after a live playtest.
const HEALTH_MODEL_URL = '/assets/props/Prop_HealthPack.gltf'
const HEALTH_MODEL_SIZE = 0.8

// Attach the real grenade model to `entity.mesh` (the positioned sphere holder).
// Async: a grenade lives ~1.8s and can be deleted before this resolves, so we
// re-check entity._disposed / mesh liveness after the await and bail (disposing
// the freshly-cloned model) if it was already deleted. Never touches a disposed
// mesh. The placeholder sphere BODY is hidden (kept as the position holder); the
// parented 'grenadeLight' + entity.lightMat survive untouched so the fuse blink
// in Simulator._updateGrenades keeps working.
async function attachGrenadeModel(entity) {
	const scene = BABYLON.Engine.LastCreatedScene
	if (!scene || scene.getEngine().name === 'NullEngine') return
	const { root } = await loadPropTemplate(scene, GRENADE_MODEL_URL)
	// async-delete guard: the grenade may have detonated during the await
	if (!entity || entity._disposed || !entity.mesh || entity.mesh.isDisposed()) return

	const clone = root.clone('grenadeModel', entity.mesh)
	clone.setEnabled(true)
	clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
	clone.isPickable = false

	// AUTO-SCALE + CENTER: the template GLB is authored at its own real-world
	// scale, so measure its combined local bounding box and scale the clone so its
	// largest dimension ~= GRENADE_MODEL_SIZE, then offset it so the model's bbox
	// center sits on the entity origin (the tracked position). Uses the template's
	// (identity-transform) meshes so the extents are in the clone's local space.
	let min = null
	let max = null
	const srcMeshes = [root, ...root.getChildMeshes()].filter((m) => m.getBoundingInfo)
	srcMeshes.forEach((m) => {
		const bb = m.getBoundingInfo().boundingBox
		const lo = bb.minimum
		const hi = bb.maximum
		if (!min) { min = lo.clone(); max = hi.clone() }
		min = BABYLON.Vector3.Minimize(min, lo)
		max = BABYLON.Vector3.Maximize(max, hi)
	})
	if (min && max) {
		const size = max.subtract(min)
		const maxDim = Math.max(size.x, size.y, size.z) || 1
		const scale = GRENADE_MODEL_SIZE / maxDim
		clone.scaling.setAll(scale)
		const center = min.add(max).scaleInPlace(0.5)
		clone.rotationQuaternion = null
		clone.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
	}

	// re-check liveness once more (clone() + measurements are sync, but be safe)
	if (entity._disposed || entity.mesh.isDisposed()) { clone.dispose(false, true); return }

	// hide the placeholder sphere body but KEEP it as the positioned parent/holder
	// (entity.x/y/z proxy to entity.mesh.position). The arming light child stays lit.
	if (entity.mesh.material) entity.mesh.material.alpha = 0
	entity._grenadeModel = clone
}

// Attach the real health-pack model to the mega-health pickup's `entity.mesh`
// (the positioned placeholder box). MIRRORS attachGrenadeModel: async, with the
// same async-delete guard (the entity could be removed before the clone resolves),
// auto-scale-from-bbox + center-on-origin. The placeholder box body is hidden but
// kept as the position holder. Stores the clone as entity._healthModel so the
// per-frame bob/spin drive (Simulator._updateMegaHealth) can rotate it.
async function attachHealthModel(entity) {
	const scene = BABYLON.Engine.LastCreatedScene
	if (!scene || scene.getEngine().name === 'NullEngine') return
	const { root } = await loadPropTemplate(scene, HEALTH_MODEL_URL)
	if (!entity || entity._disposed || !entity.mesh || entity.mesh.isDisposed()) return

	const clone = root.clone('healthModel', entity.mesh)
	clone.setEnabled(true)
	clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
	clone.isPickable = false

	// AUTO-SCALE + CENTER from the template's combined bounding box (identical to
	// attachGrenadeModel — see its comment) so the largest dimension ~= HEALTH_MODEL_SIZE.
	let min = null
	let max = null
	const srcMeshes = [root, ...root.getChildMeshes()].filter((m) => m.getBoundingInfo)
	srcMeshes.forEach((m) => {
		const bb = m.getBoundingInfo().boundingBox
		const lo = bb.minimum
		const hi = bb.maximum
		if (!min) { min = lo.clone(); max = hi.clone() }
		min = BABYLON.Vector3.Minimize(min, lo)
		max = BABYLON.Vector3.Maximize(max, hi)
	})
	if (min && max) {
		const size = max.subtract(min)
		const maxDim = Math.max(size.x, size.y, size.z) || 1
		const scale = HEALTH_MODEL_SIZE / maxDim
		clone.scaling.setAll(scale)
		const center = min.add(max).scaleInPlace(0.5)
		clone.rotationQuaternion = null
		clone.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
	}

	if (entity._disposed || entity.mesh.isDisposed()) { clone.dispose(false, true); return }

	// hide the placeholder box body but KEEP it as the positioned parent/holder
	if (entity.mesh.material) entity.mesh.material.alpha = 0
	entity._healthModel = clone
}

export default ({ simulator /* inject depenencies here */ }) => {
	return {
		'PlayerCharacter': createPlayerFactory({ simulator, /* inject depenencies here */ }),
		'Obstacle': createObstacleFactory({ simulator }),
		// A FACTORY OBJECT, not a function: nengi calls factory.create/.delete
		// directly (see niceClientExtension). Registering the bare arrow left
		// factory.create/.delete undefined -> "factory.create is not a function"
		// for every replicated projectile (Plasma Rifle). The projectile's sphere
		// mesh is built in the Projectile constructor and auto-added to the scene,
		// so create() is a no-op; delete() disposes it (guarded against a
		// double-delete leaving a disposed/absent mesh).
		'Projectile': {
			create({ data, entity }) {
				// track the bolt so the Simulator can orient + stretch it into a hot
				// travel streak each frame (presentation only)
				simulator.registerProjectile(entity)
			},
			delete({ nid, entity }) {
				// emit a pooled energetic impact + positional zap where the bolt ended,
				// then stop tracking it
				simulator.unregisterProjectile(nid)
				// dispose(doNotRecurse=false, disposeMaterialAndTextures=true): the
				// Projectile constructor builds fresh StandardMaterials per shot (core +
				// glow), so a bare mesh.dispose() (materials default OFF) leaks one per
				// bolt. Recursing also disposes the parented glow child + its material.
				// The headless placeholder mesh ignores args.
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose(false, true)
				}
			}
		},
		// Phase 3 THROWN FRAG GRENADE. The pebble mesh is built in the Grenade
		// constructor (auto-added to the scene), so create() just registers it for the
		// client-side fuse blink; delete() (server removes the entity on detonation)
		// fires the explosion FX + boom at its last position, mirroring Projectile.
		'Grenade': {
			create({ data, entity }) {
				simulator.registerGrenade(entity)
				// swap the placeholder sphere for the real Quaternius grenade model
				// (async; guarded against the grenade detonating before it resolves).
				attachGrenadeModel(entity)
			},
			delete({ nid, entity }) {
				// blast FX + boom where the grenade detonated, then stop tracking it
				simulator.unregisterGrenade(nid)
				// async-delete guard: flag the entity so a still-pending
				// attachGrenadeModel() bails instead of mounting onto a disposed mesh.
				if (entity) entity._disposed = true
				// dispose recursively + free the per-grenade StandardMaterials (body +
				// arming light) AND the parented real-model clone (it hangs off entity.mesh,
				// so dispose(false, true) recurses into it), same reasoning as Projectile.
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose(false, true)
				}
			}
		},
		// Phase 4 MEGA-HEALTH pickup. The placeholder box is built in the entity
		// constructor (auto-added to the scene); create() registers it for the
		// per-frame bob/spin/glow + hum-tell drive (Simulator._updateMegaHealth,
		// which reacts to the networked `state`) and swaps in the real health-pack
		// model. delete() (only on server shutdown — the pickup persists all match,
		// hiding via `state`, not deletion) disposes the mesh + stops its hum.
		'MegaHealthPickup': {
			create({ data, entity }) {
				simulator.registerMegaHealth(entity)
				attachHealthModel(entity)
			},
			delete({ nid, entity }) {
				simulator.unregisterMegaHealth(nid)
				if (entity) entity._disposed = true
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose(false, true)
				}
			}
		}
	}
}
