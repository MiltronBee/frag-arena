import * as BABYLON from 'babylonjs'
import 'babylonjs-loaders' // registers the glTF/GLB loader with SceneLoader

// First-person viewmodel locked to the camera. Parented to the camera node so it
// renders in view space. If the model ships animation clips (per the manifest
// `anims`), it plays an idle loop and a one-shot fire clip; otherwise it falls back
// to a code-driven bob + recoil kick. Subtle positional bob is layered on either way.
export default class Viewmodel {
  constructor(scene, camera, spec) {
    this.scene = scene
    this.camera = camera
    this.spec = spec
    this.ready = false
    this.holder = null
    this.groups = {}
    this.idleAnim = null
    this.fireAnim = null
    this._t = 0

    // Spring-based procedural recoil state
    this.recoilPos = new BABYLON.Vector3(0, 0, 0)
    this.recoilPosVel = new BABYLON.Vector3(0, 0, 0)
    this.recoilRot = new BABYLON.Vector3(0, 0, 0)
    this.recoilRotVel = new BABYLON.Vector3(0, 0, 0)

    this.recoilTension = 140   // stiffness of the snap-back spring
    this.recoilDamping = 18    // damping friction

    this._basePos = new BABYLON.Vector3(spec.position.x, spec.position.y, spec.position.z)
    this._baseRotX = (spec.rotation && spec.rotation.x) || 0
    this._wantActive = false // shown only when this is the equipped weapon
    this._load()
  }

  async _load() {
    const url = this.spec.url
    const slash = url.lastIndexOf('/') + 1
    // Babylon 4.0.3's loader result has no transformNodes list, so snapshot the
    // scene around the load to know which joint nodes are ours (dispose() needs
    // them — leaking them piles up dead nodes on every weapon switch).
    const beforeTN = new Set(this.scene.transformNodes)
    const result = await BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), this.scene)
    this._myTransformNodes = this.scene.transformNodes.filter((n) => !beforeTN.has(n))

    this._result = result // kept so dispose() can drop EVERYTHING the load created
    this.meshes = result.meshes
    const root = result.meshes[0]

    // fine-tune offset holder, parented to the camera (bob is applied here too)
    this.holder = new BABYLON.TransformNode('viewmodel', this.scene)
    this.holder.parent = this.camera
    this.holder.position.copyFrom(this._basePos)
    const r = this.spec.rotation || {}
    this.holder.rotation = new BABYLON.Vector3(r.x || 0, r.y || 0, r.z || 0)
    this.holder.scaling.setAll(this.spec.scale)

    root.parent = this.holder

    // barrel-tip socket (camera-local, from the manifest): muzzle flash + the local
    // tracer originate here so shots visibly leave the gun
    this.muzzle = new BABYLON.TransformNode('muzzle', this.scene)
    this.muzzle.parent = this.camera
    const mz = this.spec.muzzle || { x: 0.08, y: -0.14, z: 0.9 }
    this.muzzle.position.set(mz.x, mz.y, mz.z)

    // it sits right on the camera; never cull it, and light it with the dedicated
    // viewmodel light so arms/gun stay legible regardless of where the player looks.
    const vmLight = this.scene.metadata && this.scene.metadata.viewmodelLight
    result.meshes.forEach((m) => {
      m.alwaysSelectAsActiveMesh = true
      m.layerMask = 0x10000000
      if (vmLight && m.getTotalVertices && m.getTotalVertices() > 0) vmLight.includedOnlyMeshes.push(m)
      const mat = m.material
      if (mat) {
        // a touch of self-illumination on top so it never goes fully black
        const tex = mat.albedoTexture || mat.diffuseTexture
        if (tex) { mat.emissiveTexture = tex; mat.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.25) }
      }
    })

    // wire up animation clips if this model has them
    const anims = this.spec.anims || {}
    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    console.log("VIEWMODEL LOADED:", this.spec.name, "Spec anims:", anims, "Available groups:", Object.keys(this.groups));
    this.idleAnim = this.groups[anims.idle]
    this.fireAnim = this.groups[anims.fire]
    if (this.fireAnim && !this.spec.isOneHanded) {
      const leftHandKeywords = ['_l', 'IK_l', 'elbow_l']
      const filtered = this.fireAnim.targetedAnimations.filter(ta => {
        const name = ta.target.name || ta.target.id || ''
        const isLeftHand = leftHandKeywords.some(kw => name.endsWith(kw) || name.includes(kw + '_') || name.includes(kw + '+') || name.toLowerCase().includes('handik_l'))
        return !isLeftHand
      })
      this.fireAnim.targetedAnimations.length = 0
      this.fireAnim.targetedAnimations.push(...filtered)
    }
    this.reloadAnim = this.groups[anims.reload]
    this.drawAnim = this.groups[anims.draw]
    console.log("VIEWMODEL MAPPED ANIMS:", {
      idle: !!this.idleAnim,
      fire: !!this.fireAnim,
      reload: !!this.reloadAnim,
      draw: !!this.drawAnim
    });
    console.log("LOAD RESULT KEYS:", Object.keys(result), "Skeletons in result:", result.skeletons ? result.skeletons.length : 0);
    console.log("Skeletons in scene after load:", this.scene.skeletons.length);

    // Setup procedural left hand IK lock for two-handed weapons
    if (!this.spec.isOneHanded) {
      let weaponNode = this._myTransformNodes.find(n => n.name === 'Main' || n.name === 'Main_Mesh' || n.name === 'Pistol_Mesh')
      if (!weaponNode && this.meshes) {
        weaponNode = this.meshes.find(m => m.name === 'Main' || m.name === 'Main_Mesh' || m.name === 'Pistol_Mesh')
      }

      if (!weaponNode) {
        const weaponKeywords = ['Main', 'Pistol', 'Rifle', 'SMG', 'Shotgun', 'gun', 'weapon']
        for (const tn of this._myTransformNodes) {
          if (weaponKeywords.some(k => tn.name.includes(k)) && !tn.name.toLowerCase().includes('armature')) {
            weaponNode = tn
            break
          }
        }
      }
      if (!weaponNode && this.meshes) {
        const weaponKeywords = ['Main', 'Pistol', 'Rifle', 'SMG', 'Shotgun', 'gun', 'weapon']
        for (const m of this.meshes) {
          if (m.name !== '__root__' && weaponKeywords.some(k => m.name.includes(k)) && !m.name.toLowerCase().includes('armature')) {
            weaponNode = m
            break
          }
        }
      }

      const ikNode = this._myTransformNodes.find(n => n.name === 'ctrl_HandIK_l')

      if (weaponNode && ikNode) {
        this._nodeIK = ikNode
        this._nodeWeapon = weaponNode
        this._ikLockInitialized = false
        
        // Add the observer to enforce the lock after animation evaluations
        this._afterAnimationsObserver = this.scene.onAfterAnimationsObservable.add(() => {
          this._applyProceduralIKLock()
        })
        console.log(`PROCEDURAL IK LOCK: Registered observer to bind left hand IK node "${ikNode.name}" to weapon node "${weaponNode.name}"`);
      } else {
        console.warn(`PROCEDURAL IK LOCK: Could not find weaponNode (${!!weaponNode}) or ikNode (${!!ikNode}) for ${this.spec.name}`);
      }
    }

    this.ready = true
    this._applyActive() // show/hide + idle depending on whether we're equipped
  }

  // equip/unequip this weapon: toggle visibility and idle animation
  setActive(active) {
    this._wantActive = active
    if (this.ready) this._applyActive()
  }

  _applyActive() {
    if (!this.holder) return
    this.holder.setEnabled(this._wantActive)
    console.log("Apply active:", this.spec.name, "wantActive:", this._wantActive, "hasDrawAnim:", !!this.drawAnim);
    if (this._wantActive) {
      // equip: play the weapon-raise (draw) once, then settle into idle
      if (this.drawAnim && !this._drawn) {
        this._drawn = true
        this._drawing = true
        if (this.idleAnim) this.idleAnim.stop()
        this.drawAnim.stop()
        this.drawAnim.onAnimationGroupEndObservable.clear()
        this.drawAnim.onAnimationGroupEndObservable.addOnce(() => {
          console.log("DRAW ANIM ENDED for", this.spec.name);
          this._drawing = false
          if (this._wantActive && this.idleAnim) {
            this.idleAnim.stop()
            this.idleAnim.start(true, 1.0)
          }
        })
        this.drawAnim.start(false, 1.0)
      } else if (this.idleAnim) {
        if (!this.idleAnim.isPlaying) {
          this.idleAnim.stop()
          this.idleAnim.start(true, 1.0)
        }
      }
    } else {
      this._reloading = false
      this._drawing = false
      Object.values(this.groups).forEach((g) => g.stop())
    }
  }

  get isReloading() { return !!this._reloading }

  // world-space barrel tip (for muzzle flash / tracer origin)
  muzzleWorldPos() {
    if (!this.muzzle) return null
    this.muzzle.computeWorldMatrix(true)
    return this.muzzle.getAbsolutePosition()
  }

  cancelReload() {
    if (!this._reloading) return
    this._reloading = false
    if (this.reloadAnim) {
      this.reloadAnim.stop()
    }
    if (this.idleAnim) {
      // Force immediate evaluation of the idle animation frame to snap arm bones
      // out of their reload pose before any fire animations kick in.
      this.idleAnim.goToFrame(this.idleAnim.from)
      this.idleAnim.stop()
    }
    if (this._wantActive && this.idleAnim) {
      this.idleAnim.start(true, 1.0)
    }
  }

  // play the reload clip once (arms + gun bones together: mag out, charge, etc.),
  // then hand back to idle. Firing is blocked while it runs.
  reload() {
    if (!this._wantActive || !this.ready || this._reloading || this._drawing || !this.reloadAnim) return false
    this._reloading = true
    if (this.idleAnim) this.idleAnim.stop()
    if (this.fireAnim) this.fireAnim.stop()
    this.reloadAnim.stop()
    this.reloadAnim.onAnimationGroupEndObservable.clear()
    this.reloadAnim.onAnimationGroupEndObservable.addOnce(() => {
      console.log("RELOAD ANIM ENDED for", this.spec.name);
      this._reloading = false
      if (this._wantActive && this.idleAnim) {
        this.idleAnim.stop()
        this.idleAnim.start(true, 1.0)
      }
    })

    // Calculate dynamic speed ratio to match the spec's reloadTime exactly
    const normalDuration = this.reloadAnim.to - this.reloadAnim.from
    const reloadTime = this.spec.reloadTime || 1.5
    const speedRatio = normalDuration / reloadTime
    console.log(`[RELOAD DEBUG] name=${this.spec.name} normalDuration=${normalDuration} reloadTime=${reloadTime} speedRatio=${speedRatio}`)

    this.reloadAnim.start(false, speedRatio)
    return true
  }

  // called when the local player fires
  kick() {
    if (!this._wantActive || this._reloading || this._drawing) return

    // Inject procedural spring recoil velocities (backward kick in Z, slight pitch up in X, slight horizontal jar)
    const kickForce = this.spec.recoilForce || 1.0
    this.recoilPosVel.z -= 0.6 * kickForce
    this.recoilPosVel.y += 0.08 * kickForce
    this.recoilRotVel.x -= 0.4 * kickForce
    this.recoilRotVel.y += (Math.random() - 0.5) * 0.08 * kickForce

    if (this.fireAnim) {
      if (this.idleAnim) this.idleAnim.stop()
      this.fireAnim.stop()
      this.fireAnim.onAnimationGroupEndObservable.clear()
      this.fireAnim.onAnimationGroupEndObservable.addOnce(() => {
        console.log("FIRE ANIM ENDED for", this.spec.name);
        if (!this._reloading && this._wantActive && this.idleAnim) {
          this.idleAnim.stop()
          this.idleAnim.start(true, 1.0)
        }
      })
      this.fireAnim.start(false, 1.0)
    }
  }

  update(delta, moving) {
    if (!this.ready || !this.holder) return

    // Lazy initialization of procedural IK offsets once matrices are fully evaluated and valid
    if (!this._ikLockInitialized && this._nodeIK && this._nodeWeapon) {
      this._nodeWeapon.computeWorldMatrix(true)
      this._nodeIK.computeWorldMatrix(true)

      const matrix = this._nodeWeapon.getWorldMatrix()
      if (matrix && Math.abs(matrix.determinant()) > 1e-12) {
        // Compute left hand position in weapon's local space
        const invWeaponMatrix = matrix.clone().invert()
        this._leftHandOffset = BABYLON.Vector3.TransformCoordinates(this._nodeIK.getAbsolutePosition(), invWeaponMatrix)
        
        // Compute left hand rotation relative to the weapon
        const weaponQuat = BABYLON.Quaternion.FromRotationMatrix(matrix)
        const ikQuat = BABYLON.Quaternion.FromRotationMatrix(this._nodeIK.getWorldMatrix())
        const invWeaponQuat = BABYLON.Quaternion.Inverse(weaponQuat)
        this._leftHandRotOffset = invWeaponQuat.multiply(ikQuat)

        this._ikLockInitialized = true
        console.log(`PROCEDURAL IK LOCK INITIALIZED for ${this.spec.name} with position offset: ${this._leftHandOffset}`);
      }
    }

    this._t += delta

    // subtle idle/walk bob layered on top of any skeletal animation
    const amp = moving ? 0.02 : 0.006
    const freq = moving ? 9 : 2.5
    const bobY = Math.sin(this._t * freq) * amp
    const bobX = Math.cos(this._t * freq * 0.5) * amp * 0.6

    // Update position and rotation springs for procedural recoil
    const dt = Math.min(delta, 0.1) // Cap dt to avoid spring instability on frame drops
    
    // Position spring: Accel = -Tension * Pos - Damping * Vel
    const posAcc = this.recoilPos.scale(-this.recoilTension).subtract(this.recoilPosVel.scale(this.recoilDamping))
    this.recoilPosVel.addInPlace(posAcc.scale(dt))
    this.recoilPos.addInPlace(this.recoilPosVel.scale(dt))

    // Rotation spring: Accel = -Tension * Rot - Damping * Vel
    const rotAcc = this.recoilRot.scale(-this.recoilTension).subtract(this.recoilRotVel.scale(this.recoilDamping))
    this.recoilRotVel.addInPlace(rotAcc.scale(dt))
    this.recoilRot.addInPlace(this.recoilRotVel.scale(dt))

    // Apply bob + spring recoil to the ViewmodelRoot (holder)
    this.holder.position.set(
      this._basePos.x + bobX + this.recoilPos.x,
      this._basePos.y + bobY + this.recoilPos.y,
      this._basePos.z + this.recoilPos.z
    )
    this.holder.rotation.set(
      this._baseRotX + this.recoilRot.x,
      ((this.spec.rotation && this.spec.rotation.y) || 0) + this.recoilRot.y,
      ((this.spec.rotation && this.spec.rotation.z) || 0) + this.recoilRot.z
    )
  }

  dispose() {
    console.log("Disposing viewmodel:", this.spec.name, "Skeletons in scene before dispose:", this.scene.skeletons.length);
    
    // Clean up observer
    if (this._afterAnimationsObserver) {
      this.scene.onAfterAnimationsObservable.remove(this._afterAnimationsObserver)
    }

    // dispose EVERYTHING the load created — leaked skeletons/transform-nodes with
    // identical bone names cross-wire the next rig's pose in Babylon 4.0.3.
    if (this._result) {
      this._result.animationGroups.forEach((g) => g.dispose())
      this._result.meshes.forEach((m) => m.dispose())
      ;(this._myTransformNodes || []).forEach((n) => n.dispose())
      ;(this._result.skeletons || []).forEach((s) => s.dispose())
      ;(this._result.particleSystems || []).forEach((p) => p.dispose())
    }
    if (this.muzzle) this.muzzle.dispose()
    if (this.holder) this.holder.dispose()
    console.log("Disposed viewmodel:", this.spec.name, "Skeletons in scene after dispose:", this.scene.skeletons.length);
  }

  _applyProceduralIKLock() {
    if (!this._ikLockInitialized) return // Skip until offsets are calculated on a valid frame

    if (this._nodeIK && this._nodeWeapon && this._leftHandOffset && !this._reloading && !this._drawing) {
      this._nodeWeapon.computeWorldMatrix(true)
      
      // Force parent bones/nodes in the armature hierarchy to recompute world matrices 
      // so setAbsolutePosition receives clean, non-stale parent transforms.
      if (this._nodeIK.parent) {
        this._nodeIK.parent.computeWorldMatrix(true)
      }
      
      // Update position
      const targetWorldPos = BABYLON.Vector3.TransformCoordinates(this._leftHandOffset, this._nodeWeapon.getWorldMatrix())
      this._nodeIK.setAbsolutePosition(targetWorldPos)

      // Update rotation
      if (this._leftHandRotOffset) {
        const weaponQuat = BABYLON.Quaternion.FromRotationMatrix(this._nodeWeapon.getWorldMatrix())
        const targetQuat = weaponQuat.multiply(this._leftHandRotOffset)
        this._nodeIK.rotationQuaternion = targetQuat
      }

      this._nodeIK.computeWorldMatrix(true)
    }
  }
}
