import * as BABYLON from '../babylon.js'
import { resolveWeaponFx, classifySurface, surfaceFx, fadeAlpha } from './firingFx'
import { OBJFileLoader } from '../babylon.js' // OBJ loader (mesh maps) via curated barrel

import ArenaDressing from './arenaDressing'
import { USE_MESH_MAP, MAP_MESH } from '../../common/mapMesh'
import { bakeVertexColors } from './mapLights'

// Layer the first-person viewmodel lives on: vmCamera renders ONLY this, the world
// camera renders everything EXCEPT it (see the camera setup below). Viewmodel.js
// stamps the same mask on every gun/arms mesh, which makes it the reliable way to
// recognise "this is the local player's own gun" — used by _isHitscanTarget to keep
// impact FX off it.
const VM_LAYER_MASK = 0x10000000

// Blood/impact VFX — DISTINCT POOLED CLASSES (per FX consult), not one droplet
// spray. The "dark core" rule: a bright crimson ADDITIVE mist puff sells the hot
// atomized flash; dark-burgundy ALPHA streaks + drops carry the weight; floor
// pools mark where blood lands. No mesh decals — all pooled billboard/flat quads,
// no per-frame allocation, gated by _fxTier so mobile can thin it. Dial from play.

// MIST PUFF — a fast-expanding, fast-fading atomized cloud at the hit instant.
const MIST_COUNT_HI = 2, MIST_COUNT_LO = 1
const MIST_COLOR = [0.85, 0.02, 0.02] // bright crimson; additive on 'high', alpha on 'low'
const MIST_LIFE = 150         // ms
const MIST_SCALE0 = 1.6       // × base impact scale at spawn
const MIST_SCALE1 = 3.2       // × base at death (expands)
const MIST_ALPHA0 = 0.8       // starting opacity (ramps to 0)

// SPURT STREAKS — fast, high-drag, velocity-STRETCHED dark droplets (read as
// directional streaks, not dots). Oriented along travel at spawn.
const STREAK_COUNT_HI = 4, STREAK_COUNT_LO = 0
const STREAK_COLOR = [0.35, 0.02, 0.02] // dark burgundy, alpha
const STREAK_SPEED = 7.5, STREAK_SPREAD = 3.0
const STREAK_DRAG = 0.9       // per-frame velocity retention (rapid deceleration)
const STREAK_GRAVITY = 4.0    // light fall
const STREAK_LIFE = 360       // ms
const STREAK_WIDTH = 0.5      // × base (thin)
const STREAK_STRETCH = 0.16   // extra length per m/s of spawn speed

// MICRO-DROPS — heavier, slower, gravity-bound droplets that fall and can pool.
const DROP_COUNT_HI = 8, DROP_COUNT_LO = 3
const DROP_COLOR = [0.5, 0.02, 0.02]
const DROP_SPEED = 4.0, DROP_SPREAD = 3.0, DROP_UP = 1.6
const DROP_GRAVITY = 9.8
const DROP_LIFE = 600         // ms
const DROP_SIZE_MUL = 0.55, DROP_SIZE_JITTER = 0.4

// GROUND POOLS — a separate capped pool of flat floor quads (no mesh decals).
// A drop/streak that reaches the floor leaves one: grow, hold, fade, recycle.
// BOX ARENAS ONLY. This is the arenaDressing floor height — valid when the level is
// the SciFi-kit box arena (invisible collision plane + tiles drawn at y -1). MESH MAPS
// (USE_MESH_MAP, common/mapMesh.js) have no such global floor: the artist OBJ is both
// visual and collision, its deck sits at an arbitrary world height (CTF-Visage ~ -25),
// and that height VARIES across the map. So never test/place FX against this constant
// unconditionally — go through _floorYBelow(), which falls back to it only on box
// arenas. (Using it unconditionally put blood pools ~24m above the Visage deck.)
const GROUND_Y = -1           // arenaDressing floor height (box arenas only)
const GROUND_POOL = 24        // max simultaneous floor pools (round-robin recycle)
const GROUND_COLOR = [0.4, 0.01, 0.01]
const GROUND_GROW = 100, GROUND_HOLD = 3000, GROUND_FADE = 1000 // ms phases
const GROUND_SIZE = 0.5, GROUND_SIZE_JITTER = 0.4 // × base impact scale

// Babylon 9 note: the old 4.0.3 shadowsFragmentFunctions precision patch was REMOVED
// here. 9.17.0's shadowsFragmentFunctions include already declares every sampler2DShadow
// as `highp sampler2DShadow` upstream, and the `#ifdef WEBGL2` anchor the patch searched
// for no longer exists (guards are now `#if defined(WEBGL2)||defined(WEBGPU)||defined(NATIVE)`),
// so the string-replace was a dead no-op. Precision is handled in-source. (upgrade.md R10)

class BABYLONRenderer {
	constructor() {
		this.engine = new BABYLON.Engine(document.getElementById('main-canvas'), true)
		this.engine.enableOfflineSupport = false

		// --- adaptive render-resolution cap ---------------------------------------
		// Babylon renders the world at (canvas CSS size / hardwareScalingLevel). With
		// adaptToDeviceRatio=false (above) that means CSS-pixel resolution — so on a
		// 4K monitor the arena is drawn at ~8M px/frame purely as fill cost. Cap the
		// rendered pixel count to a budget and let the browser upscale the canvas;
		// invisible in motion, big frame-time recovery on large/weak displays. We
		// never scale ABOVE CSS res (level >= 1) — supersampling only costs perf.
		// NOTE: this also installs the ONLY window-resize handler the game had — the
		// main client never called engine.resize(), so resizing the window used to
		// distort the view. setHardwareScalingLevel() calls engine.resize() for us.
		this._pixelBudget = /Mobi|Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '')
			? 1280 * 720   // mobile: cap at 720p-equivalent
			: 1920 * 1080  // desktop: cap at 1080p-equivalent
		this._applyRenderScale = () => {
			const el = document.getElementById('main-canvas')
			const cssW = (el && el.clientWidth) || window.innerWidth || 1280
			const cssH = (el && el.clientHeight) || window.innerHeight || 720
			const level = Math.max(1, Math.sqrt((cssW * cssH) / this._pixelBudget))
			this.engine.setHardwareScalingLevel(level)
		}
		this._applyRenderScale()
		window.addEventListener('resize', this._applyRenderScale)
		this.scene = new BABYLON.Scene(this.engine)
		this.scene.collisionsEnabled = true
		this.scene.detachControl() // we're doing our own camera!
		// sky-tinted clear so any area the skybox dome doesn't cover (corners) blends in
		this.scene.clearColor = new BABYLON.Color3(0.05, 0.05, 0.08)

		// filmic punch: tone mapping + contrast + a dark vignette. Material-level
		// image processing (no post-process pass), so it costs nothing extra on
		// mobile and applies uniformly to world + viewmodel cameras.
		const ip = this.scene.imageProcessingConfiguration
		ip.toneMappingEnabled = true
		// STANDARD tonemap. ACES was tried (2026-07-17) and reverted: it crushed the
		// midtones and the arena read near-black on real displays even with exposure
		// raised to 1.3. Scene legibility beats highlight rolloff here.
		ip.contrast = 1.35
		ip.exposure = 1.05
		ip.vignetteEnabled = true
		ip.vignetteWeight = 1.6
		ip.vignetteColor = new BABYLON.Color4(0, 0, 0, 0)
		ip.vignetteBlendMode = BABYLON.ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY

		this.camera = new BABYLON.TargetCamera('camera', new BABYLON.Vector3(0, 0, -10), this.scene)
		this.camera.fov = 1.0
		this.camera.minZ = 0.05
		this.camera.maxZ = 2000
		this.camera.layerMask = 0x0FFFFFFF // Renders everything except viewmodel

		this.vmCamera = new BABYLON.TargetCamera('vmCamera', BABYLON.Vector3.Zero(), this.scene)
		this.vmCamera.parent = this.camera
		this.vmCamera.fov = 1.0 // Fixed viewmodel FOV
		this.vmCamera.minZ = 0.01 // Prevent close clipping
		this.vmCamera.maxZ = 10
		this.vmCamera.layerMask = VM_LAYER_MASK // Renders only viewmodel meshes

		// Bound once: drawHitscan picks once PER PELLET (the shotgun fires 8), so the
		// predicate must not allocate a fresh closure on every one.
		this._hitscanPredicate = (m) => this._isHitscanTarget(m)

		// Clear depth buffer before rendering viewmodel so it doesn't clip through world geometry
		this.scene.onBeforeCameraRenderObservable.add((cam) => {
			if (cam === this.vmCamera) {
				this.engine.clear(null, false, true, false)
			}
		})

		this.scene.activeCameras = [this.camera, this.vmCamera]
		this.scene.cameraToUseForPointers = this.camera // Route pointer events through main camera

		// --- lighting: UT99-style dusk arena — a dim cool ambient so shadow sides
		// stay dark and readable, under a hard warm key light (low sun / sodium
		// floodlight feel). Contrast carries the mood; the FX are the bright thing.
		const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0.2), this.scene)
		ambient.intensity = 0.45
		ambient.diffuse = new BABYLON.Color3(0.6, 0.62, 0.75)   // cool skylight fill
		ambient.groundColor = new BABYLON.Color3(0.22, 0.18, 0.15) // warm bounce so shadow sides never crush to black

		const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.55, -0.85, 0.35), this.scene)
		sun.position = new BABYLON.Vector3(30, 60, -30)
		sun.intensity = 1.65
		sun.diffuse = new BABYLON.Color3(1.0, 0.82, 0.6)        // low warm key
		sun.specular = new BABYLON.Color3(0.6, 0.5, 0.4)
		// 1024 shadow map on every tier: the 2048 desktop map (tried 2026-07-17) cost
		// real frame time for a marginal sharpness gain and was reverted after a live
		// perf regression (janked frames delay message-driven SFX into audible bursts).
		// shadowOrthoScale stays tightened so more texels land on the 60u playfield.
		this._isMobile = /Mobi|Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '')
		this.shadowGenerator = new BABYLON.ShadowGenerator(1024, sun)
		this.shadowGenerator.useBlurExponentialShadowMap = true
		this.shadowGenerator.blurKernel = 16
		sun.shadowOrthoScale = 0.35
		// --- freeze the static shadow map -----------------------------------------
		// EVERYTHING that casts a shadow here is static geometry: the arena map mesh
		// (see the map loader below) and the arena dressing instances. No player,
		// projectile, or dynamic entity is ever added to the shadow renderList. Yet
		// the sun is fixed and the geometry never moves — so re-rendering the shadow
		// map AND running its blur-exponential pass every single frame is pure waste
		// (it was a top per-frame cost and a source of the periodic jank). Switch the
		// map to RENDER_ONCE: it bakes a single time once geometry exists and then
		// costs nothing per frame. _refreshStaticShadows() forces one more bake and
		// is called after each async load (map mesh + dressing) settles.
		this.shadowGenerator.getShadowMap().refreshRate =
			BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE
		// Fallback re-bakes covering async geometry (arena dressing / late imports) on
		// either arena path. A handful of extra shadow renders in the first few seconds
		// is negligible; after that the map is frozen for the rest of the match.
		setTimeout(() => this._refreshStaticShadows(), 500)
		setTimeout(() => this._refreshStaticShadows(), 1500)
		setTimeout(() => this._refreshStaticShadows(), 3500)
		// a bright light that lights ONLY the first-person viewmodel (from the camera's
		// side), so arms/gun are always legible even when the scene key light is behind
		// them. Viewmodels register their meshes into includedOnlyMeshes.
		this.viewmodelLight = new BABYLON.HemisphericLight('vmLight', new BABYLON.Vector3(0.1, 1, 0.6), this.scene)
		this.viewmodelLight.intensity = 0.9 // dimmer than daylight tuning so the arms sit in the dusk scene
		this.viewmodelLight.diffuse = new BABYLON.Color3(0.95, 0.88, 0.8)
		this.viewmodelLight.includedOnlyMeshes = []
		// includedOnlyMeshes is a WHITELIST, but in Babylon 4.0.3 an EMPTY list means
		// the light affects EVERY mesh. A weapon swap disposes the old gun BEFORE the
		// new GLB finishes importing, briefly emptying the list — for those async frames
		// the vmLight would flood the WHOLE arena (and force a scene-wide light-count
		// shader resync). Park a permanent, never-disposed, never-drawn placeholder in
		// the list so it stays length >= 1 across every swap. isVisible=false keeps it
		// off-screen but it still counts toward the light's whitelist.
		this._vmLightAnchor = BABYLON.MeshBuilder.CreateBox('vmLightAnchor', { size: 0.001 }, this.scene)
		this._vmLightAnchor.isVisible = false
		this._vmLightAnchor.isPickable = false
		this._vmLightAnchor.layerMask = 0x10000000
		this.viewmodelLight.includedOnlyMeshes.push(this._vmLightAnchor)

		// --- muzzle flash world light: ONE point light created here at init and
		// shared by every shot (local + remote — newest shot wins it; flashes are
		// ~70ms so overlap is imperceptible). It idles at intensity 0 and flashMuzzle
		// pulses it. Because the scene's light COUNT never changes after init, firing
		// never triggers the per-material shader recompile that creating/destroying
		// lights per shot would — that recompile stall is why the flash sprites alone
		// carried the effect until now. Fixed cost: one extra light in the forward
		// pass (world meshes now shade ambient+sun+this = 3 of the default 4 max).
		// No shadow casting — that WOULD be per-frame expensive.
		this._muzzleLight = new BABYLON.PointLight('muzzleFlashLight', new BABYLON.Vector3(0, -100, 0), this.scene)
		this._muzzleLight.intensity = 0
		this._muzzleLight.range = 10
		// GLTF (inverse-square) falloff instead of the default linear: a hotter core
		// near the muzzle and a softer edge, so the flash "licks" walls more naturally
		// than a hard linear ramp (Babylon 4.0.3 exposes Light.FALLOFF_GLTF = 2).
		this._muzzleLight.falloffType = BABYLON.Light.FALLOFF_GLTF
		this._muzzleLight.diffuse = new BABYLON.Color3(1, 0.8, 0.45)
		this._muzzleLight.specular = new BABYLON.Color3(0.25, 0.2, 0.12)
		this._muzzleLightPulse = null // { t0, life, peak } — decayed in update()

		// expose so character/other visuals can register themselves
		this.scene.metadata = { shadowGenerator: this.shadowGenerator, viewmodelLight: this.viewmodelLight }

		// --- SPACE VISTA (first pass): starfield dome + a day/night Earth hanging below
		// the platform + a distant Moon. Our own composed scene from our own space
		// textures — the Facing-Worlds "in orbit" money shot. Everything is far, fog-off,
		// shadow-off, and inside the camera maxZ (2000) so it reads as sky, never as
		// playfield geometry. (Kimi is tuning the proper day/night terminator + atmosphere
		// fresnel shader; this pass is the safe blockout.)
		this.skydome = new BABYLON.PhotoDome('sky', '/assets/space/stars.jpg',
			{ resolution: 32, size: 3600 }, this.scene)
		// Babylon 9: use the PhotoDome's public mesh handle instead of the fragile
		// internal '<domeName>_mesh' name lookup (TextureDome refactor risk). (upgrade.md R-Med)
		const skyMesh = this.skydome && this.skydome.mesh
		if (skyMesh) skyMesh.applyFog = false

		// EARTH — big, low, beyond the west end; its upper limb looms above the horizon.
		// Day side lit by the sun (real terminator from the directional light); night
		// city-lights glow via a toned emissive map (bright day diffuse keeps them subtle
		// on the lit side — cheap-but-convincing until Kimi's terminator shader lands).
		const earth = BABYLON.MeshBuilder.CreateSphere('earth', { diameter: 1200, segments: 64 }, this.scene)
		earth.position.set(-360, -320, 820)
		earth.rotation.y = 2.1
		earth.applyFog = false
		earth.isPickable = false
		const earthMat = new BABYLON.StandardMaterial('earthMat', this.scene)
		// real NASA-derived satellite day map (three.js MIT repo, public-domain imagery)
		earthMat.diffuseTexture = new BABYLON.Texture('/assets/space/earth_day.jpg', this.scene)
		// specular mask: oceans glint, landmasses stay matte
		earthMat.specularTexture = new BABYLON.Texture('/assets/space/earth_spec.jpg', this.scene)
		earthMat.specularColor = new BABYLON.Color3(0.42, 0.47, 0.58)
		earthMat.specularPower = 96
		// night-side city lights
		earthMat.emissiveTexture = new BABYLON.Texture('/assets/space/earth_lights.png', this.scene)
		earthMat.emissiveColor = new BABYLON.Color3(0.5, 0.45, 0.33)
		earth.material = earthMat

		// MOON — big and high in the black so it's caught from many sightlines, lit by
		// the same sun as the Earth + arena.
		const moon = BABYLON.MeshBuilder.CreateSphere('moon', { diameter: 420, segments: 32 }, this.scene)
		moon.position.set(300, 700, -250)
		moon.applyFog = false
		moon.isPickable = false
		const moonMat = new BABYLON.StandardMaterial('moonMat', this.scene)
		moonMat.diffuseTexture = new BABYLON.Texture('/assets/space/moon.jpg', this.scene)
		moonMat.diffuseColor = new BABYLON.Color3(1.6, 1.6, 1.65) // overbright the sunlit face
		// self-illuminate: the raw lunar albedo map is very dark, so drive the texture
		// through emissive too — the Moon reads as a bright disc against the black void
		// instead of a dim smudge, while the emissive texture keeps the crater detail.
		moonMat.emissiveTexture = new BABYLON.Texture('/assets/space/moon.jpg', this.scene)
		moonMat.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.95)
		moonMat.specularColor = new BABYLON.Color3(0, 0, 0)
		moon.material = moonMat

		// --- distance fog: dark slate, subtle. LINEAR fogStart 22 / fogEnd 78 was
		// tried (2026-07-17) and reverted — in a ~60u arena it buried most of the view
		// in near-black fog ("can't see anything"). EXP2 @ 0.008 keeps depth without
		// eating target visibility.
		this.scene.fogMode = BABYLON.Scene.FOGMODE_EXP2
		this.scene.fogColor = new BABYLON.Color3(0.05, 0.05, 0.08)
		this.scene.fogDensity = 0.008

		// --- ground: dark asphalt catch-all under the kit floor tiles (sits a hair
		// lower so the tiles don't z-fight it); still the shadow receiver of record.
		// BOX ARENAS ONLY. On a MESH MAP the artist OBJ is the floor, at its own height
		// (CTF-Visage's deck is ~ -25), so this 60x60 y=-1.03 slab is not "under" anything
		// — it floats ~24m above the west/central deck, spanning world x/z [-30,30].
		// Measured, so the next reader doesn't have to re-derive it: it is NOT the black
		// ceiling it looks like on paper. The plane is single-sided with a +Y world normal
		// and backFaceCulling on, so from the deck below it is culled and invisible; it
		// only draws when viewed from ABOVE y -1.03. It is dead weight rather than a
		// visible artifact — a wasted draw call, a member of the frozen shadow-map render
		// list, and something that WOULD pop into view for any camera that ever rises
		// above it. It has no checkCollisions, so it never blocked movement.
		// Nothing else holds a reference: the handle is local, and the only other mention
		// of the name is drawHitscan's pick filter (m.name !== 'ground'), which is simply
		// a no-op when the mesh doesn't exist.
		if (!USE_MESH_MAP) {
			const plane = BABYLON.MeshBuilder.CreatePlane('ground', { size: 60 }, this.scene)
			plane.rotation.x = Math.PI * 0.5
			plane.position.y = -1.03
			const groundMat = new BABYLON.StandardMaterial('groundMat', this.scene)
			groundMat.diffuseColor = new BABYLON.Color3(0.11, 0.11, 0.13)
			groundMat.specularColor = new BABYLON.Color3(0.08, 0.07, 0.06)
			plane.material = groundMat
			plane.receiveShadows = true
		}

		// --- arena obstacle materials (consumed by createObstacleFactory via
		// scene.metadata, keyed by entity.style). Dark industrial concrete/metal
		// bodies with EMISSIVE trim accents — the glowing strips are what sell the
		// tech-arena look against the dusk lighting.
		const mkBody = (name, r, g, b, spec = 0.06) => {
			const m = new BABYLON.StandardMaterial(name, this.scene)
			m.diffuseColor = new BABYLON.Color3(r, g, b)
			m.specularColor = new BABYLON.Color3(spec, spec, spec)
			return m
		}
		const mkTrim = (name, r, g, b) => {
			const m = new BABYLON.StandardMaterial(name, this.scene)
			m.diffuseColor = new BABYLON.Color3(r * 0.25, g * 0.25, b * 0.25)
			m.emissiveColor = new BABYLON.Color3(r, g, b)
			m.disableLighting = true
			return m
		}
		this.obstacleMaterials = [
			mkBody('obsConcrete', 0.30, 0.29, 0.28),        // weathered concrete
			mkBody('obsSlate', 0.22, 0.24, 0.28),           // cold slate block
			mkBody('obsRust', 0.30, 0.20, 0.13, 0.12),      // rusted plate
		]
		this.obstacleAccentMaterials = [
			mkTrim('trimAmber', 0.95, 0.55, 0.16),          // sodium amber strip
			mkTrim('trimTeal', 0.16, 0.75, 0.80),           // cold tech teal
			mkTrim('trimEmber', 0.90, 0.28, 0.08),          // hot ember
		]
		this.scene.metadata.obstacleMaterials = this.obstacleMaterials
		this.scene.metadata.obstacleAccentMaterials = this.obstacleAccentMaterials

		// --- ARENA VISUAL. Mesh maps load the artist OBJ directly as the level; box
		// arenas use the SciFi MegaKit dressing (floor tiles, wall panels, columns).
		if (USE_MESH_MAP) {
			this.arenaDressing = null
			this._loadMeshMap()
		} else {
			// Loads async; obstacles keep the legacy box look until attachObstacle
			// upgrades them, and forever if the kit fails to load.
			this.arenaDressing = new ArenaDressing(this.scene, this.shadowGenerator)
		}

		// --- shot FX are POOLED. Creating meshes/materials mid-frame races the shader
		// + VAO compilation and crashes the GL bind on strict drivers (e.g. SwiftShader).
		// So we build every FX mesh + material once here, force-compile their shaders,
		// and at runtime only toggle visibility + transform + color. No allocation on
		// fire. Each pooled mesh owns its OWN material so shots can carry per-weapon
		// color and fade independently (a shared material could only show one color +
		// couldn't fade per-mesh). Textures are shared across a kind (loaded once).
		// GRAYSCALE sprites (scripts/make-fx-sprites.py) — per-weapon emissiveColor
		// does all tinting. The old burst.png baked an orange donut into the texture,
		// which made every impact/halo read as a cartoon ring.
		this._sprites = {
			muzzle: this._loadTex('/assets/sprites/retro_muzzleflash.png'),
			spark: this._loadTex('/assets/sprites/fx_spark.png'),
			glow: this._loadTex('/assets/sprites/fx_glow.png'),
			scorch: this._loadTex('/assets/sprites/fx_scorch.png'),
			hit: this._loadTex('/assets/sprites/hit.png'),
			// blood-impact shapes (make-blood-sprites.py), grayscale+alpha, tinted per class
			blood_mist: this._loadTex('/assets/sprites/blood_mist.png'),
			blood_drop: this._loadTex('/assets/sprites/blood_drop.png'),
			blood_streak: this._loadTex('/assets/sprites/blood_streak.png'),
			blood_splat: this._loadTex('/assets/sprites/blood_splat.png'),
		}

		// Sized per role: impacts largest — a shotgun rosette burns 8 marks/shot and
		// scorches linger seconds so wall patterns stay readable (firingFx SURFACE_FX).
		// smoke = barrel puffs, pooled SEPARATELY from impacts so a lingering muzzle
		// puff can't recycle away a wall scorch (the wall pattern is weapon identity).
		// impact bumped 64 -> 96 so a flesh hit's blood burst (base mark + ~5 droplets)
		// can't recycle away a still-fading wall scorch under sustained fire.
		// impact pool sized for GENEROUS blood: up to BLOOD_DROPLETS (14) per flesh hit
		// plus the base mark, so a burst of near-simultaneous hits needs deep headroom
		// before droplets start stealing each other's sprites (round-robin recycle).
		// blood classes (mist + streaks + drops) all draw from the impact pool: up to
		// MIST(2)+STREAK(4)+DROP(8)=14 + base mark per hit, so keep deep headroom before
		// near-simultaneous hits recycle each other. Ground pools are a SEPARATE pool so
		// a lingering floor mark can't be recycled away by fresh airborne droplets.
		const POOLS = { tracer: 24, muzzle: 12, glow: 12, impact: 224, casing: 24, smoke: 12, ground: GROUND_POOL }
		this._pool = { tracer: [], muzzle: [], glow: [], impact: [], casing: [], smoke: [], ground: [] }
		this._idx = { tracer: 0, muzzle: 0, glow: 0, impact: 0, casing: 0, smoke: 0, ground: 0 }
		this._fx = [] // active fading effects, advanced every frame in update()
		this._casings = [] // active brass, simulated every frame in update()
		this._blood = [] // active blood particles (mist/streak/drop), simulated in update()
		this._groundPools = [] // active floor blood pools, simulated in update()
		this._bloodVelScratch = new BABYLON.Vector3() // reused so the sim never allocates
		this._casingScratch = new BABYLON.Vector3() // ditto for airborne-casing integration
		// scratch for orienting velocity-stretched streaks at spawn (no per-frame alloc)
		this._svUp = new BABYLON.Vector3()
		this._svFwd = new BABYLON.Vector3()
		this._svRight = new BABYLON.Vector3()
		this._svFwd2 = new BABYLON.Vector3()
		this._streakQuat = new BABYLON.Quaternion()
		this._fxTier = 'high' // 'low' thins the blood (see _spawnBloodBurst); tune externally
		for (let i = 0; i < POOLS.tracer; i++) {
			// tracer: a thin box, additive + unlit so it reads as a hot streak, never a
			// solid painted stick. Width/length/color set per shot.
			const tracer = BABYLON.MeshBuilder.CreateBox('tracer' + i, { size: 1 }, this.scene)
			const tmat = new BABYLON.StandardMaterial('tracerMat' + i, this.scene)
			tmat.disableLighting = true
			tmat.emissiveColor = new BABYLON.Color3(1, 0.8, 0.4)
			tmat.alphaMode = BABYLON.Engine.ALPHA_ADD
			tmat.alpha = 0.999 // force the transparent path so mesh.visibility fades it
			tracer.material = tmat
			tracer.isPickable = false
			tracer.isVisible = false
			this._pool.tracer.push(tracer)
		}
		for (let i = 0; i < POOLS.muzzle; i++) {
			// muzzle core (bright, additive, billboarded) + a softer larger glow halo.
			// Two cheap additive sprites read as a flash-with-bloom without a runtime
			// dynamic light (those force Babylon shader recompiles + cost every frame).
			this._pool.muzzle.push(this._makeSprite('muzzle' + i, this._sprites.muzzle, true, true))
			this._pool.glow.push(this._makeSprite('glow' + i, this._sprites.glow, true, true))
		}
		for (let i = 0; i < POOLS.impact; i++) {
			// impact: a small quad oriented to the surface normal (decal-like), not a
			// billboard, so hits sit on the surface. Texture swapped per surface.
			this._pool.impact.push(this._makeSprite('impact' + i, this._sprites.hit, false))
		}
		for (let i = 0; i < POOLS.smoke; i++) {
			// barrel smoke: billboarded gray puff, alpha-BLENDED (not additive — smoke
			// darkens/veils, it doesn't glow). Reuses the soft scorch texture.
			const puff = this._makeSprite('muzsmoke' + i, this._sprites.scorch, true)
			puff.material.alphaMode = BABYLON.Engine.ALPHA_COMBINE
			this._pool.smoke.push(puff)
		}
		for (let i = 0; i < POOLS.casing; i++) {
			// ejected brass: a small unlit box (cylinder silhouettes don't read at this
			// size), color set per weapon (brass vs red shotshell). Own material so
			// color + fade are per-casing.
			const casing = BABYLON.MeshBuilder.CreateBox('casing' + i, { size: 1 }, this.scene)
			const cmat = new BABYLON.StandardMaterial('casingMat' + i, this.scene)
			cmat.disableLighting = true
			cmat.emissiveColor = new BABYLON.Color3(0.85, 0.62, 0.22)
			cmat.alpha = 0.999
			casing.material = cmat
			casing.isPickable = false
			casing.isVisible = false
			this._pool.casing.push(casing)
		}
		for (let i = 0; i < POOLS.ground; i++) {
			// floor blood pool: a flat alpha quad laid on the ground (normal +Y), NOT a
			// mesh decal — no new mesh/draw-call per hit. Rotated horizontal here; the
			// per-pool random spin + scale happens on spawn (_spawnGroundPool).
			const gp = this._makeSprite('ground' + i, this._sprites.blood_splat, false)
			gp.material.alphaMode = BABYLON.Engine.ALPHA_COMBINE
			gp.rotation.x = Math.PI / 2 // lay the plane flat on the floor
			this._pool.ground.push(gp)
		}
		// --- SELECTIVE glow: bloom ONLY the additive FX pools (muzzle core, glow halo,
		// tracers) so flashes/streaks read as hot light without a full-scene rendering
		// pipeline that would clobber the material-level image processing tuned above.
		// GlowLayer's includedOnlyMeshes whitelist keeps world + viewmodel crisp. Skipped
		// entirely on the low FX tier (mobile) to protect the fill-rate budget — this is
		// the only tier check needed since low never allocates the blur chain.
		if (this._fxTier !== 'low') {
			this._glowLayer = new BABYLON.GlowLayer('fxGlow', this.scene, { mainTextureRatio: 0.5, blurKernelSize: 32 })
			this._glowLayer.intensity = 0.9
			for (const s of this._pool.muzzle) this._glowLayer.addIncludedOnlyMesh(s)
			for (const s of this._pool.glow) this._glowLayer.addIncludedOnlyMesh(s)
			for (const t of this._pool.tracer) this._glowLayer.addIncludedOnlyMesh(t)
		}

		// compile the shaders now so the first shot never binds an unready effect
		this._pool.tracer[0].material.forceCompilation(this._pool.tracer[0])
		this._pool.muzzle[0].material.forceCompilation(this._pool.muzzle[0])
		this._pool.impact[0].material.forceCompilation(this._pool.impact[0])
		this._pool.casing[0].material.forceCompilation(this._pool.casing[0])
		this._pool.smoke[0].material.forceCompilation(this._pool.smoke[0])
		this._pool.ground[0].material.forceCompilation(this._pool.ground[0])

		this.scene.executeWhenReady(() => { console.log('SCENE READY') })
	}

	// Load the artist OBJ map as the level visual (mesh maps): textured via the MTL
	// (web-optimized WebP set in MAP_MESH.dir/textures/), lit by the original 1999
	// light actors baked into vertex colors. Server owns collision.
	_loadMeshMap() {
		// Babylon 9's OBJ loader default-mirrors X vs 4.0.3 (USE_LEGACY_BEHAVIOR now
		// defaults false); spawns/killY/lights are calibrated on the legacy orientation,
		// and the server collider sets the same flag — visual and collision must match.
		// (Named import: the class lives on the loaders module, not the BABYLON namespace.)
		OBJFileLoader.USE_LEGACY_BEHAVIOR = true
		BABYLON.SceneLoader.ImportMeshAsync('', MAP_MESH.dir, MAP_MESH.file, this.scene)
			.then(res => {
				// upright the Z-up OBJ — MUST match the server's rotation (mapMesh.js) so
				// the visual floor and the collision floor line up to the millimeter.
				const root = new BABYLON.TransformNode('mapRoot', this.scene)
				res.meshes.forEach(m => { if (!m.parent) m.parent = root })
				root.rotation.x = MAP_MESH.rotationX || 0
				root.scaling.setAll(MAP_MESH.scale || 1)
				root.computeWorldMatrix(true)
				const shadowList = this.shadowGenerator ? this.shadowGenerator.getShadowMap().renderList : null
				res.meshes.forEach(m => {
					if (!m.getTotalVertices || m.getTotalVertices() === 0) return
					m.computeWorldMatrix(true)
					if (m.refreshBoundingInfo) m.refreshBoundingInfo(true)
					m.isPickable = false
					// MUST collide: the client predicts its own movement with
					// moveWithCollisions and needs the same floors/walls the server has,
					// or prediction falls through the map (juddery "falling" feel).
					m.checkCollisions = true
					m.receiveShadows = true
					if (shadowList) shadowList.push(m)
				})
				// Flat fill scoped to the map only: the sun is directional so interiors
				// would render near-black, but the 1999 light-actor bake (vertex colors)
				// IS the interior lighting — it needs a constant base to modulate.
				// diffuse == groundColor makes the fill normal-independent; players keep
				// the dramatic sun/hemi rig and still cast shadows onto sunlit floors.
				const mapFill = new BABYLON.HemisphericLight('mapFill', new BABYLON.Vector3(0, 1, 0), this.scene)
				mapFill.diffuse = new BABYLON.Color3(1, 1, 1)
				mapFill.groundColor = new BABYLON.Color3(1, 1, 1)
				mapFill.specular = new BABYLON.Color3(0, 0, 0)
				mapFill.intensity = 0.85
				mapFill.includedOnlyMeshes = res.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0)
				console.log('[map] mesh visual loaded:', res.meshes.length)
				// arena geometry now exists — bake it into the frozen shadow map.
				this._refreshStaticShadows()
				this._bakeMapLights(res.meshes, root)
			})
			.catch(err => console.warn('[map] mesh visual load failed', err))
	}

	// Fetch the map's light-actor sidecar and bake it into vertex colors. Vertex
	// buffers are LOCAL (same Z-up meter space as the JSON), so this is independent
	// of the mapRoot rotation/scale and can run any time after import. Failure is
	// cosmetic-only: the map just stays uniformly lit.
	async _bakeMapLights(meshes, mapRoot) {
		if (!MAP_MESH.lights) return
		try {
			const resp = await fetch(MAP_MESH.dir + MAP_MESH.lights)
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
			const data = await resp.json()
			let baked = 0
			meshes.forEach(m => {
				if (!m.getTotalVertices || m.getTotalVertices() === 0) return
				const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)
				const nor = m.getVerticesData(BABYLON.VertexBuffer.NormalKind)
				if (!pos || !nor) return
				m.setVerticesData(BABYLON.VertexBuffer.ColorKind, bakeVertexColors(pos, nor, data.lights))
				baked++
			})
			console.log(`[map] baked ${data.lights.length} light actors into ${baked} meshes`)
			this._addLightCoronas(data.lights, mapRoot)
		} catch (err) { console.warn('[map] light bake failed (map stays unlit-shaded)', err) }
	}

	// Retro-style coronas: an additive billboard glow at each interesting light actor
	// (colored or notably bright). Positions are computed straight into world space
	// (rotX -90: (x,y,z) -> (x, z, -y), then map scale) instead of parenting to
	// mapRoot — Babylon 4.0 billboards misbehave under rotated parents. Depth-TESTED
	// but not depth-written: glows hide correctly behind walls and never punch holes
	// in other transparents. Pulse/flicker types get a cheap sin/jitter scale wobble.
	_addLightCoronas(lights, mapRoot) {
		const colored = l => l.rgb && (l.rgb[0] !== 1 || l.rgb[1] !== 1 || l.rgb[2] !== 1)
		// colored lights outrank white ones — they're the atmosphere; whites only
		// make the cut when genuinely bright (fixture-style)
		const score = l => l.brightness + (colored(l) ? 1000 : 0)
		const ranked = lights
			.filter(l => (colored(l) && l.brightness >= 32) || l.brightness >= 110)
			.sort((a, b) => score(b) - score(a))
		// greedy spatial dedupe: the sidecar has dense same-light grids (e.g. a lava
		// pool of 160+ identical strobes) — one corona per ~2m cell reads as a glow
		// field instead of a single blown-out blob
		const picks = []
		for (const l of ranked) {
			if (picks.length >= 64) break
			const p = l.pos_m
			if (picks.some(k => {
				const q = k.pos_m
				return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < 1.8 ** 2
			})) continue
			picks.push(l)
		}
		if (!picks.length) return
		// Reuse the game's proven soft-glow PNG (the muzzle halo sprite) for the
		// falloff instead of a DynamicTexture. On Babylon 4.0.3 a DynamicTexture-as-
		// opacityTexture under ALPHA_ADD renders nothing, and as an emissiveTexture it
		// reads as a flat bright square (the gradient doesn't shape the additive add).
		// A real PNG's alpha channel works fine as opacityTexture (the whole _makeSprite
		// FX system relies on it), so we take the same tinted-sprite recipe: the PNG's
		// soft radial alpha shapes the glow, emissiveColor carries the per-light tint.
		const glowTex = this._sprites.glow
		const animated = []
		picks.forEach((l, i) => {
			const s = MAP_MESH.scale || 1
			const size = (0.9 + (l.brightness / 64) * 0.9) * s
			const plane = BABYLON.MeshBuilder.CreatePlane(`corona${i}`, { size }, this.scene)
			plane.position.set(l.pos_m[0] * s, l.pos_m[2] * s, -l.pos_m[1] * s)
			plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			plane.isPickable = false
			plane.applyFog = false
			const mat = new BABYLON.StandardMaterial(`coronaMat${i}`, this.scene)
			// tinted-sprite recipe: opacityTexture (PNG alpha) shapes the soft glow,
			// emissiveColor is the tint. NO emissiveTexture — the white PNG luminance
			// would wash the tint out to white (see _makeSprite's tinted-pool note).
			mat.opacityTexture = glowTex
			mat.disableLighting = true
			mat.backFaceCulling = false
			mat.alphaMode = BABYLON.Engine.ALPHA_ADD
			mat.disableDepthWrite = true
			const c = l.rgb || [1, 1, 1]
			const gain = 0.55 * (l.brightness / 64)
			mat.emissiveColor = new BABYLON.Color3(c[0] * gain, c[1] * gain, c[2] * gain)
			plane.material = mat
			if (l.type === 'Pulse' || l.type === 'SubtlePulse' || l.type === 'Strobe' ||
				l.effect === 'TorchWaver' || l.effect === 'FireWaver') {
				animated.push({ plane, size, phase: i * 1.7, flicker: l.effect === 'TorchWaver' || l.effect === 'FireWaver' })
			}
		})
		if (animated.length) {
			this.scene.registerBeforeRender(() => {
				const t = performance.now() / 1000
				for (const a of animated) {
					const wob = a.flicker
						? 0.85 + 0.15 * Math.sin(t * 9 + a.phase) + 0.08 * Math.sin(t * 23 + a.phase * 2)
						: 0.8 + 0.2 * Math.sin(t * 2.2 + a.phase)
					a.plane.scaling.setAll(wob)
				}
			})
		}
		console.log(`[map] coronas: ${picks.length} (${animated.length} animated)`)
	}

	_loadTex(url) {
		const tex = new BABYLON.Texture(url, this.scene)
		tex.hasAlpha = true
		return tex
	}

	// Force the RENDER_ONCE shadow map to bake one more frame. Called whenever static
	// shadow-casting geometry is added asynchronously (map mesh / arena dressing), so
	// the frozen shadow map picks up geometry that didn't exist at the first bake.
	// resetRefreshCounter() re-arms the single render; cheap and idempotent to call.
	_refreshStaticShadows() {
		if (!this.shadowGenerator) return
		const map = this.shadowGenerator.getShadowMap()
		if (map && map.resetRefreshCounter) map.resetRefreshCounter()
	}

	// a pooled sprite quad with its OWN additive material (texture shared across the
	// kind). billboard = always face the camera (muzzle/glow). Non-billboard sprites
	// (impacts) are oriented to the surface normal per shot instead.
	_makeSprite(name, tex, billboard, keepEmissive = false) {
		const mesh = BABYLON.MeshBuilder.CreatePlane(name, { size: 1 }, this.scene)
		const mat = new BABYLON.StandardMaterial(name + 'Mat', this.scene)
		mat.diffuseTexture = tex
		// emissiveTexture is opt-in (keepEmissive). For the TINTED pools (blood/impact/
		// smoke/ground) it must stay OFF: those PNGs are WHITE luminance masks and
		// StandardMaterial ADDS emissiveTexture RGB onto emissiveColor (the crimson tint
		// from _setColor), so white+crimson clamps to white — the shape comes from
		// opacityTexture (alpha), the tint from emissiveColor → tint × alpha. For the
		// always-additive white-hot pools (muzzle/glow) we KEEP it: the white texture add
		// is the intended hot-core look, and those pools never swap textures at runtime so
		// the emissive define is stable (no mid-frame shader recompile; see the pool comment).
		if (keepEmissive) mat.emissiveTexture = tex
		mat.opacityTexture = tex
		mat.emissiveColor = new BABYLON.Color3(1, 1, 1)
		mat.disableLighting = true
		mat.backFaceCulling = false
		mat.alphaMode = BABYLON.Engine.ALPHA_ADD
		mesh.material = mat
		if (billboard) mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
		mesh.isPickable = false
		mesh.isVisible = false
		return mesh
	}

	_next(kind) {
		const list = this._pool[kind]
		const mesh = list[this._idx[kind] % list.length]
		this._idx[kind]++
		return mesh
	}

	_setColor(mesh, rgb, mul = 1) {
		mesh.material.emissiveColor.set(rgb[0] * mul, rgb[1] * mul, rgb[2] * mul)
	}

	// register a pooled mesh into the per-frame fade set. `mode` drives its motion:
	//   'tracer' fades + tapers its cross-section (no laser rope);
	//   'flash'  fades fast at constant scale (muzzle / spark);
	//   'impact' grows slightly as it fades.
	// `power` shapes the fade falloff (1 linear, 2 punchy). No allocation on fire
	// beyond the small entry object (reclaimed as it finishes).
	// drop any live sim entries (fade set + blood) for a pooled mesh about to be
	// reused, so its previous effect can't hide/fight the new one mid-life.
	_reclaim(mesh) {
		for (let i = this._fx.length - 1; i >= 0; i--) {
			if (this._fx[i].mesh === mesh) { this._fx[i] = this._fx[this._fx.length - 1]; this._fx.pop() }
		}
		for (let i = this._blood.length - 1; i >= 0; i--) {
			if (this._blood[i].mesh === mesh) { this._blood[i] = this._blood[this._blood.length - 1]; this._blood.pop() }
		}
	}

	_track(mesh, life, mode, power, sx, sy, sz) {
		// pool recycling can hand out a mesh whose previous effect is still fading;
		// drop the stale entry so it can't hide/fight the new one mid-life
		this._reclaim(mesh)
		mesh.isVisible = true
		mesh.visibility = 1
		mesh.scaling.set(sx, sy, sz)
		this._fx.push({ mesh, t0: performance.now(), life, mode, power, sx, sy, sz })
	}

	// muzzle flash at an explicit world position (barrel tip): a bright additive core
	// + a softer larger glow halo. Reads as flash-with-bloom, no runtime dynamic light.
	// opts.vmLayer renders the flash on the VIEWMODEL camera layer: the local player's
	// gun is drawn depth-cleared over the world, so a world-layer flash would always
	// be painted over by the gun — the flash must live on the same layer to sit ON
	// the barrel tip (remote players' flashes stay in the world layer).
	flashMuzzle(pos, fx, opts = {}) {
		if (!pos) return
		const layer = opts.vmLayer ? 0x10000000 : 0x0FFFFFFF
		const f = fx || resolveWeaponFx(null)
		const m = f.muzzle
		// per-shot scale variance (Vlambeer "vary everything"): a fixed-size flash is
		// the #1 tell of a cheap gun. Roll a single factor so core + glow stay coherent.
		const sJit = 0.8 + Math.random() * 0.45 // ~0.8..1.25
		const core = this._next('muzzle')
		core.layerMask = layer
		core.position.copyFrom(pos)
		core.rotation.z = Math.random() * Math.PI * 2
		this._setColor(core, m.color)
		const cs = m.scale * sJit
		this._track(core, m.life, 'flash', 2, cs, cs, cs)

		const glow = this._next('glow')
		glow.layerMask = layer
		glow.position.copyFrom(pos)
		glow.rotation.z = Math.random() * Math.PI * 2
		this._setColor(glow, m.color, 0.6)
		const gs = m.glowScale * sJit
		this._track(glow, m.life * 1.1, 'flash', 2, gs, gs, gs)

		// pulse the single pre-created world light (see constructor) so the flash
		// briefly licks nearby walls/floor. Newest shot re-stamps it.
		const li = f.light
		// full-auto strobe: some weapons (SMG) only light on a fraction of shots so
		// sustained fire flickers instead of holding a constant, less-violent glow
		// (also a photosensitivity safeguard vs a steady 10Hz+ full-screen light).
		if (li && (li.chance == null || Math.random() <= li.chance)) {
			// vary the peak per shot (Vlambeer): a fixed-brightness flash is a tell.
			const jit = li.jitter || 0
			const peak = li.intensity * (1 - jit * 0.5 + Math.random() * jit)
			this._muzzleLight.position.copyFrom(pos)
			this._muzzleLight.diffuse.set(m.color[0], m.color[1], m.color[2])
			this._muzzleLight.range = li.range || 10
			this._muzzleLight.intensity = peak
			// decayPow shapes the falloff: 2 = front-loaded quadratic (reads as a
			// flash), 1 = linear (reads as a lamp dimming). Default punchy.
			this._muzzleLightPulse = { t0: performance.now(), life: li.life || 70, peak, decayPow: li.decayPow || 2 }
		}

		// barrel smoke: ALWAYS world layer, even for the local player's vm-layer
		// flash — the vm camera clears depth, so a vm-layer puff would paint over
		// the whole world as it drifts. In the world layer it hangs at the muzzle's
		// world position and the gun draws naturally over its near edge.
		const sm = f.smoke
		if (sm && (sm.chance == null || Math.random() <= sm.chance)) {
			const puff = this._next('smoke')
			puff.layerMask = 0x0FFFFFFF
			puff.position.copyFrom(pos)
			const g = sm.gray == null ? 0.5 : sm.gray
			this._setColor(puff, [g, g, g])
			puff.rotation.z = Math.random() * Math.PI * 2
			this._track(puff, sm.life || 700, 'smoke', 1, sm.scale, sm.scale, sm.scale)
		}
	}

	// eject one brass casing: pos/vel are world-space (Simulator derives them from
	// the camera basis so brass flings right-and-back off the gun). delay ms lets
	// pump guns shed the shell on the RACK, not the shot. Pooled; simulated in
	// update() with gravity + one floor bounce, then a quick fade.
	spawnCasing(pos, vel, opts = {}) {
		if (!pos) return
		const mesh = this._next('casing')
		const size = opts.size || 0.02
		const color = opts.color || [0.85, 0.62, 0.22]
		mesh.material.emissiveColor.set(color[0], color[1], color[2])
		mesh.scaling.set(size, size * 2.4, size)
		mesh.position.copyFrom(pos)
		mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
		mesh.isVisible = false // shown when startAt arrives (update loop)
		// replace any stale sim entry for this recycled mesh
		for (let i = this._casings.length - 1; i >= 0; i--) {
			if (this._casings[i].mesh === mesh) {
				this._casings[i] = this._casings[this._casings.length - 1]
				this._casings.pop()
			}
		}
		this._casings.push({
			mesh,
			vel: vel.clone(),
			spin: new BABYLON.Vector3((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22),
			startAt: performance.now() + (opts.delay || 0),
			t0: 0,
			life: 1100,
			bounced: false,
			// floor to bounce off, resolved from the geometry under the muzzle rather than
			// a box-arena constant (the old -0.97 is ~24m ABOVE the Visage deck, so brass
			// ejected at y ~ -23.5 was already "below" it and got snapped up into the sky
			// on the next tick). null over the void = falls forever until its life ends.
			floorY: this._floorYBelow(pos),
		})
	}

	// Draw a hitscan shot: thin additive tracer(s) along the aim, an optional muzzle
	// flash at the origin (opts.muzzle===false when the local player flashes at his own
	// barrel tip), and a surface-aware impact where the client presentation ray hits.
	// Returns { hit, surface, mesh, point } so the caller can drive hit feedback.
	// Presentation only — the server's authoritative hit check is unaffected.
	drawHitscan(spec, opts = {}) {
		const { x, y, z, tx, ty, tz } = spec
		const fx = opts.fx || resolveWeaponFx(null)
		const dir = new BABYLON.Vector3(tx, ty, tz)
		if (!isFinite(dir.length()) || dir.length() < 1e-4) return null // bad/zero aim
		dir.normalize()
		// start the tracer slightly ahead of the shooter so it doesn't self-intersect
		const origin = new BABYLON.Vector3(x, y, z).add(dir.scale(0.6))

		// find the impact point. A single pickWithRay returns ONLY the nearest mesh, so a
		// hit closer than 0.5m does not fall through to the geometry behind it — it VOIDS
		// the whole pick and no impact FX is drawn. The shooter's own hittable box is a
		// 1u cube (half-diagonal 0.707 > the 0.6m origin offset), so a DIAGONAL shot fired
		// from an entity CENTRE starts inside that box and its far wall is the nearest hit
		// (~0.1m out) — cancelling the shot. Local shots dodge it (muzzle ~1.05m forward),
		// but the remote-shot path passes the shooter's centre (Simulator.js), so other
		// players' diagonal aims dropped their impact FX. multiPickWithRay returns ALL
		// hits; take the nearest one PAST 0.5m so a near self-box hit falls THROUGH to the
		// wall behind. (The shooter's nid isn't available at this call site, so the 0.5m
		// fall-through — not a per-nid exclusion — is the fix; the 0.6m offset and 120m
		// fallback are unchanged tuned presentation values.)
		const ray = new BABYLON.Ray(origin, dir, 500)
		const picks = this.scene.multiPickWithRay(ray, this._hitscanPredicate)
		let hit = null
		if (picks) {
			// multiPickWithRay is NOT distance-sorted; scan for the nearest valid hit.
			for (const p of picks) {
				if (p && p.hit && p.pickedPoint && p.distance > 0.5 && (!hit || p.distance < hit.distance)) hit = p
			}
		}
		const hitValid = !!hit
		const end = hitValid ? hit.pickedPoint : origin.add(dir.scale(120))

		// tracer: thin, hot, brief. Multi-pellet weapons call drawHitscan once per
		// REAL pattern ray (common/firePattern.js) with opts.tracer gating a subset,
		// so the streak fan matches the actual pellet directions. A weapon with
		// tracer.chance < 1 (SMG) skips some rounds so full-auto reads as a staccato
		// of streaks, not one solid rope.
		const t = fx.tracer
		if (t && opts.tracer !== false && (t.chance == null || Math.random() <= t.chance)) {
			this._spawnTracer(origin, end, t)
		}

		// muzzle flash at the origin (remote players' shots draw it here)
		if (opts.muzzle !== false) this.flashMuzzle(origin, fx)

		// surface-aware impact
		let surface = null
		if (hitValid) {
			surface = classifySurface(hit.pickedMesh)
			const normal = hit.getNormal ? hit.getNormal(true) : null
			this._spawnImpact(end, normal, surface, fx)
		}
		return { hit: hitValid, surface, mesh: hitValid ? hit.pickedMesh : null, point: hitValid ? end.clone() : null }
	}

	_spawnTracer(origin, end, tcfg) {
		const length = BABYLON.Vector3.Distance(origin, end)
		if (length < 1e-3) return
		const tracer = this._next('tracer')
		tracer.position.copyFrom(origin.add(end).scale(0.5))
		tracer.lookAt(end)
		const w = tcfg.width || 0.02
		this._setColor(tracer, tcfg.core || tcfg.color)
		this._track(tracer, tcfg.life || 55, 'tracer', 1.4, w, w, length)
	}

	_setImpactSprite(mesh, spriteKey, additive) {
		const tex = this._sprites[spriteKey] || this._sprites.hit
		mesh.material.diffuseTexture = tex
		// NO emissiveTexture (see _makeSprite): only SWAP bitmaps here, never toggle the
		// emissive define, so the per-impact path can't recompile the shader mid-frame.
		mesh.material.opacityTexture = tex
		mesh.material.alphaMode = additive ? BABYLON.Engine.ALPHA_ADD : BABYLON.Engine.ALPHA_COMBINE
		// clear any quaternion a prior streak left on this recycled mesh, so Euler
		// rotation.z / billboard / lookAt on the new use take effect
		mesh.rotationQuaternion = null
	}

	_spawnImpact(point, normal, surfaceKey, fx) {
		const s = surfaceFx(surfaceKey)
		const impact = this._next('impact')
		impact.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE
		this._setImpactSprite(impact, s.sprite, s.additive)
		this._setColor(impact, s.color)
		impact.position.copyFrom(point)
		if (normal) {
			impact.position.addInPlace(normal.scale(0.02)) // lift off the surface (z-fight)
			impact.lookAt(point.add(normal))
		}
		const base = (fx.impact ? fx.impact.scale : 0.22) * s.scaleMul
		// power 0.7 = the mark holds nearly full strength then drops away, instead of
		// thinning out immediately (scorches should linger like UT99 wall marks)
		this._track(impact, s.life, 'impact', 0.7, base, base, base)
		// a brief secondary spark on hard surfaces — white-hot additive, small + sharp.
		// Fixed short life: the spark is the FLASH of the hit, the mark is what lingers.
		if (s.spark) {
			const spark = this._next('impact')
			spark.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			this._setImpactSprite(spark, 'spark', true)
			this._setColor(spark, [1.0, 0.95, 0.8], 1.4)
			spark.position.copyFrom(impact.position)
			spark.rotation.z = Math.random() * Math.PI * 2
			this._track(spark, 90, 'flash', 2, base * 1.05, base * 1.05, base * 1.05)
		}
		// a slow dark puff behind the spark (UT99 enforcer-hit smoke): alpha-blended
		// near-black quad that swells and drifts as it dissipates
		if (s.smoke) {
			const smoke = this._next('impact')
			smoke.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			this._setImpactSprite(smoke, 'scorch', false)
			this._setColor(smoke, [0.17, 0.16, 0.16]) // mid-gray so it reads against dark walls
			smoke.position.copyFrom(impact.position)
			if (normal) smoke.position.addInPlace(normal.scale(0.06))
			smoke.rotation.z = Math.random() * Math.PI * 2
			this._track(smoke, 560, 'smoke', 1, base * 1.4, base * 1.4, base * 1.4)
		}
		// flesh: a burst of ballistic blood droplets sprayed off the hit (the diegetic
		// "meat" read, layered under the base wet mark). Pooled + simulated in update().
		if (s.blood) this._spawnBloodBurst(impact.position, normal, base)
	}

	// Blood off a flesh hit, in DISTINCT CLASSES (see the tunables block): a bright
	// additive MIST puff (hot flash), fast velocity-stretched STREAKS, and heavier
	// gravity-bound DROPS — all pooled from the impact pool and simulated in update()'s
	// blood loop. Drops/streaks leave a floor pool where they land. `point` is the
	// (already normal-lifted) hit position; `base` the base impact scale.
	_spawnBloodBurst(point, normal, base) {
		const low = this._fxTier === 'low'
		const nx = normal ? normal.x : 0
		const ny = normal ? normal.y : 0
		const nz = normal ? normal.z : 0
		const now = performance.now()
		// Resolve the floor ONCE per burst (not per droplet): all ~12 particles of a hit
		// start from the same point, so they share a landing surface, and one ray per
		// flesh hit is far cheaper than one per particle. null = nothing underneath (a hit
		// out over the void), in which case no droplet pools — see _floorYBelow.
		const floorY = this._floorYBelow(point)
		const canPool = floorY !== null

		// --- MIST: bright additive puff(s) that expand + fade fast ---
		const mistN = low ? MIST_COUNT_LO : MIST_COUNT_HI
		for (let i = 0; i < mistN; i++) {
			const m = this._next('impact')
			this._reclaim(m)
			m.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			this._setImpactSprite(m, 'blood_mist', !low) // additive on high, alpha on low
			this._setColor(m, MIST_COLOR)
			m.position.copyFrom(point)
			m.rotation.z = Math.random() * Math.PI * 2
			const s0 = base * MIST_SCALE0
			m.scaling.set(s0, s0, s0)
			m.isVisible = true
			m.visibility = MIST_ALPHA0
			this._blood.push({ mesh: m, kind: 'mist', t0: now, life: MIST_LIFE, s0: base * MIST_SCALE0, s1: base * MIST_SCALE1, a0: MIST_ALPHA0 })
		}

		// --- STREAKS: fast, high-drag, velocity-stretched (skipped on low tier) ---
		const streakN = low ? STREAK_COUNT_LO : STREAK_COUNT_HI
		for (let i = 0; i < streakN; i++) {
			const st = this._next('impact')
			this._reclaim(st)
			st.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE // oriented along travel, not camera
			this._setImpactSprite(st, 'blood_streak', false)
			this._setColor(st, STREAK_COLOR)
			st.position.copyFrom(point)
			const vx = nx * STREAK_SPEED + (Math.random() - 0.5) * STREAK_SPREAD
			const vy = ny * STREAK_SPEED + Math.random() * STREAK_SPREAD * 0.5
			const vz = nz * STREAK_SPEED + (Math.random() - 0.5) * STREAK_SPREAD
			const vel = new BABYLON.Vector3(vx, vy, vz)
			const speed = vel.length()
			// orient ONCE at spawn: local +Y along travel, facing the camera → a streak
			const w = base * STREAK_WIDTH
			const len = w + base * speed * STREAK_STRETCH
			st.scaling.set(w, len, 1)
			this._orientStreak(st, vel)
			st.isVisible = true
			st.visibility = 1
			this._blood.push({ mesh: st, kind: 'streak', vel, t0: now, life: STREAK_LIFE, grav: STREAK_GRAVITY, drag: STREAK_DRAG, ground: canPool, floorY })
		}

		// --- DROPS: heavier gravity-bound droplets (thinned, not removed, on low) ---
		const dropN = low ? DROP_COUNT_LO : DROP_COUNT_HI
		for (let i = 0; i < dropN; i++) {
			const d = this._next('impact')
			this._reclaim(d)
			d.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			this._setImpactSprite(d, 'blood_drop', false)
			this._setColor(d, DROP_COLOR)
			d.position.copyFrom(point)
			d.rotation.z = Math.random() * Math.PI * 2
			const sz = base * (DROP_SIZE_MUL + Math.random() * DROP_SIZE_JITTER)
			d.scaling.set(sz, sz, sz)
			d.isVisible = true
			d.visibility = 1
			const vx = nx * DROP_SPEED + (Math.random() - 0.5) * DROP_SPREAD
			const vy = ny * DROP_SPEED + DROP_UP + Math.random() * DROP_UP
			const vz = nz * DROP_SPEED + (Math.random() - 0.5) * DROP_SPREAD
			this._blood.push({ mesh: d, kind: 'drop', vel: new BABYLON.Vector3(vx, vy, vz), t0: now, life: DROP_LIFE, grav: DROP_GRAVITY, ground: !low && canPool, floorY })
		}
	}

	// orient a NON-billboard streak quad so its long (local +Y) axis runs along its
	// velocity and it roughly faces the camera — the cheap velocity-stretch read.
	// Reuses scratch vectors; sets rotationQuaternion (cleared on reuse via
	// _setImpactSprite). Called once at spawn (streaks are brief).
	_orientStreak(mesh, vel) {
		const cam = this.scene.activeCamera
		this._svUp.copyFrom(vel)
		if (this._svUp.lengthSquared() < 1e-6) this._svUp.set(0, 1, 0)
		this._svUp.normalize()
		if (cam) { cam.position.subtractToRef(mesh.position, this._svFwd) } else { this._svFwd.set(0, 0, 1) }
		if (this._svFwd.lengthSquared() < 1e-6) this._svFwd.set(0, 0, 1)
		this._svFwd.normalize()
		BABYLON.Vector3.CrossToRef(this._svUp, this._svFwd, this._svRight) // local X
		if (this._svRight.lengthSquared() < 1e-6) { this._svRight.set(1, 0, 0) } else { this._svRight.normalize() }
		BABYLON.Vector3.CrossToRef(this._svRight, this._svUp, this._svFwd2) // re-orthogonalize Z
		BABYLON.Quaternion.RotationQuaternionFromAxisToRef(this._svRight, this._svUp, this._svFwd2, this._streakQuat)
		mesh.rotationQuaternion = this._streakQuat.clone()
	}

	// World-y of the real floor beneath `point` — the surface a ballistic FX particle
	// (blood drop, brass, gib) should come to rest on.
	//
	// BOX ARENAS have exactly one flat floor, so the legacy constant is both correct and
	// cheaper; we keep it verbatim there. A ray would instead hit the dressing tiles or
	// the -1.03 catch-all slab at subtly different heights and re-introduce the z-fight
	// the hand-picked constant was chosen to avoid, so box arenas take the early out.
	//
	// MESH MAPS have no global floor at all: the artist OBJ is one mesh serving as both
	// visual and collision, its deck sits at an arbitrary world height, and that height
	// VARIES per location (Visage's towers, bridge and deck are all different). So the
	// height is derived from the geometry actually under the effect, which is what makes
	// this correct on any future mesh map at any height rather than only on Visage.
	//
	// FLESH is excluded from the pick: a blood burst originates ON a body, and picking
	// that body would "floor" the blood at chest height inside the corpse. Every pooled
	// FX mesh already sets isPickable=false, so no effect can be its own floor.
	//
	// Returns null when there is nothing below (shot out over the void). Callers treat
	// null as "never lands" — the particle expires mid-air rather than snapping to a
	// phantom floor, which is the correct read over Visage's open edges.
	_floorYBelow(point) {
		if (!USE_MESH_MAP) return GROUND_Y
		const from = new BABYLON.Vector3(point.x, point.y + 0.25, point.z)
		const ray = new BABYLON.Ray(from, new BABYLON.Vector3(0, -1, 0), 400)
		const hit = this.scene.pickWithRay(ray, (m) => this._isSolidWorld(m))
		return (hit && hit.hit && hit.pickedPoint) ? hit.pickedPoint.y : null
	}

	// Is this mesh solid world geometry an FX particle can land on?
	//
	// SOLIDITY IS DECIDED BY checkCollisions, NOT isPickable. That is the whole trick
	// here: _loadMeshMap sets isPickable=false on every map submesh on purpose (the
	// server owns collision, and pick-testing ~450 submeshes is not free) while setting
	// checkCollisions=true, because the client still predicts its own movement against
	// the map. So on a mesh map the floor is invisible to any isPickable-based filter —
	// which is exactly why an isPickable predicate here returned "no floor anywhere"
	// and why drawHitscan's own pick filter (isPickable !== false) never registers a
	// hit on Visage geometry. A predicate passed to pickWithRay overrides isPickable,
	// so testing checkCollisions lets FX see the real floor without making the map
	// pickable for everything else.
	_isSolidWorld(mesh) {
		if (!mesh || mesh.name === 'sky') return false
		// A predicate passed to pickWithRay REPLACES Babylon's built-in isEnabled gate,
		// so _floorYBelow's downward ray (called ~once per shot to seat brass/blood/gibs)
		// otherwise triangle-tests the same disabled weapon-swap leftovers and the skydome
		// backing sphere that bloated the hitscan pick. Skip both here too. (see
		// _isHitscanTarget — same root cause; measured _floorYBelow 1760us -> 860us, ~2x).
		if (!mesh.isEnabled()) return false
		if (this.skydome && (mesh === this.skydome.mesh || mesh.parent === this.skydome.mesh)) return false
		if (classifySurface(mesh) === 'flesh') return false // don't land blood inside a body
		if (mesh.checkCollisions) return true               // mesh-map geometry (non-pickable)
		return mesh.isPickable !== false                    // box-arena floor/obstacles
	}

	// Can a hitscan PRESENTATION ray land an impact (spark/scorch/decal) on this mesh?
	//
	// This is a strict SUPERSET of the filter drawHitscan used to inline
	// (isPickable !== false && name !== 'ground' && name !== 'sky'), composed with
	// _isSolidWorld rather than replaced by it, because the two want opposite things
	// about bodies. Everything the old filter accepted is still accepted:
	//   - PLAYERS: the hittable body is the entity's collision BOX (common/entity/
	//     PlayerCharacter.js names it 'player'), which is pickable, so it comes in via
	//     the isPickable branch. That branch is deliberately tested BEFORE
	//     _isSolidWorld, which REJECTS flesh — right for landing blood on a floor,
	//     fatal here, since Simulator's hitmarker is exactly `surface === 'flesh'`.
	//   - BOX-ARENA floor + obstacles: same isPickable branch (they are pickable and
	//     have no checkCollisions), so non-mesh maps behave exactly as before.
	//   - 'ground' (the box-arena catch-all slab) and 'sky' stay excluded.
	//   - Pooled FX meshes stay excluded: isPickable=false and no checkCollisions, so
	//     neither branch takes them and a spark can't be another spark's impact.
	// What is NEW is the last line: mesh-map submeshes are isPickable=false on purpose
	// (see _loadMeshMap — server owns collision) and so were invisible to the old
	// filter, which is why NO shot ever marked a wall or floor on Visage.
	//
	// The VIEWMODEL exclusion is also new. Viewmodel.js tags its meshes with this
	// layerMask so vmCamera renders them; they are pickable and sit centimetres from
	// the muzzle, so they were both a false impact surface for steeply-angled shots
	// (a scorch decal on your own gun) and — at 7.3k + 9.2k verts for Main_Mesh and
	// ChargeHandle_Mesh — the two most expensive meshes in every pick. Dropping them
	// measured ~27% off the pick cost.
	_isHitscanTarget(mesh) {
		if (!mesh || mesh.name === 'sky' || mesh.name === 'ground') return false
		// A predicate passed to pickWithRay REPLACES Babylon's built-in isEnabled/
		// isVisible/isPickable gating, so DISABLED meshes we could never normally hit
		// still get fully triangle-tested every pick. On Visage that silently made the
		// two most expensive meshes in every hitscan pick a weapon swap's DISABLED
		// leftover gun meshes (Gun_SMG / Gun_Pistol, ~3.3-3.9k tris each, on the WORLD
		// layer so the VM mask below never excluded them) plus the skydome's disabled
		// ~17k-tri backing sphere. Restore the isEnabled gate the default pick always had
		// and only lost because we pass a predicate. (measured 1940us -> 570us median.)
		if (!mesh.isEnabled()) return false
		// The PhotoDome sky mesh is named '<dome>_mesh' ('sky_mesh'), NOT 'sky', so the
		// name guard above never caught the VISIBLE dome: a ~4.6k-tri sphere whose bounding
		// volume encloses the shooter (so it is never culled) yet sits ~1800m out, well
		// past any 500m ray — pure wasted triangle testing on every pellet of every shot.
		// Exclude the dome (and its child) by reference. (570us -> 235us, 8.3x vs shipped.)
		if (this.skydome && (mesh === this.skydome.mesh || mesh.parent === this.skydome.mesh)) return false
		if (mesh.layerMask === VM_LAYER_MASK) return false // local viewmodel: never a surface
		if (mesh.isPickable !== false) return true         // players (flesh), box-arena world
		return this._isSolidWorld(mesh)                    // mesh-map geometry (non-pickable)
	}

	// Leave a flat blood pool on the floor where a droplet landed. Separate pool so a
	// lingering pool isn't recycled by fresh airborne droplets. No mesh decals.
	// `y` is the floor height the droplet actually landed on (_floorYBelow), NOT a
	// global constant — on a mesh map it differs per hit location.
	_spawnGroundPool(x, y, z) {
		const gp = this._next('ground')
		// drop any stale sim entry for this recycled mesh
		for (let i = this._groundPools.length - 1; i >= 0; i--) {
			if (this._groundPools[i].mesh === gp) { this._groundPools[i] = this._groundPools[this._groundPools.length - 1]; this._groundPools.pop() }
		}
		this._setColor(gp, GROUND_COLOR)
		const idx = this._idx.ground % GROUND_POOL
		gp.position.set(x, y + 0.002 + idx * 0.0002, z) // tiny per-index epsilon vs z-fight
		gp.rotation.x = Math.PI / 2
		gp.rotation.y = Math.random() * Math.PI * 2
		const size = GROUND_SIZE + Math.random() * GROUND_SIZE_JITTER
		gp.scaling.set(0.1 * size, 0.1 * size, 1) // grows to `size` over GROUND_GROW
		gp.isVisible = true
		gp.visibility = 1
		this._groundPools.push({ mesh: gp, t0: performance.now(), size, life: GROUND_GROW + GROUND_HOLD + GROUND_FADE })
	}

	// energetic burst where a plasma bolt ended (server-driven entity delete). Pooled.
	plasmaImpact(pos) {
		if (!pos) return
		const s = surfaceFx('energy')
		const impact = this._next('impact')
		impact.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
		this._setImpactSprite(impact, 'spark', true)
		this._setColor(impact, s.color)
		impact.position.copyFrom(pos)
		impact.rotation.z = Math.random() * Math.PI * 2
		this._track(impact, s.life, 'flash', 2, 0.5, 0.5, 0.5)
	}

	// Phase 3: frag-grenade detonation FX at a world position — a big orange fireball
	// core + a softer expanding glow shell + a couple of hot sparks. Reuses the pooled
	// 'impact' meshes (no allocation) and the same _track fade system as plasmaImpact,
	// just scaled up and tinted orange so it reads as an explosion, not an energy zap.
	grenadeExplosion(pos) {
		if (!pos) return
		// bright core fireball
		const core = this._next('impact')
		core.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
		core.layerMask = 0x0FFFFFFF
		this._setImpactSprite(core, 'spark', true)
		this._setColor(core, [1.0, 0.55, 0.15], 1.6) // hot orange
		core.position.copyFrom(pos)
		core.rotation.z = Math.random() * Math.PI * 2
		this._track(core, 300, 'impact', 0.8, 3.2, 3.2, 3.2)

		// softer expanding glow shell
		const glow = this._next('impact')
		glow.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
		glow.layerMask = 0x0FFFFFFF
		this._setImpactSprite(glow, 'spark', true)
		this._setColor(glow, [1.0, 0.35, 0.08], 1.0) // deeper orange
		glow.position.copyFrom(pos)
		glow.rotation.z = Math.random() * Math.PI * 2
		this._track(glow, 420, 'impact', 0.6, 5.0, 5.0, 5.0)

		// a dark scorch smoke puff that swells + lingers
		const smoke = this._next('impact')
		smoke.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
		smoke.layerMask = 0x0FFFFFFF
		this._setImpactSprite(smoke, 'scorch', false)
		this._setColor(smoke, [0.16, 0.14, 0.13])
		smoke.position.copyFrom(pos)
		smoke.rotation.z = Math.random() * Math.PI * 2
		this._track(smoke, 700, 'smoke', 1, 3.0, 3.0, 3.0)

		// a brief bright light pulse if the pooled muzzle light exists (no new lights)
		if (this._muzzleLight) {
			this._muzzleLight.position.copyFrom(pos)
			this._muzzleLightPulse = { t0: performance.now(), life: 260, peak: 2.4, decayPow: 2 }
		}
	}

	// advance every active FX one frame (framerate-independent via wall clock), then
	// render. Finished effects are hidden and reclaimed — the pool never grows.
	update() {
		const now = performance.now()
		// Babylon 9 steps animations by engine.getDeltaTime(), which is only
		// refreshed inside beginFrame()/_measureFps(). This game drives rendering
		// from a manual requestAnimationFrame loop (clientMain.js) rather than
		// engine.runRenderLoop(), so without an explicit beginFrame()/endFrame()
		// bracket the delta stays 0 and every AnimationGroup crawls at ~1ms/frame
		// (~16x too slow). Babylon 4.0.3 stepped animations off absolute wall-clock
		// time so the manual loop needed no bracket; 9.x is delta-based, hence this.
		this.engine.beginFrame()

		// decay the muzzle light pulse back to its idle intensity 0 over the weapon's
		// light.life. decayPow>1 front-loads the energy: peak*(1-t)^2 reads as a FLASH,
		// linear (pow 1) reads as a dimming lamp. The light object is never created/
		// destroyed — the scene's light count stays constant (no shader recompile).
		if (this._muzzleLightPulse) {
			const p = this._muzzleLightPulse
			const t = (now - p.t0) / p.life
			if (t >= 1) {
				this._muzzleLight.intensity = 0
				this._muzzleLightPulse = null
			} else {
				this._muzzleLight.intensity = p.peak * Math.pow(1 - t, p.decayPow || 2)
			}
		}

		const list = this._fx
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i]
			const age = (now - e.t0) / e.life
			if (age >= 1) {
				e.mesh.isVisible = false
				e.mesh.visibility = 1
				list[i] = list[list.length - 1]
				list.pop()
				continue
			}
			const a = fadeAlpha(age, e.power)
			e.mesh.visibility = a
			if (e.mode === 'tracer') {
				const taper = 0.35 + 0.65 * a
				e.mesh.scaling.set(e.sx * taper, e.sy * taper, e.sz)
			} else if (e.mode === 'impact') {
				const g = 1 + (1 - a) * 0.5
				e.mesh.scaling.set(e.sx * g, e.sy * g, e.sz * g)
			} else if (e.mode === 'smoke') {
				// dissipating puff: swells hard as it fades and drifts up a touch
				const g = 1 + (1 - a) * 1.4
				e.mesh.scaling.set(e.sx * g, e.sy * g, e.sz * g)
				e.mesh.position.y += 0.0035
			}
		}

		// simulate ejected brass: gravity + tumble, one floor bounce, brief fade-out.
		// Wall-clock dt (matches the _fx convention above); capped so a hitched frame
		// can't launch casings through the floor.
		const dtMs = this._lastCasingTick ? Math.min(now - this._lastCasingTick, 50) : 16
		this._lastCasingTick = now
		const dt = dtMs / 1000
		const cs = this._casings
		for (let i = cs.length - 1; i >= 0; i--) {
			const c = cs[i]
			if (now < c.startAt) continue // pump-delay: shell not out yet
			if (!c.t0) { c.t0 = now; c.mesh.isVisible = true; c.mesh.visibility = 1 }
			const age = now - c.t0
			if (age >= c.life) {
				c.mesh.isVisible = false
				cs[i] = cs[cs.length - 1]
				cs.pop()
				continue
			}
			c.vel.y -= 9.8 * dt
			c.mesh.position.addInPlace(this._casingScratch.copyFrom(c.vel).scaleInPlace(dt))
			c.mesh.rotation.addInPlace(this._casingScratch.copyFrom(c.spin).scaleInPlace(dt))
			// rest a hair above the floor so the brass sits ON it rather than z-fighting
			// into it (0.03 preserves the old box-arena look: floor -1.00, brass -0.97).
			if (!c.bounced && c.floorY != null && c.mesh.position.y < c.floorY + 0.03) {
				c.mesh.position.y = c.floorY + 0.03
				c.vel.y = Math.abs(c.vel.y) * 0.3
				c.vel.x *= 0.5
				c.vel.z *= 0.5
				c.spin.scaleInPlace(0.35)
				c.bounced = true
			}
			const left = 1 - age / c.life
			if (left < 0.25) c.mesh.visibility = left / 0.25 // fade only the tail
		}

		// simulate blood particles by class (see _spawnBloodBurst). Shares dt with the
		// casing sim above; reuses _bloodVelScratch so nothing allocates per frame.
		//   mist  — no move; expands s0->s1 and fades over its short life.
		//   streak/drop — ballistic (gravity + optional drag); a `ground` one that
		//                 reaches the floor leaves a pool and is retired.
		const bs = this._blood
		for (let i = bs.length - 1; i >= 0; i--) {
			const b = bs[i]
			const f = (now - b.t0) / b.life
			if (f >= 1) {
				b.mesh.isVisible = false
				b.mesh.visibility = 1
				if (b.kind === 'streak') b.mesh.rotationQuaternion = null
				bs[i] = bs[bs.length - 1]
				bs.pop()
				continue
			}
			if (b.kind === 'mist') {
				const s = b.s0 + (b.s1 - b.s0) * f
				b.mesh.scaling.set(s, s, s)
				b.mesh.visibility = b.a0 * (1 - f)
				continue
			}
			// streak / drop: ballistic
			b.vel.y -= b.grav * dt
			if (b.drag) b.vel.scaleInPlace(b.drag)
			this._bloodVelScratch.copyFrom(b.vel).scaleInPlace(dt)
			b.mesh.position.addInPlace(this._bloodVelScratch)
			b.mesh.visibility = fadeAlpha(f, 1)
			// landed? Test against the floor resolved AT SPAWN for this burst, not a global
			// constant: on a mesh map GROUND_Y (-1) is above the deck, so this test was
			// already true on frame 1 and every droplet was retired before it moved.
			if (b.ground && b.mesh.position.y <= b.floorY) {
				if (this._fxTier !== 'low') this._spawnGroundPool(b.mesh.position.x, b.floorY, b.mesh.position.z)
				b.mesh.isVisible = false
				b.mesh.visibility = 1
				if (b.kind === 'streak') b.mesh.rotationQuaternion = null
				bs[i] = bs[bs.length - 1]
				bs.pop()
			}
		}

		// floor blood pools: grow (GROUND_GROW), hold, then fade (GROUND_FADE), recycle.
		const gps = this._groundPools
		for (let i = gps.length - 1; i >= 0; i--) {
			const g = gps[i]
			const age = now - g.t0
			if (age >= g.life) {
				g.mesh.isVisible = false
				g.mesh.visibility = 1
				gps[i] = gps[gps.length - 1]
				gps.pop()
				continue
			}
			const s = age < GROUND_GROW ? g.size * (0.1 + 0.9 * (age / GROUND_GROW)) : g.size
			g.mesh.scaling.set(s, s, 1)
			const fadeStart = g.life - GROUND_FADE
			g.mesh.visibility = age > fadeStart ? Math.max(0, 1 - (age - fadeStart) / GROUND_FADE) : 1
		}

		this.scene.render()
		this.engine.endFrame()
	}
}

export default BABYLONRenderer
