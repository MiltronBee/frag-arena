// ============================================================================
// CLIENT BARREL — the ONLY Babylon import specifier the client render code uses.
//
// = the shared sim barrel (common/babylon.node.js) + the render feature slice.
// Curated deep imports so rollup tree-shakes PBR/GUI/physics/XR/particles/
// node-material/post-process/~13 loaders OUT of the prod bundle.
//
// All specifiers are fully-extensioned (`.js` / `/index.js`) — @babylonjs/core
// and @babylonjs/loaders ship no package `exports` map, so this resolves
// identically under Vite, tsx and plain node (see common/babylon.node.js).
//
// PHASE 3 of Babylon 4.0.3 -> 9.17.0. Breakage is RUNTIME-SILENT: a missing
// render side-effect import yields a black screen / vanished shadows /
// "MeshBuilder.CreateBox is not a function" — never a build error. Every
// side-effect line below is load-bearing; removing one silently breaks the
// specific feature it registers.
// ============================================================================

// Materials/effect MUST evaluate before any material module so the shader
// include store exists before the first material compiles. Kept as the literal
// first statement so it precedes the node-barrel (which pulls standardMaterial).
import '@babylonjs/core/Materials/effect.js'

// ---- the shared sim/collision/math/loader surface (re-exported wholesale) ----
export * from '../common/babylon.node.js'

// ---- RENDER SIDE-EFFECT IMPORTS (ordered) ----
import '@babylonjs/core/Loading/loadingScreen.js'                     // SceneLoader default loading UI
import '@babylonjs/loaders/glTF/index.js'                             // glTF/GLB: Viewmodel, CharacterModel, arenaDressing, AnimPlayground
import '@babylonjs/core/Animations/animatable.js'                     // Animatable (glTF animation playback)
import '@babylonjs/core/Animations/animationGroup.js'                 // AnimationGroup (weapon/character clips)
import '@babylonjs/core/Lights/Shadows/shadowGenerator.js'           // ShadowGenerator
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js' // makes materials SAMPLE the shadow map — missing = shadows silently vanish
import '@babylonjs/core/Layers/glowLayer.js'                          // GlowLayer
import '@babylonjs/core/Helpers/photoDome.js'                         // PhotoDome skydome
import '@babylonjs/core/Materials/Background/backgroundMaterial.js'   // PhotoDome renders on BackgroundMaterial
import '@babylonjs/core/Materials/Textures/renderTargetTexture.js'    // RenderTargetTexture (REFRESHRATE_RENDER_ONCE shadow freeze)
import '@babylonjs/core/Materials/imageProcessingConfiguration.js'    // VIGNETTEMODE_MULTIPLY
import '@babylonjs/core/Materials/standardMaterial.js'                // CRITICAL: default + all StandardMaterials. Missing = everything black.
import '@babylonjs/core/Materials/Textures/texture.js'                // Texture
import '@babylonjs/core/Materials/Textures/dynamicTexture.js'         // DynamicTexture (HUD/label textures)
import '@babylonjs/core/Meshes/instancedMesh.js'                      // mesh.createInstance (arena dressing)
// Explicit shape builders — each registers its MeshBuilder.Create* method.
// (box + sphere already registered by the node barrel.)
import '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'          // MeshBuilder.CreateCylinder
import '@babylonjs/core/Meshes/Builders/groundBuilder.js'            // MeshBuilder.CreateGround
import '@babylonjs/core/Meshes/Builders/planeBuilder.js'            // MeshBuilder.CreatePlane
// AnimPlayground uses cam.attachControl (ArcRotateCamera) — register its inputs.
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput.js'
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraMouseWheelInput.js'
import '@babylonjs/core/Cameras/Inputs/arcRotateCameraKeyboardMoveInput.js'

// ---- RENDER NAMED RE-EXPORTS (client-only classes; sim classes — incl.
// StandardMaterial — come via `export *` from the node barrel above) ----
export { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
export { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
export { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js'
export { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js'
export { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js'
export { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js'
export { PhotoDome } from '@babylonjs/core/Helpers/photoDome.js'
export { Light } from '@babylonjs/core/Lights/light.js'
export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
export { PointLight } from '@babylonjs/core/Lights/pointLight.js'
export { TargetCamera } from '@babylonjs/core/Cameras/targetCamera.js'
export { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js'
export { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js'

// ---- window.BABYLON (3 in-page harness scripts read it: probe-anim,
// verify-fire-attachment, verify-helmet-anims; plus shot-objmap/shot-visage).
// Sourced from THIS barrel's own curated namespace — NOT the @babylonjs/core
// root barrel — so it exposes exactly the tree-shaken slice and does not
// re-drag the full library back into the bundle. ----
import * as FragBabylon from './babylon.js'
if (typeof window !== 'undefined') {
	window.BABYLON = FragBabylon
}
