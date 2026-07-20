// ============================================================================
// SHARED SIM BARREL — imported by BOTH the client barrel (client/babylon.js)
// and ALL server/common/script code that runs headless under NullEngine.
//
// Curated deep imports into @babylonjs/core so the bundler tree-shakes away
// everything the game doesn't use. This module holds ONLY the sim/collision/
// math/loader surface — NO render-only modules (shadows, glow, photoDome,
// imageProcessing, camera inputs). Those live in client/babylon.js.
//
// NOTE ON `.js` EXTENSIONS: neither @babylonjs/core nor @babylonjs/loaders
// declares a package `exports` map, and both are `"type":"module"`. Plain Node
// ESM (e.g. `node scripts/verify-weapon-anim.mjs`) therefore requires the
// explicit `.js` file extension / `/index.js` on every deep import; tsx and
// Vite add it implicitly but plain node does not. So every specifier below is
// fully-extensioned — it resolves identically under node, tsx AND Vite.
//
// PHASE 3 of the Babylon 4.0.3 -> 9.17.0 migration. Breakage here is
// RUNTIME-SILENT: a missing side-effect import compiles fine and then players
// fall through the floor / hitscan never connects. Do not remove a side-effect
// import without proving (golden-collision + verify-map) it is unused.
// ============================================================================

// ---- SIDE-EFFECT IMPORTS (must come first; they register plugins/prototypes) ----
import '@babylonjs/core/Engines/nullEngine.js'            // NullEngine (headless server + all tsx harnesses)
import '@babylonjs/core/Collisions/collisionCoordinator.js' // CRITICAL: moveWithCollisions/checkCollisions. Missing = walk through walls, fall through floor.
import '@babylonjs/core/Culling/ray.js'                   // Ray.intersectsMesh — hitscan / bot LoS / lag-comp
import '@babylonjs/core/Loading/sceneLoader.js'           // SceneLoader.ImportMeshAsync
import '@babylonjs/loaders/OBJ/index.js'                  // OBJ map collider (server GameInstance._loadMapMesh, data: URI)
import '@babylonjs/core/Meshes/Builders/boxBuilder.js'    // MeshBuilder.CreateBox (PlayerCharacter/Obstacle/MegaHealthPickup + harnesses)
import '@babylonjs/core/Meshes/Builders/sphereBuilder.js' // MeshBuilder.CreateSphere (Projectile/Grenade build meshes under NullEngine)

// ---- NAMED RE-EXPORTS (concrete classes referenced by common/server/scripts) ----
// Each of these class-import specifiers also *is* the side-effect module that
// registers the class; importing to re-export is sufficient registration.
export { Engine } from '@babylonjs/core/Engines/engine.js'
export { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
export { Scene } from '@babylonjs/core/scene.js'
export { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector.js'
export { Axis } from '@babylonjs/core/Maths/math.axis.js'
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
export { Ray } from '@babylonjs/core/Culling/ray.js'
export { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'
export { Mesh } from '@babylonjs/core/Meshes/mesh.js'
export { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
export { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
export { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js'
export { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js' // scripts/verify-weapon-anim.mjs constructs one under NullEngine
// OBJFileLoader carries the static USE_LEGACY_BEHAVIOR flag (set true on both
// sides to keep the 4.0.3 non-mirrored OBJ orientation — see GameInstance.js /
// BABYLONRenderer.js). The class lives on the loaders module, NOT on core.
export { OBJFileLoader } from '@babylonjs/loaders/OBJ/index.js'
// StandardMaterial is referenced (guarded behind a NullEngine check) in
// Projectile/Grenade/MegaHealthPickup. The named binding must resolve even on
// the server; the guard means the constructor never RUNS headless. This class
// import is itself the side-effect module (registers the default material).
export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
