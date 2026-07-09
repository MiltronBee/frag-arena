import * as BABYLON from 'babylonjs'

class BABYLONRenderer {
	constructor() {
		this.engine = new BABYLON.Engine(document.getElementById('main-canvas'), true)
		this.engine.enableOfflineSupport = false
		this.scene = new BABYLON.Scene(this.engine)
		this.scene.collisionsEnabled = true
		this.scene.detachControl() // we're doing our own camera!
		// sky-tinted clear so any area the skybox dome doesn't cover (corners) blends in
		this.scene.clearColor = new BABYLON.Color3(0.78, 0.74, 0.9)

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

		// --- lighting: soft ambient fill + a directional key light that casts shadows
		const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0.2), this.scene)
		ambient.intensity = 0.55
		ambient.groundColor = new BABYLON.Color3(0.3, 0.3, 0.35)

		const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.5, -1, 0.4), this.scene)
		sun.position = new BABYLON.Vector3(30, 60, -30)
		sun.intensity = 1.1
		this.shadowGenerator = new BABYLON.ShadowGenerator(1024, sun)
		this.shadowGenerator.useBlurExponentialShadowMap = true
		this.shadowGenerator.blurKernel = 16
		// a bright light that lights ONLY the first-person viewmodel (from the camera's
		// side), so arms/gun are always legible even when the scene key light is behind
		// them. Viewmodels register their meshes into includedOnlyMeshes.
		this.viewmodelLight = new BABYLON.HemisphericLight('vmLight', new BABYLON.Vector3(0.1, 1, 0.6), this.scene)
		this.viewmodelLight.intensity = 1.5
		this.viewmodelLight.includedOnlyMeshes = []

		// expose so character/other visuals can register themselves
		this.scene.metadata = { shadowGenerator: this.shadowGenerator, viewmodelLight: this.viewmodelLight }

		// --- equirectangular skybox (Kenney CC0) for depth + a horizon to read motion against
		this.skydome = new BABYLON.PhotoDome('sky', '/assets/sprites/skybox.png',
			{ resolution: 32, size: 1000 }, this.scene)
		// PhotoDome's inner mesh is named '<name>_mesh'; keep fog off it so it isn't washed out
		const skyMesh = this.scene.getMeshByName('sky_mesh')
		if (skyMesh) skyMesh.applyFog = false

		// --- light distance fog for depth (kept subtle so the arena stays readable)
		this.scene.fogMode = BABYLON.Scene.FOGMODE_EXP2
		this.scene.fogColor = new BABYLON.Color3(0.16, 0.17, 0.25)
		this.scene.fogDensity = 0.006

		// --- ground: muted material instead of pure white, and it receives shadows
		const plane = BABYLON.MeshBuilder.CreatePlane('ground', { size: 60 }, this.scene)
		plane.rotation.x = Math.PI * 0.5
		plane.position.y = -1
		const groundMat = new BABYLON.StandardMaterial('groundMat', this.scene)
		groundMat.diffuseColor = new BABYLON.Color3(0.22, 0.24, 0.28)
		groundMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05)
		plane.material = groundMat
		plane.receiveShadows = true

		// --- shot FX are POOLED. Creating meshes/materials mid-frame races the shader
		// + VAO compilation and crashes the GL bind on strict drivers (e.g. SwiftShader).
		// So we build every FX mesh + material once here, force-compile their shaders,
		// and at runtime only toggle visibility + transform. No allocation on fire.
		this._muzzleMat = this._spriteMaterial('muzzleMat', '/assets/sprites/retro_muzzleflash.png')
		// the pack's flash texture is authored for additive blending (black background)
		this._muzzleMat.alphaMode = BABYLON.Engine.ALPHA_ADD
		this._impactMat = this._spriteMaterial('impactMat', '/assets/sprites/hit.png')
		this._tracerMat = new BABYLON.StandardMaterial('tracerMat', this.scene)
		this._tracerMat.disableLighting = true
		this._tracerMat.emissiveColor = new BABYLON.Color3(1, 0.7, 0.2)

		const POOL = 10
		this._pool = { tracer: [], muzzle: [], impact: [] }
		this._idx = { tracer: 0, muzzle: 0, impact: 0 }
		for (let i = 0; i < POOL; i++) {
			const tracer = BABYLON.MeshBuilder.CreateBox('tracer' + i, { size: 1 }, this.scene)
			tracer.material = this._tracerMat
			tracer.isPickable = false
			tracer.isVisible = false
			this._pool.tracer.push(tracer)

			const muzzle = BABYLON.MeshBuilder.CreatePlane('muzzle' + i, { size: 1 }, this.scene)
			muzzle.material = this._muzzleMat
			muzzle.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			muzzle.isPickable = false
			muzzle.isVisible = false
			this._pool.muzzle.push(muzzle)

			const impact = BABYLON.MeshBuilder.CreatePlane('impact' + i, { size: 1 }, this.scene)
			impact.material = this._impactMat
			impact.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
			impact.isPickable = false
			impact.isVisible = false
			this._pool.impact.push(impact)
		}
		// compile the shaders now so the first shot never binds an unready effect
		this._tracerMat.forceCompilation(this._pool.tracer[0])
		this._muzzleMat.forceCompilation(this._pool.muzzle[0])
		this._impactMat.forceCompilation(this._pool.impact[0])

		this.scene.executeWhenReady(() => { console.log('SCENE READY') })

		// needed for certain shaders, though none in this simple demo
		this.engine.runRenderLoop(() => { })
	}

	_spriteMaterial(name, url) {
		const mat = new BABYLON.StandardMaterial(name, this.scene)
		const tex = new BABYLON.Texture(url, this.scene)
		tex.hasAlpha = true
		mat.diffuseTexture = tex
		mat.emissiveTexture = tex
		mat.opacityTexture = tex
		mat.emissiveColor = new BABYLON.Color3(1, 1, 1)
		mat.disableLighting = true
		mat.backFaceCulling = false
		return mat
	}

	// grab the next pooled mesh of a kind, show it, and hide it again after `ms`
	_show(kind, ms) {
		const list = this._pool[kind]
		const mesh = list[this._idx[kind] % list.length]
		this._idx[kind]++
		mesh.isVisible = true
		mesh._hideAt = performance.now() + ms
		setTimeout(() => { if (performance.now() >= mesh._hideAt - 1) mesh.isVisible = false }, ms)
		return mesh
	}

	// muzzle flash at an explicit world position (the local player's barrel tip)
	flashMuzzle(pos) {
		if (!pos) return
		const muzzle = this._show('muzzle', 55)
		muzzle.position.copyFrom(pos)
		muzzle.scaling.setAll(0.35)
	}

	// draws a shot: a glowing tracer along the aim, a muzzle flash at the origin
	// (unless opts.muzzle === false — the local player draws his own at the barrel
	// tip via flashMuzzle), and an impact spark where the ray hits. All pooled.
	drawHitscan(spec, color, opts) {
		const { x, y, z, tx, ty, tz } = spec
		const dir = new BABYLON.Vector3(tx, ty, tz)
		if (!isFinite(dir.length()) || dir.length() < 1e-4) return // bad/zero aim
		dir.normalize()
		// start the tracer slightly ahead of the shooter so it doesn't self-intersect
		const origin = new BABYLON.Vector3(x, y, z).add(dir.scale(0.6))

		// find the impact point; ignore very-near hits (the shooter's own box) and
		// fall back to a long ray if nothing is hit
		const ray = new BABYLON.Ray(origin, dir, 500)
		const hit = this.scene.pickWithRay(ray, (m) => m.isPickable !== false && m.name !== 'ground' && m.name !== 'sky')
		const hitValid = hit && hit.hit && hit.pickedPoint && hit.distance > 0.5
		const end = hitValid ? hit.pickedPoint : origin.add(dir.scale(120))
		const length = BABYLON.Vector3.Distance(origin, end)

		// tracer: a thin box stretched from origin to end
		if (color) this._tracerMat.emissiveColor = color
		const tracer = this._show('tracer', 80)
		tracer.position.copyFrom(origin.add(end).scale(0.5))
		tracer.lookAt(end)
		tracer.scaling.set(0.06, 0.06, length)

		// muzzle flash at the origin (remote players' shots)
		if (!opts || opts.muzzle !== false) {
			const muzzle = this._show('muzzle', 55)
			muzzle.position.copyFrom(origin)
			muzzle.scaling.setAll(0.6)
		}

		// impact spark where it hit
		if (hitValid) {
			const impact = this._show('impact', 120)
			impact.position.copyFrom(end)
			impact.scaling.setAll(0.5)
		}
	}

	update(delta) {
		this.scene.render()
	}
}

export default BABYLONRenderer
