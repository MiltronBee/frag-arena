import * as BABYLON from '../babylon.js'
import createPlayerFactory from './createPlayerFactory'
import createObstacleFactory from './createObstacleFactory'
import { loadPropTemplate } from '../graphics/CharacterModel'
import {
	PICKUP_TYPE,
	WEAPON_MODEL_URL,
	PEDESTAL_MODEL_URL,
	AMMO_MODEL_URL,
	HEALTH_MODEL_URL as PICKUP_HEALTH_MODEL_URL,
} from '../../common/pickupConfig'

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

// ── UT-STYLE PICKUP models ───────────────────────────────────────────────────────
// Per-type model spec for a Pickup entity (common/pickupConfig.js PICKUP_TYPE). Weapon
// pickups pick a third-person weapon silhouette by roster index and get a metal pedestal
// beneath them. Armor/powerup are v1-DEFERRED (no bespoke asset) — they keep the entity
// constructor's cyan placeholder box so the item is still visible on the map.
function pickupModelSpec(type, weaponIndex) {
	switch (type) {
		case PICKUP_TYPE.WEAPON: return { url: WEAPON_MODEL_URL[weaponIndex] || WEAPON_MODEL_URL[3], size: 0.9, pedestal: false }
		case PICKUP_TYPE.HEALTH: return { url: PICKUP_HEALTH_MODEL_URL, size: 0.7, pedestal: false }
		case PICKUP_TYPE.AMMO:   return { url: AMMO_MODEL_URL, size: 0.5, pedestal: false }
		default:                 return null // ARMOR / POWERUP — leave the placeholder box
	}
}

// Shared auto-scale-from-bbox + center-on-origin (the same math attachGrenade/HealthModel
// use): scale the clone so its largest dimension ≈ targetSize, then offset so its bbox
// centre sits on the entity origin (the tracked position).
function fitClone(clone, srcRoot, targetSize) {
	let min = null, max = null
	const srcMeshes = [srcRoot, ...srcRoot.getChildMeshes()].filter((m) => m.getBoundingInfo)
	srcMeshes.forEach((m) => {
		const bb = m.getBoundingInfo().boundingBox
		if (!min) { min = bb.minimum.clone(); max = bb.maximum.clone() }
		min = BABYLON.Vector3.Minimize(min, bb.minimum)
		max = BABYLON.Vector3.Maximize(max, bb.maximum)
	})
	if (min && max) {
		const size = max.subtract(min)
		const maxDim = Math.max(size.x, size.y, size.z) || 1
		const scale = targetSize / maxDim
		clone.scaling.setAll(scale)
		const center = min.add(max).scaleInPlace(0.5)
		clone.rotationQuaternion = null
		clone.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
	}
}

// ── PICKUP READABILITY ("weapon pickups are grey") ───────────────────────────────
// The tp_* weapon GLBs are NOT untextured — each ships a baked baseColour atlas. The
// problem is the atlas is near-black gunmetal (tp_rifle's mean pixel is RGB 23,23,21),
// and pickupConfig deliberately rests weapons FLAT on the floor with no spin and no bob
// (REST_HEIGHT 0.1, design note #38). A black prop lying flat on a dark arena floor,
// lit only by the scene's dim ambient, reads as an unlit grey smudge — which is exactly
// what "grey" describes.
//
// Fix WITHOUT touching the flat-rest design decision or repainting the atlases: make the
// pickup SELF-LIT off its own albedo. This is the same recipe CharacterModel uses for the
// uniforms (emissiveTexture = the albedo texture, scaled by a dim emissiveColor), so the
// prop's real detail survives darkness instead of being flattened to a silhouette. A tight
// specular adds the metal glint that tells the eye "this is a weapon, pick it up".
//
// Materials are SHARED with the warm-cache template (root.clone() shares them), so this
// runs once per material and is guarded by a marker — every later clone of the same
// weapon inherits the already-lit material for free.
const PICKUP_SELF_LIT = 0.34   // emissive scale on the prop's own albedo
function litPickupMaterials(root) {
  const meshes = [root, ...root.getChildMeshes()]
  meshes.forEach((m) => {
    const mat = m.material
    if (!mat || mat._pickupLit) return
    mat._pickupLit = true
    // The self-lit pass below is not enough on its own for the weapon props: they ship
    // metallic=1 from glTF, and with no scene environmentTexture a metal has nothing to
    // reflect, so the albedo never reaches the screen. Drop the metalness first (see
    // CharacterModel._fixUnlitMetal, same fix for the in-hand copy of these guns).
    if ('metallic' in mat && typeof mat.metallic === 'number' && mat.metallic > 0.35) mat.metallic = 0.25
    if ('metallicTexture' in mat && mat.metallicTexture) mat.metallicTexture = null
    // PBR (glTF) path: re-use the albedo as the emissive so the self-lit pass keeps the
    // painted detail rather than washing the prop to a flat colour.
    if ('emissiveTexture' in mat) {
      if (mat.albedoTexture) mat.emissiveTexture = mat.albedoTexture
      if (mat.emissiveColor) mat.emissiveColor.set(PICKUP_SELF_LIT, PICKUP_SELF_LIT, PICKUP_SELF_LIT)
      // a touch less rough so the sun actually glints off the barrel
      if (typeof mat.roughness === 'number') mat.roughness = Math.min(mat.roughness, 0.55)
    } else if (mat.emissiveColor) {
      // StandardMaterial fallback (no PBR slots): flat self-lit wash
      mat.emissiveColor.set(PICKUP_SELF_LIT, PICKUP_SELF_LIT, PICKUP_SELF_LIT)
    }
  })
}

// Attach a Pickup's real model (+ optional pedestal) to entity.mesh (the positioned
// placeholder box). MIRRORS attachHealthModel: async warm-cache clone, async-delete
// guard, auto-scale + center, hide the placeholder box. Stores the spinnable item model
// as entity._pickupModel so Simulator._updatePickups can spin it (the holder bobs).
async function attachPickupModel(entity, spec) {
	const scene = BABYLON.Engine.LastCreatedScene
	if (!scene || scene.getEngine().name === 'NullEngine') return

	// pedestal first (a static base under the floating item)
	if (spec.pedestal) {
		try {
			const { root: pRoot } = await loadPropTemplate(scene, PEDESTAL_MODEL_URL)
			if (!entity || entity._disposed || !entity.mesh || entity.mesh.isDisposed()) return
			const ped = pRoot.clone('pickupPedestal', entity.mesh)
			ped.setEnabled(true)
			ped.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
			ped.isPickable = false
			fitClone(ped, pRoot, 1.1)
			ped.position.y -= 0.55 // drop it beneath the floating weapon
			entity._pedestal = ped
		} catch (e) { /* pedestal is decorative — a load miss must not break the pickup */ }
	}

	const { root } = await loadPropTemplate(scene, spec.url)
	if (!entity || entity._disposed || !entity.mesh || entity.mesh.isDisposed()) return
	const clone = root.clone('pickupModel', entity.mesh)
	clone.setEnabled(true)
	clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
	clone.isPickable = false
	fitClone(clone, root, spec.size)
	// make it read on a dark floor (see litPickupMaterials) — applied to the TEMPLATE's
	// shared materials, so it costs one pass per weapon type, not one per pickup.
	litPickupMaterials(root)
	if (entity._disposed || entity.mesh.isDisposed()) { clone.dispose(false, true); return }
	if (entity.mesh.material) entity.mesh.material.alpha = 0 // hide the placeholder box
	entity._pickupModel = clone
}

// ── LIFT (Mover) SKIN ────────────────────────────────────────────────────────────
// The Mover entity ships a plain grey StandardMaterial (common/entity/Mover.js) because
// that file is SHARED with the headless server: `Texture` lives only in the CLIENT
// Babylon barrel (client/babylon.js), and pulling it into common/babylon.node.js would
// drag a render-only module into the server bundle — exactly what that barrel's header
// forbids. So the lift's real skin is applied HERE, client-side, where Texture is legal.
//
// Assets: scripts/make-lift-texture.py authors a SEAMLESS industrial tread-plate albedo
// + matching normal map (flat albedo — the scene owns lighting; the relief is carried by
// the bump map, per the map-pipeline rule).
const LIFT_ALBEDO_URL = '/assets/props/lift_deck.webp'
const LIFT_NORMAL_URL = '/assets/props/lift_deck_n.webp'
// World units per texture repeat. The plate is authored ~7 studs across, so 1.5 puts
// roughly 5 studs per metre — reads as real tread plate at player scale instead of as
// stretched wallpaper.
const LIFT_TILE = 1.5

// Materials are cached per QUANTIZED mover footprint. UV scale lives on the Texture (not
// the material) in Babylon, so a per-mover tiling would mean a per-mover Texture — N GPU
// uploads of the same image. Quantizing the footprint means every same-sized lift on a map
// (the normal case: a map's lifts are built from one prefab) shares ONE material + ONE
// texture, while a differently-sized lift still gets correct texel density.
const _liftMats = new Map()

function liftMaterial(scene, width, depth) {
  // 0.5-unit buckets: fine enough that density never visibly drifts, coarse enough that
  // near-identical lifts collapse to one entry.
  const key = `${Math.round(width * 2) / 2}x${Math.round(depth * 2) / 2}`
  const hit = _liftMats.get(key)
  if (hit) return hit

  const mat = new BABYLON.StandardMaterial('liftMat_' + key, scene)
  const uScale = Math.max(1, width / LIFT_TILE)
  const vScale = Math.max(1, depth / LIFT_TILE)

  // noMipmap=false, invertY=false — the same convention CharacterModel._teamTexture and
  // the flag skin swap use, so this texture orients like every other one in the project.
  const alb = new BABYLON.Texture(LIFT_ALBEDO_URL, scene, false, false)
  alb.uScale = uScale; alb.vScale = vScale
  mat.diffuseTexture = alb

  const nrm = new BABYLON.Texture(LIFT_NORMAL_URL, scene, false, false)
  nrm.uScale = uScale; nrm.vScale = vScale
  mat.bumpTexture = nrm
  // the plate's relief is shallow machined tread, not deep rock — keep the normal subtle
  // so the sun sculpts it without making the deck look like crumpled foil.
  mat.bumpTexture.level = 0.6

  // A lift is dirty painted steel: a tight, dim specular so the sun glints off the stud
  // crowns without turning the deck into chrome.
  mat.specularColor = new BABYLON.Color3(0.22, 0.23, 0.25)
  mat.specularPower = 48
  // Keep the v1 "powered lift" read: a dim self-lit floor so the platform stays legible
  // in the dark shafts it runs in. Much lower than the old flat-grey emissive (0.12-0.18)
  // because the albedo now carries the material — a high emissive would wash the tread out.
  mat.emissiveColor = new BABYLON.Color3(0.05, 0.055, 0.065)
  _liftMats.set(key, mat)
  return mat
}

// Real UT99 CTF flag model (extracted glTF): a pole + morph-animated cloth that
// waves via the ONE `flag_wave` animation group. The GLB ships an OLD blue skin in its
// material; both teams now swap to a Solana meme-coin banner (same-UV WebP), so the
// baked skin is never shown. Team 0 = BONK (orange), team 1 = WIF (pink). Assets are
// composited from the REAL on-chain token logos by scripts/compose-memecoin-crest.py.
const FLAG_MODEL_URL = '/assets/props/Prop_Flag.glb'
// index = teamId. team 0 (red base) flies BONK, team 1 (blue base) flies WIF.
const FLAG_TEAM_SKIN_URL = [
	'/assets/props/Prop_Flag_bonk.webp',
	'/assets/props/Prop_Flag_wif.webp',
]

// Attach the real flag model to `entity.mesh` (the positioned placeholder box).
// MIRRORS attachPickupModel (async warm import, async-delete guard, hide the box)
// with ONE deliberate difference: a FRESH SceneLoader.ImportMeshAsync per flag
// instead of loadPropTemplate + clone. mesh.clone() shares the source's
// morphTargetManager AND material with the template, so the two CTF flags would (a)
// wave in LOCKSTEP off one influence set — in fact NO animation group would target a
// clone at all, since ImportMesh anim groups bind to the TEMPLATE's morph influences
// — and (b) repaint each other on the RED albedo swap (shared material). Two flags
// per map × 147 KB and the browser caches the fetch, so a per-flag import is cheap.
async function attachFlagModel(entity) {
	const scene = BABYLON.Engine.LastCreatedScene
	if (!scene || scene.getEngine().name === 'NullEngine') return

	const slash = FLAG_MODEL_URL.lastIndexOf('/') + 1
	const result = await BABYLON.SceneLoader.ImportMeshAsync(
		'', FLAG_MODEL_URL.slice(0, slash), FLAG_MODEL_URL.slice(slash), scene)

	// async-delete guard (exactly like attachPickupModel): the flag could be removed
	// during the await. Dispose EVERYTHING we imported (meshes recursively + their
	// materials/textures AND the animation groups) and bail — never touch a dead mesh.
	if (!entity || entity._disposed || !entity.mesh || entity.mesh.isDisposed()) {
		result.meshes.forEach((m) => m.dispose(false, true))
		result.animationGroups.forEach((g) => g.dispose())
		;(result.skeletons || []).forEach((s) => s.dispose())
		return
	}

	const root = result.meshes.find((m) => m.name === '__root__') || result.meshes[0]
	root.parent = entity.mesh
	root.isPickable = false
	result.meshes.forEach((m) => { m.isPickable = false }) // historian/raycast safety — the box opts out; the model must too

	// The model base sits at its own origin; the entity origin is the CENTER of the
	// old 2.0-tall placeholder box, so the flag's floor contact is at entity.y − 1.0.
	// Leave the imported rotationQuaternion alone (cloth direction is cosmetic).
	root.position.y = -1.0

	// Team skin: swap the PBR material's albedoTexture to the team's meme-coin banner,
	// built with the SAME (noMipmap=false, invertY=false) convention CharacterModel._teamTexture
	// uses for the same-pipeline uniform atlases. BOTH teams swap now (the GLB's baked skin is
	// the old UT blue, never wanted); an unexpected team id falls back to BONK so a flag is
	// never left wearing the stale skin.
	const skinUrl = FLAG_TEAM_SKIN_URL[entity.team] || FLAG_TEAM_SKIN_URL[0]
	result.meshes.forEach((m) => {
		const mat = m.material
		if (mat && mat.albedoTexture !== undefined) {
			mat.albedoTexture = new BABYLON.Texture(skinUrl, scene, false, false)
		}
	})

	// Drive the seamless cloth wave (the ONE `flag_wave` group of morph animations).
	const anim = result.animationGroups.find((g) => g.name === 'flag_wave') || result.animationGroups[0]
	if (anim) anim.start(true)

	// hide the placeholder box but KEEP it as the positioned holder (a CARRIED flag is
	// server-snapped to its carrier via entity.mesh.position). _updateObjectives keeps
	// pulsing f.mat invisibly — harmless. No opacityTexture/DynamicTexture (corona rule).
	if (entity.mesh.material) entity.mesh.material.alpha = 0
	entity._flagModel = root
	entity._flagAnim = anim
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
		},
		// UT-STYLE PICKUP (v1). The placeholder box is built in the entity constructor;
		// create() registers it for the per-frame bob/spin drive (Simulator._updatePickups,
		// which reacts to the networked `state`) and swaps in the real model by type.
		// Pickups are never removed server-side (they hide via `state`), so delete() only
		// fires on shutdown/disconnect — same as the mega.
		'Pickup': {
			create({ data, entity }) {
				simulator.registerPickup(entity)
				const type = entity.type !== undefined ? entity.type : (data && data.type)
				const weaponIndex = entity.weaponIndex !== undefined ? entity.weaponIndex : (data && data.weaponIndex)
				const spec = pickupModelSpec(type, weaponIndex)
				if (spec) attachPickupModel(entity, spec)
				// else ARMOR / POWERUP: keep the constructor's cyan placeholder box (v1-deferred asset)
			},
			delete({ nid, entity }) {
				simulator.unregisterPickup(nid)
				if (entity) entity._disposed = true
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose(false, true)
				}
			}
		},
		// TDM MATCH STATE. A DATA entity: the low-rate carrier for the team scores /
		// timer / phase / winner the HUD reads. Its placeholder mesh is built invisible
		// (see MatchState.js) and never rendered. create() hands the entity to the
		// Simulator, which reads its networked fields each frame in _updateHud;
		// delete() only fires on server shutdown.
		'MatchState': {
			create({ data, entity }) {
				simulator.registerMatchState(entity)
			},
			delete({ nid, entity }) {
				simulator.unregisterMatchState(nid)
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') {
					entity.mesh.dispose()
				}
			}
		},
		// CTF FLAG (v1). The tinted placeholder box built in the entity constructor IS
		// the marker (additive-RGB team tint — no bespoke model / no DynamicTexture, the
		// corona lesson). create() registers it so _updateObjectives can recolor it by
		// state + drive the flag HUD chips; the box position is server-authored (a
		// carried flag rides its carrier). delete() only fires on shutdown.
		'Flag': {
			create({ data, entity }) {
				simulator.registerFlag(entity)
				// swap the tinted placeholder box for the real UT99 flag model (async;
				// guarded against the entity being removed before the import resolves).
				attachFlagModel(entity)
			},
			delete({ nid, entity }) {
				simulator.unregisterFlag(nid)
				// async-delete guard: flag the entity so a still-pending attachFlagModel()
				// bails instead of mounting onto a disposed mesh.
				if (entity) entity._disposed = true
				// stop + free the per-flag wave animation group (own import, not warm-cache).
				if (entity && entity._flagAnim) { entity._flagAnim.stop(); entity._flagAnim.dispose() }
				// dispose recursively + free materials/textures so the parented imported
				// model (+ its RED albedo swap) frees with the box, same as the Projectile factory.
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') entity.mesh.dispose(false, true)
			}
		},
		// DOM CONTROL POINT (v1). Same shape as Flag: the tinted box is the marker,
		// recolored by owner in _updateObjectives; drives the point HUD chips.
		'ControlPoint': {
			create({ data, entity }) { simulator.registerControlPoint(entity) },
			delete({ nid, entity }) {
				simulator.unregisterControlPoint(nid)
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') entity.mesh.dispose()
			}
		},
		// UT99 LIFT PLATFORM. The shaded box built in the Mover constructor IS the v1
		// visual; create() tracks it in simulator.movers so the client-side carry clamp
		// (Simulator._carryClampSelf) can pin the owner's predicted entity to the
		// INTERPOLATED platform (nengi updates its y each frame). The box is NON-colliding
		// client-side (see below); the platform y (box centre) rides the server state
		// machine. delete() only fires on shutdown (movers persist all match).
		'Mover': {
			create({ data, entity }) {
				// checkCollisions is FORCED OFF client-side (the Mover constructor defaults it
				// on for the server floor). A moving checkCollisions box + nengi's ~100 ms
				// interp lag ejects the rider out of the carry band mid-rise (DESIGN option a's
				// documented failure — verified in _probe-lifts). The client carry is PURELY
				// the idempotent clamp in Simulator._carryClampSelf (DESIGN option b): it holds
				// a rider at rest AND carries them through the ride with no collision mesh.
				entity.mesh.checkCollisions = false
				entity.mesh.isPickable = false
				// swap the shared grey placeholder for the real tread-plate skin, tiled to this
				// lift's footprint. Dispose the per-entity placeholder material the Mover ctor
				// made (it is NOT shared, so leaving it assigned-then-orphaned would leak one
				// StandardMaterial per lift). Done AFTER the dims arrive on the create snapshot,
				// so the tiling matches the real platform size.
				try {
					const placeholder = entity.mesh.material
					entity.mesh.material = liftMaterial(
						entity.mesh.getScene(), entity.width || 3, entity.depth || 3)
					entity.mat = entity.mesh.material
					if (placeholder && placeholder !== entity.mesh.material) placeholder.dispose()
				} catch (e) { /* decorative — a skin miss must never break the lift's carry */ }
				simulator.movers.set(entity.nid, entity)
			},
			delete({ nid, entity }) {
				simulator.movers.delete(nid)
				if (entity && entity.mesh && typeof entity.mesh.dispose === 'function') entity.mesh.dispose()
			}
		}
	}
}
