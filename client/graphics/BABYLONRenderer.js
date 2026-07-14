import * as BABYLON from 'babylonjs'
import { resolveWeaponFx, classifySurface, surfaceFx, fadeAlpha } from './firingFx'
import ArenaDressing from './arenaDressing'

// Babylon 4.0.3 declares the WebGL2 PCF shadow helpers (sampler2DShadow params)
// without a precision default. Lenient desktop drivers accept it, but strict
// GLES compilers (SwiftShader, some mobile GPUs) reject the effect, so every
// shadow-receiving material silently falls back to a no-shadow shader — and the
// fallback churn can crash the instanced-mesh VAO bind. Inject the missing
// precision statement into the shader include before any effect compiles.
{
	const store = BABYLON.Effect.IncludesShadersStore
	const inc = store && store.shadowsFragmentFunctions
	if (inc && inc.indexOf('precision highp sampler2DShadow') === -1) {
		store.shadowsFragmentFunctions = inc.replace(
			'#ifdef WEBGL2',
			'#ifdef WEBGL2\nprecision highp sampler2DShadow;'
		)
	}
}

class BABYLONRenderer {
	constructor() {
		this.engine = new BABYLON.Engine(document.getElementById('main-canvas'), true)
		this.engine.enableOfflineSupport = false
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
		this.vmCamera.layerMask = 0x10000000 // Renders only viewmodel meshes

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
		this.shadowGenerator = new BABYLON.ShadowGenerator(1024, sun)
		this.shadowGenerator.useBlurExponentialShadowMap = true
		this.shadowGenerator.blurKernel = 16
		// a bright light that lights ONLY the first-person viewmodel (from the camera's
		// side), so arms/gun are always legible even when the scene key light is behind
		// them. Viewmodels register their meshes into includedOnlyMeshes.
		this.viewmodelLight = new BABYLON.HemisphericLight('vmLight', new BABYLON.Vector3(0.1, 1, 0.6), this.scene)
		this.viewmodelLight.intensity = 0.9 // dimmer than daylight tuning so the arms sit in the dusk scene
		this.viewmodelLight.diffuse = new BABYLON.Color3(0.95, 0.88, 0.8)
		this.viewmodelLight.includedOnlyMeshes = []

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
		this._muzzleLight.diffuse = new BABYLON.Color3(1, 0.8, 0.45)
		this._muzzleLight.specular = new BABYLON.Color3(0.25, 0.2, 0.12)
		this._muzzleLightPulse = null // { t0, life, peak } — decayed in update()

		// expose so character/other visuals can register themselves
		this.scene.metadata = { shadowGenerator: this.shadowGenerator, viewmodelLight: this.viewmodelLight }

		// --- equirectangular skybox (generated dusk, scripts/make-dusk-skybox.py):
		// deep indigo zenith over a burnt-orange horizon — the arena reads dark so
		// the shot FX carry the brightness contrast.
		this.skydome = new BABYLON.PhotoDome('sky', '/assets/sprites/skybox_dusk.png',
			{ resolution: 32, size: 1000 }, this.scene)
		// PhotoDome's inner mesh is named '<name>_mesh'; keep fog off it so it isn't washed out
		const skyMesh = this.scene.getMeshByName('sky_mesh')
		if (skyMesh) skyMesh.applyFog = false

		// --- distance fog: dark slate, a touch denser — swallows the far arena into
		// gloom for depth without hiding mid-range targets
		this.scene.fogMode = BABYLON.Scene.FOGMODE_EXP2
		this.scene.fogColor = new BABYLON.Color3(0.05, 0.05, 0.08)
		this.scene.fogDensity = 0.008

		// --- ground: dark asphalt catch-all under the kit floor tiles (sits a hair
		// lower so the tiles don't z-fight it); still the shadow receiver of record
		const plane = BABYLON.MeshBuilder.CreatePlane('ground', { size: 60 }, this.scene)
		plane.rotation.x = Math.PI * 0.5
		plane.position.y = -1.03
		const groundMat = new BABYLON.StandardMaterial('groundMat', this.scene)
		groundMat.diffuseColor = new BABYLON.Color3(0.11, 0.11, 0.13)
		groundMat.specularColor = new BABYLON.Color3(0.08, 0.07, 0.06)
		plane.material = groundMat
		plane.receiveShadows = true

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

		// --- SciFi MegaKit arena skin (floor tiles, wall panels, columns, crates).
		// Loads async; obstacles keep the legacy box look until attachObstacle
		// upgrades them, and forever if the kit fails to load.
		this.arenaDressing = new ArenaDressing(this.scene, this.shadowGenerator)

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
		}

		// Sized per role: impacts largest — a shotgun rosette burns 8 marks/shot and
		// scorches linger seconds so wall patterns stay readable (firingFx SURFACE_FX).
		// smoke = barrel puffs, pooled SEPARATELY from impacts so a lingering muzzle
		// puff can't recycle away a wall scorch (the wall pattern is weapon identity).
		const POOLS = { tracer: 24, muzzle: 12, glow: 12, impact: 64, casing: 24, smoke: 12 }
		this._pool = { tracer: [], muzzle: [], glow: [], impact: [], casing: [], smoke: [] }
		this._idx = { tracer: 0, muzzle: 0, glow: 0, impact: 0, casing: 0, smoke: 0 }
		this._fx = [] // active fading effects, advanced every frame in update()
		this._casings = [] // active brass, simulated every frame in update()
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
			this._pool.muzzle.push(this._makeSprite('muzzle' + i, this._sprites.muzzle, true))
			this._pool.glow.push(this._makeSprite('glow' + i, this._sprites.glow, true))
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
		// compile the shaders now so the first shot never binds an unready effect
		this._pool.tracer[0].material.forceCompilation(this._pool.tracer[0])
		this._pool.muzzle[0].material.forceCompilation(this._pool.muzzle[0])
		this._pool.impact[0].material.forceCompilation(this._pool.impact[0])
		this._pool.casing[0].material.forceCompilation(this._pool.casing[0])
		this._pool.smoke[0].material.forceCompilation(this._pool.smoke[0])

		this.scene.executeWhenReady(() => { console.log('SCENE READY') })

		// needed for certain shaders, though none in this simple demo
		this.engine.runRenderLoop(() => { })
	}

	_loadTex(url) {
		const tex = new BABYLON.Texture(url, this.scene)
		tex.hasAlpha = true
		return tex
	}

	// a pooled sprite quad with its OWN additive material (texture shared across the
	// kind). billboard = always face the camera (muzzle/glow). Non-billboard sprites
	// (impacts) are oriented to the surface normal per shot instead.
	_makeSprite(name, tex, billboard) {
		const mesh = BABYLON.MeshBuilder.CreatePlane(name, { size: 1 }, this.scene)
		const mat = new BABYLON.StandardMaterial(name + 'Mat', this.scene)
		mat.diffuseTexture = tex
		mat.emissiveTexture = tex
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
	_track(mesh, life, mode, power, sx, sy, sz) {
		// pool recycling can hand out a mesh whose previous effect is still fading;
		// drop the stale entry so it can't hide/fight the new one mid-life
		for (let i = this._fx.length - 1; i >= 0; i--) {
			if (this._fx[i].mesh === mesh) {
				this._fx[i] = this._fx[this._fx.length - 1]
				this._fx.pop()
			}
		}
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
		const core = this._next('muzzle')
		core.layerMask = layer
		core.position.copyFrom(pos)
		core.rotation.z = Math.random() * Math.PI * 2
		this._setColor(core, m.color)
		this._track(core, m.life, 'flash', 2, m.scale, m.scale, m.scale)

		const glow = this._next('glow')
		glow.layerMask = layer
		glow.position.copyFrom(pos)
		this._setColor(glow, m.color, 0.6)
		this._track(glow, m.life * 1.1, 'flash', 2, m.glowScale, m.glowScale, m.glowScale)

		// pulse the single pre-created world light (see constructor) so the flash
		// briefly licks nearby walls/floor. Newest shot re-stamps it.
		const li = f.light
		if (li) {
			this._muzzleLight.position.copyFrom(pos)
			this._muzzleLight.diffuse.set(m.color[0], m.color[1], m.color[2])
			this._muzzleLight.range = li.range || 10
			this._muzzleLight.intensity = li.intensity
			this._muzzleLightPulse = { t0: performance.now(), life: li.life || 70, peak: li.intensity }
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

		// find the impact point; ignore very-near hits (the shooter's own box) and
		// fall back to a long ray if nothing is hit
		const ray = new BABYLON.Ray(origin, dir, 500)
		const hit = this.scene.pickWithRay(ray, (m) => m.isPickable !== false && m.name !== 'ground' && m.name !== 'sky')
		const hitValid = hit && hit.hit && hit.pickedPoint && hit.distance > 0.5
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
		mesh.material.emissiveTexture = tex
		mesh.material.opacityTexture = tex
		mesh.material.alphaMode = additive ? BABYLON.Engine.ALPHA_ADD : BABYLON.Engine.ALPHA_COMBINE
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

	// advance every active FX one frame (framerate-independent via wall clock), then
	// render. Finished effects are hidden and reclaimed — the pool never grows.
	update() {
		const now = performance.now()

		// decay the muzzle light pulse back to its idle intensity 0 (linear over the
		// weapon's light.life). The light object itself is never created/destroyed.
		if (this._muzzleLightPulse) {
			const p = this._muzzleLightPulse
			const t = (now - p.t0) / p.life
			if (t >= 1) {
				this._muzzleLight.intensity = 0
				this._muzzleLightPulse = null
			} else {
				this._muzzleLight.intensity = p.peak * (1 - t)
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
			c.mesh.position.addInPlace(c.vel.scale(dt))
			c.mesh.rotation.addInPlace(c.spin.scale(dt))
			if (!c.bounced && c.mesh.position.y < -0.97) {
				c.mesh.position.y = -0.97
				c.vel.y = Math.abs(c.vel.y) * 0.3
				c.vel.x *= 0.5
				c.vel.z *= 0.5
				c.spin.scaleInPlace(0.35)
				c.bounced = true
			}
			const left = 1 - age / c.life
			if (left < 0.25) c.mesh.visibility = left / 0.25 // fade only the tail
		}

		this.scene.render()
	}
}

export default BABYLONRenderer
