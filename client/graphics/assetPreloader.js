import { assets, weapons, tpWeapons } from '../assets/assetManifest'
import { warmViewmodel } from './Viewmodel'
import { warmProp, warmBody } from './CharacterModel'
import { WEAPON_MODEL_URL, AMMO_MODEL_URL } from '../../common/pickupConfig'
import { SPAWN_WEAPON_INDEX } from '../../common/weaponsConfig'

// FULL PRELOAD GATE — the arena is not enterable until EVERY asset is actually
// imported (GLBs parsed, not merely fetched) and GPU-warmed (materials/shaders
// force-compiled, bone textures uploaded). This is the load-everything-behind-
// the-menu contract from _work/ui/RECON-siblings.md: after this resolves, NO
// ImportMesh / fetch / decode is reachable from any in-game code path, so the
// weapon-swap hitch and mid-import races are impossible by construction.
//
// It previously only warmed the HTTP cache (fetch + drain); GLBs still parsed on
// first in-match use. Now it:
//   - imports every first-person weapon viewmodel rig (Viewmodel warm) and
//     compiles its shaders, then disposes the throwaway copy;
//   - imports every third-person held-weapon prop + the helmet to compile their
//     shaders + prime the browser cache, then disposes the copy (in-match _loadProp
//     lazily caches the template from the warm cache on first mount — no hitch,
//     and no session-long template meshes for props that may never be used);
//   - imports the character body once, compiles its skinned shaders, disposes it
//     (the browser cache + warm shader make each real player's import hitch-free);
//   - resolves the UI web fonts (Chakra Petch / Teko / Inter) before the splash
//     text measures, so layout never reflows;
//   - awaits the scifi arena-dressing load (the "MAP" stage).
//
// PUBLIC INTERFACE: preloadAssets(renderer, arenaReadyPromise, onProgress).
//   - renderer: the BABYLONRenderer (supplies .scene for importing/warming).
//   - arenaReadyPromise: arena-dressing load promise, counted as the MAP unit.
//   - onProgress(frac[, stageLabel]): 0..1 aggregate + a human stage label
//     (MAP / CHARACTERS / WEAPONS / SOUNDS / EFFECTS / FINALIZING).
// Returns a Promise that resolves only once everything is imported and warm.
//
// Progress is byte-weighted (approx MB per item) so the bar tracks real load
// time — otherwise it jumps to ~90% after the small files then crawls through
// the ~20MB body, which is exactly the slow part we cover.

// UI fonts to resolve before splash text renders (self-hosted via @font-face in
// index.html). Weighted tiny — they are local woff2, this only guards first paint.
const UI_FONTS = [
  '700 1em "Chakra Petch"',
  '700 italic 1em "Chakra Petch"',
  '600 1em "Chakra Petch"',
  '600 1em "Teko"',
  '500 1em "Teko"',
  '600 1em "Inter"',
  '400 1em "Inter"',
]

function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) {
    return Promise.resolve()
  }
  return Promise.all(UI_FONTS.map((f) => document.fonts.load(f).catch(() => null)))
    .then(() => (document.fonts.ready || Promise.resolve()).catch(() => null))
}

// Warm the announcer voice clips into the HTTP cache (fetch-only; no decode — there is no
// AudioContext until the user-gesture resume in WeaponAudio). Reads the manifest so the set
// tracks whatever generate-announcer.mjs shipped. Non-fatal: a miss just means WeaponAudio
// fetches that clip cold later. Cache-busted with __BUILD_ID__ to match WeaponAudio's keys.
function warmAnnouncer() {
  if (typeof fetch === 'undefined') return Promise.resolve()
  const v = (typeof window !== 'undefined' && window.__BUILD_ID__) ? '?v=' + window.__BUILD_ID__ : ''
  return fetch('/assets/sfx/announcer/index.json' + v)
    .then((r) => (r.ok ? r.json() : null))
    .then((manifest) => {
      const clips = manifest && manifest.clips ? Object.values(manifest.clips) : []
      const urls = clips.map((c) => c && c.file).filter(Boolean)
      return Promise.allSettled(urls.map((f) => fetch('/assets/sfx/' + f + v).then((r) => r.arrayBuffer())))
    })
    .catch(() => null)
}

export default function preloadAssets(renderer, arenaReadyPromise, onProgress) {
  const scene = renderer && renderer.scene

  // Each entry: { w: MB weight, stage: label, run: () => Promise }. Stage labels
  // map the real loader steps onto the ~6 human stages the design spec lists.
  const items = []

  // MAP — scifi arena dressing (already loading; we just await it here).
  items.push({ w: 3, stage: 'MAP', run: () => Promise.resolve(arenaReadyPromise) })

  // CHARACTERS — the heavy third-person body (import + warm + dispose the copy),
  // plus the helmet prop (warm + dispose the copy).
  items.push({ w: 20, stage: 'CHARACTERS', run: () => warmBody(scene, assets.playerBody.url) })
  if (assets.playerBody.helmet && assets.playerBody.helmet.url) {
    items.push({ w: 0.5, stage: 'CHARACTERS', run: () => warmProp(scene, assets.playerBody.helmet.url) })
  }

  // WEAPONS — every first-person viewmodel rig (parse + shader-warm) and every
  // third-person held-weapon prop (shader-warm + dispose the copy).
  // Skip the spawn weapon: the equipped weapon's LIVE viewmodel rig is already
  // instantiated (Simulator constructs weapons[SPAWN_WEAPON_INDEX] before preload
  // runs), so warming it would put a second skeleton of the same rig in the scene
  // alongside the live one — the exact duplicate-skeleton cross-wire Babylon 4.0.3
  // forbids (only the equipped rig may exist). The live rig's own import already
  // warmed its shader + browser cache.
  weapons.forEach((spec, i) => {
    if (i !== SPAWN_WEAPON_INDEX && spec && spec.url) {
      items.push({ w: 2, stage: 'WEAPONS', run: () => warmViewmodel(scene, spec) })
    }
  })
  tpWeapons.forEach((wp) => {
    if (wp && wp.url) {
      items.push({ w: 0.3, stage: 'WEAPONS', run: () => warmProp(scene, wp.url) })
    }
  })

  // EFFECTS — the thrown frag-grenade prop model. Parse the GLB + shader-warm +
  // prime the browser cache behind the loading gate so the first grenade thrown
  // in-match mounts from the warm cache with zero ImportMesh hitch (matches the
  // no-in-match-import contract in the header). Cloned per grenade in
  // createFactories' Grenade factory via loadPropTemplate.
  items.push({ w: 0.5, stage: 'EFFECTS', run: () => warmProp(scene, '/assets/props/Prop_Grenade.gltf') })

  // EFFECTS — the Phase 4 mega-health pickup prop. Warmed behind the gate like the
  // grenade so the first in-match mount (createFactories' MegaHealthPickup factory,
  // via loadPropTemplate) hits the warm browser cache + compiled shader with no hitch.
  items.push({ w: 0.5, stage: 'EFFECTS', run: () => warmProp(scene, '/assets/props/Prop_HealthPack.gltf') })

  // EFFECTS — UT-STYLE PICKUP models. The on-floor weapon pickups (tp_*.glb) and the
  // ammo box (Prop_Ammo) previously popped in on first sight — they weren't in any warm
  // pass. Warm each UNIQUE weapon-pickup model (Plasma/Flak reuse Rifle/Shotgun, so the
  // Set dedupes to 4 files) plus the ammo box behind the gate, so the first pickup mount
  // (createFactories.attachPickupModel via loadPropTemplate) hits a warm browser cache +
  // compiled shader with zero ImportMesh hitch. Health (Prop_HealthPack) is already warmed
  // above; the drop-on-death weapons reuse these same tp_*.glb models. Non-fatal on miss.
  const pickupModelUrls = new Set(Object.values(WEAPON_MODEL_URL))
  pickupModelUrls.add(AMMO_MODEL_URL)
  pickupModelUrls.forEach((url) => {
    items.push({ w: 0.3, stage: 'EFFECTS', run: () => warmProp(scene, url) })
  })

  // SOUNDS — warm the ANNOUNCER voice clips into the HTTP cache behind the gate so
  // WeaponAudio's first decode (on the user-gesture resume) is instant. Fetch-only (no
  // AudioContext exists yet at preload time — WeaponAudio decodes them itself). The set is
  // read from the shipped manifest so it always matches what generate-announcer.mjs wrote.
  // Cache-busted with the SAME __BUILD_ID__ WeaponAudio uses, so the warm entry hits.
  items.push({ w: 0.5, stage: 'SOUNDS', run: () => warmAnnouncer() })

  // FINALIZING — resolve UI fonts (labeled generically so the last stage the
  // player sees reads as "wrapping up").
  items.push({ w: 0.5, stage: 'FINALIZING', run: () => loadFonts() })

  const totalW = items.reduce((s, it) => s + it.w, 0)
  let doneW = 0
  let stage = items[0] ? items[0].stage : 'LOADING'
  const report = () => {
    if (onProgress) onProgress(totalW > 0 ? doneW / totalW : 1, stage)
  }
  report()

  // Run the heavy imports SEQUENTIALLY. Parallel ImportMeshAsync of several rigs
  // against Babylon 4.0.3 can cross-wire concurrent imports (the same reason the
  // in-match swap serializes), and a warm pass is not latency-critical. A failed
  // warm is non-fatal — that asset just imports normally later (slower, but the
  // gate must never wedge the player out of the arena).
  let chain = Promise.resolve()
  items.forEach((it) => {
    chain = chain.then(() => {
      stage = it.stage
      report()
      return Promise.resolve()
        .then(() => it.run())
        .catch((err) => { console.warn('[preload] warm failed:', it.stage, err); return null })
        .then(() => { doneW += it.w; report() })
    })
  })
  return chain
}
