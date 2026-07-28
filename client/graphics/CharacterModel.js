import * as BABYLON from '../babylon.js'
import { armorUrlFor } from '../assets/assetManifest'
import { tpWeapons } from '../assets/assetManifest'
import { USE_MESH_MAP } from '../../common/mapMesh'

// TDM TEAM COLORS. Classic RED (team 0) vs BLUE (team 1): maximum hue separation,
// universally read as "us vs them" in competitive shooters, and distinguishable for
// the common red-green color-vision deficiencies (red vs blue, not red vs green).
//
// Team identity is carried by DETAILED UNIFORM TEXTURES (spec.teamSkins — full
// repaints of the body's albedo atlas: tactical suit with team accent panels;
// see scripts/gemini-uniform-texture.mjs) swapped onto the body material per
// teamId. The old full-body emissive color-wash is gone; what remains is a
// SUBTLE team emissive (~12% of the old wash) so the team still reads in one
// glance at 30m+ / in dark corners, without flattening the suit detail. The
// nametag keeps the brighter CSS variant for the at-a-glance call.
// RED glow is biased toward ORANGE (green lifted off pure red) per the banger
// brief S2: protans see pure red much darker, so an orange-red cue survives on
// luminance, not just hue. BLUE stays cobalt. Magnitude kept at the ~12-15% the
// brief calls right for a dark-map read without flattening the suit detail.
const TEAM_BODY_GLOW = [new BABYLON.Color3(0.11, 0.050, 0.012), new BABYLON.Color3(0.012, 0.036, 0.11)]
const TEAM_NAMETAG_CSS = ['#ff5a5a', '#5aa6ff']

// SELF-LIT SUIT (retro/UT99 fix for "reads as flat colour in dark maps"): drive
// the suit material's emissiveTexture FROM its own team albedo, multiplied by a
// dim team-tinted colour. Emissive = albedo * this, so the fabric/plating detail
// stays visible in an unlit corner (~40% of albedo) instead of collapsing to a
// silhouette — without a white blowout, and the tint keeps the team read warm/cool.
// SAFE against bloom: the scene GlowLayer is include-only (muzzle/tracer sprites
// only — see BABYLONRenderer), so the body is never added and never blooms.
// The red multiplier is warm-biased (orange-safe for protans); floor stays >= the
// TEAM_BODY_GLOW level the hair/eyes keep.
const TEAM_SUIT_EMISSIVE = [new BABYLON.Color3(0.50, 0.40, 0.32), new BABYLON.Color3(0.32, 0.40, 0.54)]

// FFA NEUTRAL (mode-wide, not a team): everyone wears the same matching BLACK
// uniform. Glow/emissive follow the same two-layer scheme as the team constants
// above, just untinted — a whisper of cool gray so the black suit still separates
// from an unlit corner without reading as any team color. Nametags go neutral too.
const NEUTRAL_BODY_GLOW = new BABYLON.Color3(0.030, 0.032, 0.038)
const NEUTRAL_SUIT_EMISSIVE = new BABYLON.Color3(0.34, 0.35, 0.38)
const NEUTRAL_NAMETAG_CSS = '#d8dbe0'

// Shared team-uniform textures (one GPU texture per url per scene — every body on
// a team samples the same texture). invertY=false matches the glTF loader's UV
// convention (glTF images are top-left origin; a default Babylon Texture would
// load them flipped).
// HELMET SKIN (helmets rendered GREY — helmet_0.glb ships two flat near-black
// materials with no textures). scripts/make-helmet-texture.py paints a UV-AGNOSTIC
// allover gunmetal skin; _skinHelmet applies it to the shared template materials ONCE.
// The helmet is TWO materials (shell + a large jaw-pod) on a PACKED faceplate unwrap,
// so a placed feature (a brow band) scatters and a per-material teal accent reads as a
// glowing chin (both verified in Blender). So EVERY helmet material gets the SAME
// gunmetal skin — dark machined armour that reads as equipment from any angle. Neutral,
// like the FFA black uniform (the helmet is one shared prop for all players).
const HELMET_SKIN_URL = '/assets/props/helmet_skin.webp'
const HELMET_NORM_URL = '/assets/props/helmet_skin_n.webp'

// ---- "IT'S JUST GREY" — why metal props needed this ---------------------------
// This scene has NO environmentTexture (no IBL): grep BABYLONRenderer, there is a
// PhotoDome starfield for the sky but nothing is ever assigned to
// scene.environmentTexture. A glTF PBR material with a high `metallic` gets almost no
// diffuse contribution — a metal's look comes from what it REFLECTS — so with nothing
// to reflect it renders as a flat grey/near-black blob NO MATTER WHAT its albedo map
// says. The helmet shipped at metallic 0.6 and the third-person guns at metallic 1.0,
// which is exactly why both read as untextured grey while their albedo textures were
// bound and fully loaded (verified in-game: albedo ready:true, still grey).
//
// Every other prop in this project already works around the same hole the same way —
// the uniforms, the floor pickups, even the Moon drive their own albedo through
// `emissiveTexture` so the art survives the darkness. So rather than introduce IBL
// (new assets + a whole-scene relight), metal props are brought back the established
// way: pull `metallic` down so the albedo contributes real diffuse, push `roughness`
// up so the remaining highlight is broad instead of a pinpoint, and add a dim self-lit
// pass off the prop's own albedo.
const METAL_FIX_EMISSIVE = 0.30 // self-lit scale on the prop's own albedo
const METAL_FIX_METALLIC = 0.25 // was 0.6 (helmet) / 1.0 (guns) with nothing to reflect
const METAL_FIX_ROUGHNESS = 0.55

// De-metalize + self-light one PBR material so its albedo actually reads without IBL.
// Guarded by a marker because these materials are SHARED with the warm-cache template
// (root.clone() shares materials), so this costs one pass per material, not per player.
export function _fixUnlitMetal(mat) {
  if (!mat || mat._metalFixed) return
  mat._metalFixed = true
  if ('metallic' in mat && typeof mat.metallic === 'number') mat.metallic = METAL_FIX_METALLIC
  if ('roughness' in mat && typeof mat.roughness === 'number') mat.roughness = Math.max(mat.roughness === 1 ? 0 : mat.roughness, METAL_FIX_ROUGHNESS)
  // glTF ORM maps drive metalness per-texel and would re-blacken the surface; the
  // scalar above only wins once the texture is out of the way.
  if ('metallicTexture' in mat && mat.metallicTexture) mat.metallicTexture = null
  // Leave anything that is ALREADY self-lit alone — the armour gem ships a deliberate
  // purple emissive (KHR_materials_emissive_strength) and must keep its glow.
  const alreadyGlows = mat.emissiveColor &&
    (mat.emissiveColor.r + mat.emissiveColor.g + mat.emissiveColor.b) > 0.01
  if ('emissiveTexture' in mat && !alreadyGlows) {
    const src = mat.albedoTexture || mat.diffuseTexture
    if (src && !mat.emissiveTexture) mat.emissiveTexture = src
    // With no albedo map to re-drive (untextured props like the armour plates), fall back
    // to a dim wash of the material's own base colour so it still lifts off the black.
    if (mat.emissiveColor) {
      const c = src ? null : mat.albedoColor
      if (c) mat.emissiveColor.set(c.r * METAL_FIX_EMISSIVE, c.g * METAL_FIX_EMISSIVE, c.b * METAL_FIX_EMISSIVE)
      else mat.emissiveColor.set(METAL_FIX_EMISSIVE, METAL_FIX_EMISSIVE, METAL_FIX_EMISSIVE)
    }
  }
}

// ---- POLISHED GOLD ARMOUR (why the plates do NOT take the _fixUnlitMetal path) ----
// _fixUnlitMetal is the right rescue for a TEXTURED metal prop: de-metalize it and its
// albedo map does the storytelling. The armour plates have NO albedo map — just a gold
// baseColorFactor — so the same treatment leaves a single flat cream tone across every
// plate, i.e. cream plastic. What sells metal is not its colour but the fact that it
// MIRRORS something, and this scene's missing scene.environmentTexture is the whole
// problem.
//
// Fix: give the gold material its OWN reflectionTexture. PBRMaterial falls back to
// reflectionTexture whenever the scene has no environmentTexture, so one tiny stylized
// equirect (scripts/make-armor-env.py -> armor_env.png, 256x128, dark floor / hot amber
// horizon / cool sky / one elongated key window) buys real, camera-tracking reflections
// on the armour and NOTHING ELSE in the scene changes. Deliberately not a scene-wide
// environmentTexture: that would relight every map, every prop and every uniform.
const ARMOR_ENV_URL = '/assets/props/armor_env.png'
const ARMOR_ENV_CUBE_SIZE = 128 // faces built from a 256x128 source; more is wasted detail
// Tuned in the playground against the shipped env (a 3-way A/B at 2 orbit angles).
const ARMOR_METALLIC = 0.95     // near-pure metal now that there IS something to reflect.
                                // Not a flat 1.0: the last 5% of diffuse is what still
                                // ties the plates to the map's own lights instead of
                                // making them look pasted on with a fixed studio look.
const ARMOR_ROUGHNESS = 0.28    // polished, not chrome. Higher blurs the horizon band into
                                // the ambient and the "polished" read dies; lower turns the
                                // low-poly plate's flat facets into a crystal mosaic.
const ARMOR_ENV_INTENSITY = 2.6 // the env is a deliberately DARK LDR png (contrast lives in
                                // its band + windows, not its ambient), so it needs lifting.
                                // Paired with the env's PEAK budget: hot spots clip in RED
                                // only, staying saturated gold instead of blowing to white.
const ARMOR_SELF_LIT = 0.06     // whisper of base-colour emissive: the void has no fill
                                // light, and without this the shadow side crushes to black

// One cube per scene, shared by every armour material and every player.
const _armorEnvCache = new WeakMap() // scene -> EquiRectangularCubeTexture
function _armorEnv(scene) {
  if (!scene) return null
  let env = _armorEnvCache.get(scene)
  if (env) return env
  try {
    // gammaSpace=true: the PNG is authored/stored sRGB-encoded, so let Babylon linearize it.
    env = new BABYLON.EquiRectangularCubeTexture(ARMOR_ENV_URL, scene, ARMOR_ENV_CUBE_SIZE)
  } catch (e) { return null }
  _armorEnvCache.set(scene, env)
  return env
}

// Make ONE armour material read as polished metal. Same shared-material guard as
// _fixUnlitMetal (and it sets that marker too, so a later _fixUnlitMetal call on the
// same material is a no-op and can never de-metalize the plates behind our back).
export function _makeArmorMetal(mat, scene) {
  if (!mat || mat._metalFixed) return
  // The chest gem ships a deliberate purple KHR_materials_emissive_strength glow. It is
  // not metal and must not be reflective — hand it to the existing path unchanged.
  const alreadyGlows = mat.emissiveColor &&
    (mat.emissiveColor.r + mat.emissiveColor.g + mat.emissiveColor.b) > 0.01
  if (alreadyGlows) { _fixUnlitMetal(mat); return }
  if (!('metallic' in mat)) { _fixUnlitMetal(mat); return } // not a PBRMaterial -> old path
  mat._metalFixed = true
  mat._armorMetal = true

  const env = _armorEnv(scene || mat.getScene())
  if (!env) { _fixUnlitMetal(mat); return } // env failed to build -> never leave it black

  mat.reflectionTexture = env
  mat.environmentIntensity = ARMOR_ENV_INTENSITY
  mat.metallic = ARMOR_METALLIC
  mat.roughness = ARMOR_ROUGHNESS
  // An ORM map would drive metalness per-texel and override the scalar above. The armour
  // ships none, but stay defensive — the same trap _fixUnlitMetal guards against.
  if ('metallicTexture' in mat && mat.metallicTexture) mat.metallicTexture = null
  // A metal has no diffuse: albedoColor IS its reflectance tint (gold's F0). Keep the
  // exporter's baseColorFactor exactly as authored and let the reflection carry the look.
  if (mat.emissiveColor) {
    const c = mat.albedoColor
    if (c) mat.emissiveColor.set(c.r * ARMOR_SELF_LIT, c.g * ARMOR_SELF_LIT, c.b * ARMOR_SELF_LIT)
    else mat.emissiveColor.set(0, 0, 0)
  }
  mat.emissiveTexture = null // no flat wash: the reflection is the whole point
}

// ---- TEAM SILVER (BLUE fields the same set in silver, RED keeps the gold) ---------
// The plates are ONE material per prop, SHARED by every player (a mesh clone keeps its
// template's material), so a per-team look cannot be a property tweak on the mounted
// piece — it has to be a second material. `_armorSilverMaterial` clones the FINISHED
// gold material once per source and caches the twin on it, so the whole session pays
// +1 material per armour prop, not per player, and the reflection cube is still the
// single shared cube (Material.clone copies texture handles by reference).
//
// Which team: RED is 0, BLUE is 1 — same indexing as TEAM_NAMETAG_CSS / TEAM_BODY_GLOW
// at the top of this file. FFA (neutral) keeps gold: with no teams there is nothing to
// tell apart, and gold is the authored look.
const ARMOR_SILVER_TEAM = 1
// A metal has no diffuse: albedoColor IS its reflectance (F0), so "silver" is not a
// paint job, it is a NEUTRAL and much HIGHER-value reflectance where gold's is warm and
// dark. Derived from each source colour instead of hardcoded, so the dark recess trim
// (ArmorTrim, a deliberately read-dark warm brown) stays proportionally dark rather
// than being promoted into a second bright plate: take the source's strongest channel
// as its value, lift it, and hang a barely-cool neutral on it.
const SILVER_LIFT = 1.15        // gold's 0.82 -> 0.94: silver reflects broadband where
                                // gold eats blue, so it has to sit materially higher or
                                // it reads as "dirty gold" rather than a different metal.
// The cool lean is NOT stylistic licence, it is the correction for the environment. The
// armour's only light is armor_env.png, whose dominant feature is a hot AMBER horizon
// band, so a dead-neutral reflectance comes back champagne — i.e. pale gold, which is the
// one thing this must not read as (A/B'd at (0.96,0.98,1.0) vs this vs (0.80,0.90,1.0):
// the first is visibly warm, the third starts tinting the plates blue and stops looking
// like bare metal). This lands on polished-steel neutral in the finished frame.
const SILVER_TINT = new BABYLON.Color3(0.88, 0.94, 1.00)
// Silver returns ~1.5x gold's luminance, so re-using the gold environmentIntensity would
// push the amber band AND both windows past clipping in all three channels at once — a
// white blob, i.e. exactly the "shiny plastic bead" failure the PEAK budget in
// scripts/make-armor-env.py exists to avoid. Scale the intensity back by that factor so
// silver samples the same env over the same on-screen value range gold does.
const SILVER_ENV_INTENSITY = 1.75

const _armorSilverCache = new WeakMap() // gold armour material -> its silver twin

// The silver twin of one FINISHED armour material (i.e. after _makeArmorMetal). Anything
// that did not take the armour-metal path is returned unchanged — that is the chest gem,
// which ships a violet KHR_materials_emissive_strength glow and stays violet on both
// teams.
function _armorSilverMaterial(mat) {
  if (!mat || !mat._armorMetal) return mat
  const cached = _armorSilverCache.get(mat)
  if (cached) return cached
  const silver = mat.clone(mat.name + '_silver')
  if (!silver) return mat
  // Carry the markers across so a later _fixUnlitMetal / _makeArmorMetal on the twin is
  // a no-op and can never de-metalize the plates behind our back.
  silver._metalFixed = true
  silver._armorMetal = true
  const c = mat.albedoColor
  const v = c ? Math.min(1, Math.max(c.r, c.g, c.b) * SILVER_LIFT) : 0.9
  // Fresh Color3s, never a copyFrom: the clone may still be holding the GOLD material's
  // own colour objects, and mutating those would turn every red player silver too.
  silver.albedoColor = new BABYLON.Color3(v * SILVER_TINT.r, v * SILVER_TINT.g, v * SILVER_TINT.b)
  silver.environmentIntensity = SILVER_ENV_INTENSITY
  // same whisper of self-light as the gold, recomputed off the NEW base colour
  silver.emissiveColor = silver.albedoColor.scale(ARMOR_SELF_LIT)
  silver.emissiveTexture = null
  _armorSilverCache.set(mat, silver)
  return silver
}

// Apply the gunmetal skin uniformly to a mounted helmet's meshes. Idempotent via a
// per-material marker (materials are shared across all helmet clones, so this runs at
// most twice for the whole session). One Texture instance is shared by both materials.
export function _skinHelmet(scene, meshes) {
  const tex = (url) => new BABYLON.Texture(url, scene, false, false) // noMipmap=false, invertY=false (project convention)
  let albedo = null, normal = null
  for (const m of meshes) {
    const mat = m.material
    if (!mat || mat._helmetSkinned) continue
    mat._helmetSkinned = true
    albedo = albedo || tex(HELMET_SKIN_URL)
    normal = normal || tex(HELMET_NORM_URL)
    if ('albedoTexture' in mat) { mat.albedoTexture = albedo; if (mat.albedoColor) mat.albedoColor.set(1, 1, 1) }
    else if ('diffuseTexture' in mat) mat.diffuseTexture = albedo
    if ('bumpTexture' in mat) mat.bumpTexture = normal
    if (mat.emissiveColor) mat.emissiveColor.set(0, 0, 0) // kill the GLB's stale near-black emissive
    // metallic 0.6 with no environment to reflect was the "grey helmet" itself — see
    // _fixUnlitMetal. It re-drives this same albedo through emissive, so the skin reads.
    _fixUnlitMetal(mat)
  }
}

// Is armour wanted this session? The manifest flag is the default; ?armor=1 / ?armor=0
// in the URL overrides it, which is what makes an in-game fit pass possible at all (the
// pieces mount on OTHER players, so they are only ever visible from a second client).
function _armorWanted(spec) {
  try {
    const q = new URLSearchParams(window.location.search).get('armor')
    if (q === '1' || q === 'true') return true
    if (q === '0' || q === 'false') return false
  } catch (e) { /* no window/search -> fall through to the manifest */ }
  return !!spec.armorEnabled
}

const _teamTexCache = new Map() // url -> BABYLON.Texture
function _teamTexture(scene, url) {
  const cached = _teamTexCache.get(url)
  // Recreate if the cached texture is dead or belongs to a torn-down scene.
  // NOTE: isDisposed() is a Node/mesh method — BaseTexture does NOT expose it in
  // every Babylon build (it throws "isDisposed is not a function" on the babylon9
  // upgrade), so guard the call and lean on getScene() as the portable staleness
  // check (a disposed/foreign texture reports a null or different scene).
  const dead = cached && (
    (typeof cached.isDisposed === 'function' && cached.isDisposed()) ||
    (typeof cached.getScene === 'function' && cached.getScene() !== scene)
  )
  if (!cached || dead) {
    const tex = new BABYLON.Texture(url, scene, false, false)
    _teamTexCache.set(url, tex)
    return tex
  }
  return cached
}

// A visual character bound to (but not parented to) a host transform — typically
// another player's replicated collision box. Each frame it copies the host's
// position + yaw and picks idle/run from how fast the host is moving. Pitch is
// intentionally ignored so bodies don't tilt when a player looks up/down.
//
// NB: Babylon 4.0.3 has no AssetContainer.instantiateModelsToScene, so we import
// a fresh copy per entity via ImportMeshAsync (the HTTP fetch is browser-cached).
// Fine for a handful of players; revisit with true GPU instancing if it scales.
//
// CLIP PRIORITY (highest wins): death > shoot > hit > run/idle. `current` is the
// looping locomotion clip; one-shots (shoot/hit/death) play as overlays on top.
// CRITICAL repo constraint: Babylon's AnimationGroup.stop() FIRES the group's end
// observable — so every one-shot registers its end-handler through _onEndOnce(),
// which is token-guarded so a stale/late/recursive end callback is a no-op.

// ---------------------------------------------------------------------------
// Shared third-person weapon prop cache. Loaded ONCE per url; each CharacterModel
// clones the cached meshes into its own hierarchy (so we never re-fetch per
// player). Cloned props carry no skeleton/anims — they're static geometry.
// ---------------------------------------------------------------------------
const _propCache = new Map() // url -> Promise<{ meshes: AbstractMesh[] }>

// Feet-to-origin offset for the ACTIVE map type. Box arenas draw their visual
// floor 0.5 below the collision-box bottom, mesh maps use one mesh for both —
// so the body needs a different drop on each. See assetManifest playerBody.
// Falls back to spec.yOffset when a spec predates yOffsetMeshMap.
const bodyYOffset = (spec) =>
  (USE_MESH_MAP && spec.yOffsetMeshMap !== undefined ? spec.yOffsetMeshMap : spec.yOffset)

// ---------------------------------------------------------------------------
// SINGLE-FLIGHT body import. The preload warm (warmBody) and the first real
// player's _load both want the same ~20MB hero_male.glb, and they fire close
// enough together to race — the browser CANNOT dedupe two identical in-flight
// requests, so the network waterfall showed the GLB fetched TWICE in parallel.
//
// We coalesce the FIRST import per url into one in-flight promise. A live
// CharacterModel needs its OWN skeleton + animationGroups (Babylon 4.0.3 has no
// instantiateModelsToScene, so copies can't be shared), so exactly one consumer
// may "claim" the imported result and own its meshes; everyone else must import
// their own copy — but by then the bytes are in the HTTP cache, so no second
// network download happens. warmBody is a THROWAWAY consumer: it claims the
// shared import only if no live model beat it to it, otherwise it piggybacks on
// the live import (and disposes nothing — the live model owns it).
// ---------------------------------------------------------------------------
const _bodyFlight = new Map() // url -> { promise: Promise<result>, claimed: bool }

function _importBodyRaw(scene, url) {
  const slash = url.lastIndexOf('/') + 1
  return BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, slash), url.slice(slash), scene)
}

// Return the single-flight import, starting it if none is running. Does NOT
// claim ownership — caller decides whether to claim (own the meshes) or just
// piggyback (warm path with nothing to dispose if a live model already claimed).
function _bodyFlightPromise(scene, url) {
  let flight = _bodyFlight.get(url)
  if (!flight) {
    flight = { promise: _importBodyRaw(scene, url), claimed: false }
    _bodyFlight.set(url, flight)
  }
  return flight
}

// A live CharacterModel calls this for its own instance. If the shared in-flight
// import is still unclaimed, take ownership of that result (no second fetch, no
// second parse). If none exists yet (this live load beat the preload warm), START
// the single-flight and immediately claim it, so a later warmBody piggybacks on
// THIS import rather than firing its own duplicate 20MB fetch. Only when the flight
// is already claimed by someone else do we import a fresh copy — which now hits the
// browser cache the first import primed, so it's parse-only, no network download.
async function _claimBodyImport(scene, url) {
  let flight = _bodyFlight.get(url)
  if (!flight) flight = _bodyFlightPromise(scene, url)
  if (!flight.claimed) {
    flight.claimed = true
    return flight.promise
  }
  return _importBodyRaw(scene, url)
}

// The death clip (UAL1 Death01) is ~2.375s — nearly the full RESPAWN_DELAY_MS
// (2.5s), so at 1x speed the fall barely fits before the respawn cancels the
// corpse, and any network jitter on the Killed packet truncates it (the body
// pops upright mid-fall). Play it faster so it completes in ~1.3s, leaving >1s
// of dead-hold slack against the respawn. See _applyDeathClip.
const DEATH_CLIP_SPEED = 1.8

// How long the death clip gets to prove it is actually driving the rig before we give
// up on it. setCorpse has already stopped locomotion by then, so a clip that never
// evaluates leaves NOTHING animating the skeleton and the body stands frozen in BIND
// POSE (arms out, gun horizontal) for the whole corpse window. See _applyDeathClip.
const DEATH_CLIP_WATCHDOG_MS = 120
const DEATH_CLIP_WATCHDOG_FRAMES = 4 // ...and this many frames, so a slow client can't trip it

// HIT-STOP (client-cosmetic "impact freeze"): on taking damage a body's animation
// near-freezes for a few dozen ms, the empirically top-leverage cue that a hit
// landed. Purely visual — driven off the replicated hitpoints watch, never on the
// input/prediction path, and always skipped while a corpse (death owns the rig).
const HIT_STOP_SPEED = 0.08 // speedRatio during the freeze (0.08 = near-frozen)
const HIT_STOP_MAX_MS = 120 // cap so a burst of hits can't stack into a long freeze
const KILL_STOP_MAX_MS = 140 // Doom kill-emphasis freeze on the victim body (NOT global slow-mo)

// ---- LOCOMOTION STABILITY ---------------------------------------------------
// A remote body's position is INTERPOLATED from network snapshots, so the per-frame
// delta is uneven even while the player runs at a constant speed. The original clip
// picker turned that noisy delta straight into a decision with a single speed
// threshold and a bare |forward| >= |right| comparison — and because switching clips
// calls group.start(), which restarts the stride from frame 0, every borderline frame
// visibly reset the legs. Near a 45-degree diagonal (the common case: strafing while
// running) the two axes trade places constantly, so the body twitched every few frames.
// Three cheap guards fix it, in increasing order of bluntness:
//   1. hysteresis   — separate enter/exit speeds instead of one threshold
//   2. dominance    — the other axis must WIN by a margin to take the body
//   3. dwell        — a hard floor on how often locomotion may change at all
// Plus phase carry-over on the swap itself, so a legitimate change of clip keeps the
// stride's cadence instead of snapping back to frame 0.
const RUN_ENTER_SPEED = 0.55 // start jogging above this (units/s of smoothed motion)
const RUN_EXIT_SPEED = 0.30  // ...and only fall back to idle below this
const DIR_MARGIN = 1.30      // rival axis must beat the current one by 30% to take over
const LOCO_DWELL_MS = 180    // minimum time on a locomotion clip before another swap

function _loadProp(scene, url) {
  if (_propCache.has(url)) return _propCache.get(url)
  const slash = url.lastIndexOf('/') + 1
  const rootUrl = url.slice(0, slash)
  const fileName = url.slice(slash)
  const p = BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene).then((result) => {
    // keep a hidden template root; instances clone from it and get enabled.
    const root = result.meshes[0]
    root.setEnabled(false)
    result.meshes.forEach((m) => { m.isPickable = false })
    return { root }
  })
  _propCache.set(url, p)
  return p
}

// Public re-export of the shared prop loader so non-character visuals (e.g. the
// thrown grenade) can mount the SAME cached template the preloader warms —
// without duplicating the ImportMesh+cache logic. Returns the cached
// { root } template (a hidden, disabled node); callers clone from it.
export function loadPropTemplate(scene, url) {
  return _loadProp(scene, url)
}

// ---------------------------------------------------------------------------
// PRELOAD / GPU-WARM helpers (called by the boot preloader, NOT in-match).
//
// The goal: by the time the arena is enterable, every third-person prop the
// game will ever mount already lives in `_propCache`, and every GLB the game
// imports has been parsed + had its materials shader-compiled once. After this,
// `setWeapon`/`_mountHelmet` hit the cache with zero ImportMesh, and the first
// in-match frame binds no unready effect (the mid-match weapon-swap hitch and
// import races the RECON doc flags are removed by construction).
// ---------------------------------------------------------------------------

// Force the GL shaders for every material on a set of meshes to compile now, so
// the first frame they render never triggers a mid-frame compile/VAO bind.
function _warmMaterials(meshes) {
  const seen = new Set()
  meshes.forEach((mesh) => {
    const mat = mesh.material
    if (!mat || seen.has(mat) || !mat.forceCompilation) return
    seen.add(mat)
    try { mat.forceCompilation(mesh) } catch (e) { /* non-fatal */ }
  })
}

// Import a third-person prop (weapon/helmet) into the shared cache and warm its
// shaders. Idempotent per url. The template root stays disabled in the scene so
// in-match clones are pure CPU clones (no fetch, no decode).
export async function warmProp(scene, url) {
  if (!url) return
  // THROWAWAY warm: import to compile shaders + prime the browser cache, then fully
  // dispose. We deliberately do NOT populate _propCache here — pre-caching every tp
  // weapon + helmet would keep hidden template meshes/materials in the scene for the
  // whole session (props that may never be used this match). In-match, _loadProp still
  // lazily caches the template on first real mount, now hitting the warmed browser
  // cache + compiled shader so it lands without a hitch.
  const slash = url.lastIndexOf('/') + 1
  const result = await BABYLON.SceneLoader.ImportMeshAsync(
    '', url.slice(0, slash), url.slice(slash), scene)
  result.meshes.forEach((m) => { m.setEnabled(false); m.isPickable = false })
  _warmMaterials(result.meshes)
  result.animationGroups.forEach((g) => g.stop())
  result.meshes.forEach((m) => m.dispose(false, true))
  result.animationGroups.forEach((g) => g.dispose())
  ;(result.skeletons || []).forEach((s) => s.dispose())
}

// Import the heavy character body ONCE, compile its skinned-mesh shaders, then
// dispose the throwaway copy. Each real player still imports its own instance
// (Babylon 4.0.3 lacks instantiateModelsToScene), but that import now hits the
// browser cache AND a warmed shader program, so it lands without a hitch.
export async function warmBody(scene, url) {
  if (!url) return
  // Warm via the SINGLE-FLIGHT import so we don't race a real player's _load into
  // a duplicate 20MB download. We claim the shared import only if no live model
  // grabbed it first; if a live model already claimed it, we piggyback on the same
  // in-flight promise (its shaders warm as it renders) and own nothing to dispose.
  const flight = _bodyFlightPromise(scene, url)
  const iOwnIt = !flight.claimed && (flight.claimed = true)
  const result = await flight.promise
  if (!iOwnIt) return // a live CharacterModel claimed this import — it owns the copy
  // never let the throwaway copy render even a single frame behind the load
  // overlay (it imports at origin, enabled by default).
  result.meshes.forEach((m) => { m.setEnabled(false); m.isPickable = false })
  _warmMaterials(result.meshes)
  // let the skinned pipeline compile against a real bone texture upload
  if (result.skeletons && result.skeletons[0]) {
    try { result.skeletons[0].prepare() } catch (e) { /* non-fatal */ }
  }
  result.animationGroups.forEach((g) => g.stop())
  // dispose(false, true): the throwaway copy must free its materials + textures too,
  // else every warmed body/rig leaks them (mesh.dispose() alone keeps them alive).
  // The compiled shader program stays in the engine's effect cache, so the warm holds.
  result.meshes.forEach((m) => m.dispose(false, true))
  result.animationGroups.forEach((g) => g.dispose())
  ;(result.skeletons || []).forEach((s) => s.dispose())
}

// Bones owned by the locomotion clip. A momentary overlay (shoot/hit) is masked
// to EXCLUDE these, so it never freezes the legs — the stride keeps playing under
// it and the body no longer slides while shooting on the move. (Babylon 4.0.3 has
// no additive-animation API, so we mask by bone instead.)
const LOWER_BODY_BONES = new Set([
  'root', 'pelvis',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'ball_leaf_l',
  'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'ball_leaf_r',
])

export default class CharacterModel {
  constructor(scene, host, spec) {
    this.scene = scene
    this.host = host
    this.spec = spec
    this.ready = false
    this.disposed = false
    this.holder = null
    this.groups = {}
    this.current = null
    this._oneShot = null      // active overlay group (shoot/hit)
    this._oneShotToken = 0    // guards stale end-observable callbacks (stop() fires them)
    this._usingDeathClip = false // death clip owns the corpse pose (blocks the procedural tip)
    this._deathClipRunning = false // death clip has been seen evaluating past its first frame
    this._deathClipSince = 0  // when the death clip was (re)started, for the watchdog below
    this._deathClipFrames = 0 // frames rendered since then (the watchdog needs both)
    this._weaponIndex = null  // currently mounted tp weapon
    this._weaponRoot = null   // cloned prop root parented to the hand bone
    this._helmetRoot = null   // cloned helmet prop parented to the head bone
    this._armorRoots = null   // cloned armor props parented to torso/limb bones (draft)
    // floating overhead nametag: a plain DOM div in #nametags, positioned each
    // frame by projecting the body's head-level world point to screen space.
    this._nameTag = null
    const container = document.getElementById('nametags')
    if (container) {
      this._nameTag = document.createElement('div')
      this._nameTag.className = 'nametag'
      container.appendChild(this._nameTag)
    }
    this._weaponReqId = 0     // serialize async weapon swaps
    this._lastX = host.position.x
    this._lastZ = host.position.z
    this._load()
  }

  // Swap the whole Cloth to another finish. Called from the entity's armorFinish watch,
  // so it fires on create AND whenever the wearer equips a different set — including on
  // other players' bodies, which is the point of putting the finish on the wire.
  //
  // Disposes and re-mounts rather than re-skinning: each finish is a separate GLB with its
  // own baked albedo, not a tint of one shared material.
  setArmorFinish(finishIndex) {
    const next = finishIndex | 0
    if (this._finish === next) return
    this._finish = next
    if (!this.ready) return           // _load will pick it up when the body lands
    if (this._armorRoots) {
      this._armorRoots.forEach((r) => { try { r.dispose() } catch (e) {} })
      this._armorRoots = null
    }
    if (this._helmetRoot) { try { this._helmetRoot.dispose() } catch (e) {} this._helmetRoot = null }
    this._mountArmor()
    this._mountHelmet()
  }

  // set (or update) the overhead nametag text. Called from the player factory on
  // create + on the replicated nameIndex watch.
  setName(name) {
    this._playerName = name
    if (this._nameTag) this._nameTag.textContent = name
  }

  // TDM: uniform this body + color the nametag by team (0 red / 1 blue). Called from
  // the player factory's teamId watch (fires on create + on change). The nametag is a
  // DOM node (color it now); the uniform needs the GLB materials, so if the model has
  // not finished loading yet we stash the team and _load applies it once meshes exist.
  // NOTE: the server assigns teamId 0/1 in EVERY mode (balance bookkeeping), so the
  // factory watch fires in FFA too — it routes FFA to setNeutral() below instead.
  setTeam(teamId) {
    this._neutral = false
    this._teamId = teamId
    if (this._nameTag && TEAM_NAMETAG_CSS[teamId]) this._nameTag.style.color = TEAM_NAMETAG_CSS[teamId]
    this._applyTeamUniform()
  }

  // FFA: no teams, so no red/blue — EVERYONE wears the same matching black uniform
  // (charcoal repaint of the red atlas, skin islands untouched; see manifest
  // neutralSkin) with a neutral gray nametag. Same stash-until-loaded contract as
  // setTeam.
  setNeutral() {
    this._neutral = true
    this._teamId = null
    if (this._nameTag) this._nameTag.style.color = NEUTRAL_NAMETAG_CSS
    this._applyTeamUniform()
  }

  // Swap the body material's albedo to the team uniform texture + lay a SUBTLE team
  // emissive over the body materials (distance/darkness read — see TEAM_BODY_GLOW).
  // Idempotent (safe to call again on a team change or after load). No-op until the
  // model's meshes are in. The uniform goes only on the suit material (name carries
  // 'Superhero'); hair/eyes keep their own textures but share the faint glow so the
  // silhouette reads as one team-colored unit.
  _applyTeamUniform() {
    // The armour is a separate prop tree with its own materials and its own async mount,
    // so it repaints on its own path and does NOT wait on this.meshes.
    this._applyArmorTeam()
    if ((this._teamId == null && !this._neutral) || !this.meshes) return
    const skins = this.spec.teamSkins
    const skinUrl = this._neutral ? this.spec.neutralSkin : (skins && skins[this._teamId])
    // team NORMAL map lives beside the albedo: hero_male_uniform_red.webp ->
    // hero_male_uniform_red_n.webp (DeepBump relief baked from the finished atlas,
    // composited over the GLB's own face normal). Derived here so the manifest
    // needs no new field. The hero material is PBR (albedoTexture above), so the
    // normal map goes on `bumpTexture` (same property name on PBRMaterial and
    // StandardMaterial); we keep the material's existing invertNormalMap* settings
    // so the +Y/OpenGL convention matches the GLB normal we composited into.
    const normUrl = skinUrl && skinUrl.replace(/\.webp$/, '_n.webp')
    const glow = this._neutral ? NEUTRAL_BODY_GLOW : TEAM_BODY_GLOW[this._teamId]
    const suitEmis = this._neutral ? NEUTRAL_SUIT_EMISSIVE : TEAM_SUIT_EMISSIVE[this._teamId]
    this.meshes.forEach((m) => {
      const mat = m.material
      if (!mat) return
      if (skinUrl && mat.albedoTexture !== undefined && /superhero/i.test(mat.name || '')) {
        const tex = _teamTexture(this.scene, skinUrl)
        mat.albedoTexture = tex
        if (normUrl && 'bumpTexture' in mat) mat.bumpTexture = _teamTexture(this.scene, normUrl)
        // self-lit: emissive samples the SAME team albedo, dimmed by suitEmis, so
        // the suit detail survives darkness. (Superhero material only — hair/eyes
        // keep just the faint flat TEAM_BODY_GLOW wash below.)
        if ('emissiveTexture' in mat) {
          mat.emissiveTexture = tex
          if (mat.emissiveColor && suitEmis) mat.emissiveColor.copyFrom(suitEmis)
        }
      } else if (glow && mat.emissiveColor) {
        mat.emissiveColor.copyFrom(glow)
      }
    })
  }

  async _load() {
    // Single-flight claim: if the preload warm's import for this url is still
    // in-flight and unclaimed, we take ownership of that copy (no second 20MB
    // fetch). Otherwise we import our own — hitting the browser cache the first
    // import primed, so it's parse-only, never a duplicate network download.
    const result = await _claimBodyImport(this.scene, this.spec.url)
    if (this.disposed) {
      result.meshes.forEach((m) => m.dispose())
      result.animationGroups.forEach((g) => g.dispose())
      return
    }

    // parent the imported model under our own node so the glTF loader's __root__
    // handedness fix doesn't interfere with the yaw/position we set each frame.
    this.holder = new BABYLON.TransformNode('charHolder', this.scene)
    this.holder.scaling.setAll(this.spec.scale)
    result.meshes[0].parent = this.holder
    this.meshes = result.meshes
    this.skeleton = result.skeletons && result.skeletons[0]

    // tag body meshes so a shot that lands on a player reads as a flesh/blood impact
    // (and drives the local player's predicted hit marker). See firingFx.classifySurface.
    result.meshes.forEach((m) => {
      m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
    })

    // TDM: apply the team uniform now that the materials exist (setTeam may have
    // fired before the async load resolved, in which case it only stashed the team).
    this._applyTeamUniform()

    result.animationGroups.forEach((g) => { g.stop(); this.groups[g.name] = g })
    this.idle = this.groups[this.spec.anims.idle]
    this.run = this.groups[this.spec.anims.run]
    // directional locomotion (UAL1 has fwd/bwd/left/right jogs) so a strafing body
    // steps sideways instead of moon-walking a forward jog. All optional -> fall
    // back to `run` then `idle`.
    this.runBack = this.groups[this.spec.anims.runBack]
    this.runLeft = this.groups[this.spec.anims.runLeft]
    this.runRight = this.groups[this.spec.anims.runRight]
    this.shootClip = this.groups[this.spec.anims.shoot]
    this.hitClip = this.groups[this.spec.anims.hit]
    this.deathClip = this.groups[this.spec.anims.death]
    // upper-body-only overlays: the full shoot/hit clips animate the legs too, so
    // playing them over locomotion freezes the stride and the body slides. Mask to
    // spine-and-up so the locomotion clip keeps owning the legs.
    this.shootUpper = this._maskUpperBody(this.shootClip, 'shootUpper')
    this.hitUpper = this._maskUpperBody(this.hitClip, 'hitUpper')
    if (this.idle) { this.idle.start(true, 1.0); this.current = this.idle }
    this.ready = true

    // if a corpse/weapon was requested before we finished loading, apply now
    if (this._pendingWeaponIndex != null) {
      const idx = this._pendingWeaponIndex
      this._pendingWeaponIndex = null
      this.setWeapon(idx)
    } else {
      // no watch fired before load finished -> default weapon (index 0)
      this.setWeapon(0)
    }
    this._mountHelmet()
    this._mountArmor()
    // A death that landed while we were still importing could only set the flag
    // (setCorpse bails out when !ready). Re-enter corpse mode PROPERLY now, so the body
    // also gets the tint snapshot + darken pass — and so the idle loop started just
    // above is stopped instead of being left fighting the death clip over the rig.
    if (this._corpse) { this._corpse = false; this.setCorpse(true) }
  }

  // find the Babylon TransformNode linked to a glTF joint by name. Babylon's glTF
  // loader creates a TransformNode per bone (bone.getTransformNode()); we attach
  // the weapon prop to that node so it rides the animated hand.
  _handNode() {
    if (this._cachedHandNode) return this._cachedHandNode
    const name = this.spec.handBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    // Babylon 4.0.3 has no public getTransformNode(); the glTF loader links each
    // bone to a scene TransformNode via _linkedTransformNode. Prefer the public
    // accessor when it exists (future upgrades), fall back to the private field.
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHandNode = node
    return node
  }

  // find the TransformNode linked to the head glTF joint (mirrors _handNode) so
  // the helmet prop can parent to it and ride the head animation.
  _headNode() {
    if (this._cachedHeadNode) return this._cachedHeadNode
    const name = this.spec.headBone
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    const node = (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
    this._cachedHeadNode = node
    return node
  }

  // ---- HELMET -------------------------------------------------------------
  // Mount the rigid helmet prop on the head bone. Parented (not per-frame), so it
  // rides head animation and persists through corpse/death mode untouched.
  async _mountHelmet() {
    if (!this.spec.helmet) return
    const head = this._headNode()
    if (!head) return // no bone -> no helmet (skeleton missing)

    const { root } = await _loadProp(this.scene, armorUrlFor(this.spec.helmet.url, this._finish | 0))
    if (this.disposed) return

    // drop any previous helmet
    if (this._helmetRoot) { this._helmetRoot.dispose(); this._helmetRoot = null }

    // clone the template (deep, with descendants) and mount under the head node
    const clone = root.clone('helmet', head)
    clone.setEnabled(true)
    clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
    const spec = this.spec.helmet
    clone.scaling.setAll(spec.scale)
    clone.position.set(spec.position.x, spec.position.y, spec.position.z)
    clone.rotationQuaternion = null
    clone.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    // tag as flesh so a headshot on the helmet reads like a body hit (matches _load)
    ;[clone, ...clone.getChildMeshes()].forEach((m) => {
      m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
    })
    // paint the tactical skin (fixes the grey helmet). Idempotent on the shared template
    // materials, so every player's helmet gets it for one skinning cost.
    _skinHelmet(this.scene, [clone, ...clone.getChildMeshes()])
    this._helmetRoot = clone
  }

  // resolve any skeleton bone's TransformNode by name (generalized _headNode).
  _boneNode(name) {
    if (!name || !this.skeleton) return null
    const bone = this.skeleton.bones.find((b) => b.name === name)
    if (!bone) return null
    return (bone.getTransformNode && bone.getTransformNode()) || bone._linkedTransformNode || null
  }

  // ---- ARMOR --------------------------------------------------------------
  // Mount the Saint Seiya-style armor pieces, each parented to its skeleton bone's
  // TransformNode (same recipe as _mountHelmet), so they ride the animation. Data-driven
  // from assets.playerBody.armor; a missing bone or failed load skips that ONE piece and
  // never breaks the body. `mirror` flips X for the right-side limb (the piece is authored
  // for the left). Tagged fragSurface:flesh so a shot on the armor books like a body hit,
  // matching the helmet + body.
  async _mountArmor() {
    // The per-bone transforms were re-derived from measured anatomy and tuned in-engine
    // on 2026-07-24 (scripts/fit-armor.mjs drives the playground's tuneArmor hook), so
    // assets.playerBody.armorEnabled is now ON. The escape hatch stays: ?armor=1 forces
    // it on, ?armor=0 forces it off, so the fit can still be judged side-by-side in the
    // real renderer.
    if (!_armorWanted(this.spec)) return
    const specs = this.spec.armor
    if (!Array.isArray(specs) || !specs.length) return
    this._armorRoots = this._armorRoots || []
    for (const s of specs) {
      const bone = this._boneNode(s.bone)
      if (!bone) continue
      let root
      // the finish decides WHICH variant of this row's mesh to load
      const url = armorUrlFor(s.url, this._finish | 0)
      try { ({ root } = await _loadProp(this.scene, url)) } catch (e) {
        // a missing variant must never cost the player their armour — fall back to gold
        try { ({ root } = await _loadProp(this.scene, s.url)) } catch (e2) { continue }
      }
      if (this.disposed) return
      const clone = root.clone('armor_' + s.name, bone)
      if (!clone) continue
      clone.setEnabled(true)
      clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
      const sx = s.scale * (s.mirror ? -1 : 1)
      clone.scaling.set(sx, s.scale, s.scale)
      clone.position.set(s.position.x, s.position.y, s.position.z)
      clone.rotationQuaternion = null
      clone.rotation.set(s.rotation.x, s.rotation.y, s.rotation.z)
      ;[clone, ...clone.getChildMeshes()].forEach((m) => {
        m.metadata = Object.assign({}, m.metadata, { fragSurface: 'flesh' })
      })
      // The gold plates ship with glTF's DEFAULT metallicFactor of 1.0 (the exporter
      // wrote only baseColorFactor + roughnessFactor). Fully metallic with no scene
      // environment = the same dark-grey blob the helmet and guns were. Unlike the
      // textured props, the fix here is to GIVE them something to reflect rather than to
      // de-metalize them — see _makeArmorMetal. The gem is routed back to the old path by
      // the already-glows guard inside it.
      ;[root, ...root.getChildMeshes()].forEach((m) => _makeArmorMetal(m.material, this.scene))
      // Remember each plate's GOLD material before any team re-tint, so _applyArmorTeam
      // can swap both ways (a player CAN change team mid-match) without re-reading the
      // prop template.
      ;[clone, ...clone.getChildMeshes()].forEach((m) => { m._armorGoldMat = m.material })
      this._armorRoots.push(clone)
    }
    // The team almost always lands long before this async mount finishes, so paint now.
    this._applyArmorTeam()
  }

  // Point the mounted plates at the gold or the silver material for the current team.
  // Idempotent, and a no-op before the mount resolves (_mountArmor calls it at the end),
  // so it can be driven straight off the team path as well.
  _applyArmorTeam() {
    if (!this._armorRoots) return
    const silver = !this._neutral && this._teamId === ARMOR_SILVER_TEAM
    this._armorRoots.forEach((root) => {
      ;[root, ...root.getChildMeshes()].forEach((m) => {
        const gold = m._armorGoldMat
        if (gold) m.material = silver ? _armorSilverMaterial(gold) : gold
      })
    })
  }

  // ---- HELD WEAPON --------------------------------------------------------
  // Mount the tp weapon prop for `index` on the hand bone, swapping any current
  // one. Async (props load once, then clone) but serialized so rapid swaps settle
  // on the latest. Idempotent when index is unchanged.
  async setWeapon(index) {
    if (index == null || index < 0) return
    if (!this.ready) { this._pendingWeaponIndex = index; return }
    if (index === this._weaponIndex) return
    const spec = tpWeapons[index]
    if (!spec) return
    this._weaponIndex = index

    const reqId = ++this._weaponReqId
    const hand = this._handNode()
    if (!hand) return // no bone -> no held weapon (skeleton missing)

    const { root } = await _loadProp(this.scene, spec.url)
    if (this.disposed || reqId !== this._weaponReqId) return

    // drop the previous prop
    if (this._weaponRoot) { this._weaponRoot.dispose(); this._weaponRoot = null }

    // clone the template (deep, with descendants) and mount under the hand node
    const clone = root.clone('tpWeapon_' + index, hand)
    clone.setEnabled(true)
    clone.getChildMeshes().forEach((m) => { m.setEnabled(true); m.isPickable = false })
    clone.scaling.setAll(spec.scale)
    clone.position.set(spec.position.x, spec.position.y, spec.position.z)
    clone.rotationQuaternion = null
    clone.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
    // The sci-fi gun GLBs ship metallic=1 / roughness=1 with an ORM map. With no IBL in
    // this scene that renders as a featureless dark blob — "the guns have no skins".
    // Applied to the TEMPLATE's shared materials, so it is one pass per weapon type.
    ;[root, ...root.getChildMeshes()].forEach((m) => _fixUnlitMetal(m.material))
    this._weaponRoot = clone
  }

  update(delta) {
    if (!this.ready || !this.holder || this.disposed) return
    const p = this.host.position

    // Babylon 4.0.3 stops re-syncing bones from their linked glTF transform nodes
    // once a skeleton is large enough to store its matrices in a texture (~>30
    // bones, as the 65-bone UBC rig does). The AnimationGroups animate the nodes,
    // but the skinned mesh stays frozen at bind pose unless we re-prepare the
    // skeleton each frame. (The 23-bone soldier rig used the uniform path and
    // never needed this.) Cheap for a handful of players.
    if (this.skeleton) this.skeleton.prepare()

    // (held-weapon sync happens via the currentWeaponIndex factory watch —
    // this.host is the entity MESH and carries no replicated fields)

    // CORPSE MODE (driven by FragLayer off the Killed message, NOT the replicated
    // isAlive flag): while a death animation is playing the FragLayer owns this
    // model's enabled state, so we stop driving pose here. The death CLIP itself
    // (played in setCorpse) drives the fall; position still follows the host.
    if (this._corpse) {
      // WATCHDOG: the death clip is the ONLY thing animating the rig in corpse mode, so
      // confirm it is really evaluating. If it never advances past its first frame we
      // release it and let FragLayer's procedural tip take the body over, rather than
      // leaving a bind-pose statue standing for the full corpse window.
      if (this._usingDeathClip && !this._deathClipRunning) {
        const anim = this.deathClip.animatables[0]
        if (anim && anim.masterFrame > this.deathClip.from) this._deathClipRunning = true
        else if (++this._deathClipFrames > DEATH_CLIP_WATCHDOG_FRAMES &&
          performance.now() - this._deathClipSince > DEATH_CLIP_WATCHDOG_MS) this._abandonDeathClip()
      }
      this.holder.setEnabled(!this._hidden)
      this.holder.position.set(p.x, p.y + bodyYOffset(this.spec), p.z)
      if (this._nameTag) this._nameTag.style.display = 'none'
      return
    }

    // Normal death: hide instantly when isAlive is false AND no corpse animation
    // is running (e.g. a death we never saw a Killed message for). A live corpse
    // animation takes priority via the early return above.
    this.holder.setEnabled(this.host.isAlive !== false)
    this.holder.position.set(p.x, p.y + bodyYOffset(this.spec), p.z)
    this.holder.rotation.y = this.host.rotation.y + (this.spec.yawOffset || 0)

    // HIT-STOP: while active, near-freeze the animation to sell the impact. The body
    // still tracks host position/yaw (set above); we only stall clip playback and
    // skip locomotion re-selection so clips don't restart mid-freeze. On expiry we
    // restore normal speed and fall through. Overlays (shoot/hit) are frozen too but
    // their end-observable token guards are untouched.
    if (this._hitStopUntil) {
      const now = performance.now()
      if (now < this._hitStopUntil) {
        if (this.current) this.current.speedRatio = HIT_STOP_SPEED
        if (this._oneShot) this._oneShot.speedRatio = HIT_STOP_SPEED
        return
      }
      if (this.current) this.current.speedRatio = 1.0
      if (this._oneShot) this._oneShot.speedRatio = 1.0
      this._hitStopUntil = 0
    }

    const dx = p.x - this._lastX
    const dz = p.z - this._lastZ
    this._lastX = p.x
    this._lastZ = p.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(delta, 1 / 240)

    // A shoot/hit one-shot is playing on top of locomotion. We keep the base
    // locomotion clip running underneath (so the legs still stride); the overlay
    // group blends on the shared skeleton. Locomotion selection continues below
    // so that when the one-shot ends we're already on the right base clip.
    //
    // DIRECTIONAL LOCOMOTION: bots (and strafing players) face one way while
    // moving another, so pick fwd/back/left/right jog from the movement vector
    // resolved into the body's local frame (matches applyCommand: forward=+Z,
    // right=+X, rotated by rotation.y). EMA-smooth the delta so near-diagonal
    // motion doesn't flicker between clips frame to frame.
    this._smDx = (this._smDx || 0) * 0.7 + dx * 0.3
    this._smDz = (this._smDz || 0) * 0.7 + dz * 0.3
    // Decide off the SMOOTHED delta, not the raw one — see LOCOMOTION STABILITY above.
    // (`speed` stays the raw estimate; nothing else reads it.)
    const smSpeed = Math.hypot(this._smDx, this._smDz) / Math.max(delta, 1 / 240)

    // 1) HYSTERESIS on moving/idle: between the two thresholds we keep doing whatever
    //    we were already doing, so jitter around the boundary can't flip the clip.
    this._moving = this._moving ? smSpeed > RUN_EXIT_SPEED : smSpeed > RUN_ENTER_SPEED

    let target = this.idle
    if (this._moving) {
      const yaw = this.host.rotation.y
      const s = Math.sin(yaw)
      const c = Math.cos(yaw)
      const fwd = this._smDx * s + this._smDz * c   // + = forward
      const rgt = this._smDx * c - this._smDz * s   // + = right
      // 2) DOMINANCE MARGIN: hand the body to the other axis only when it clearly wins.
      //    A bare >= comparison flip-flops on every near-diagonal run.
      const af = Math.abs(fwd), ar = Math.abs(rgt)
      let axis = this._locoAxis || (af >= ar ? 'fb' : 'lr')
      if (axis === 'fb') { if (ar > af * DIR_MARGIN) axis = 'lr' }
      else if (af > ar * DIR_MARGIN) axis = 'fb'
      this._locoAxis = axis
      target = axis === 'fb'
        ? (fwd >= 0 ? this.run : this.runBack) || this.run
        : (rgt >= 0 ? this.runRight : this.runLeft) || this.run
      target = target || this.idle
    } else {
      this._locoAxis = null
    }

    if (target && target !== this.current) {
      // 3) DWELL: whatever still slips through the guards above cannot machine-gun the
      //    clip. One locomotion change per LOCO_DWELL_MS, at most.
      const tNow = performance.now()
      if (!this._locoAt || tNow - this._locoAt >= LOCO_DWELL_MS) {
        // PHASE CARRY-OVER: group.start() rewinds to frame 0, so even a CORRECT swap
        // (jog -> strafe) popped mid-stride. Re-enter the new clip at the same
        // normalized position and the legs keep their cadence through the change.
        const prev = this.current
        let phase = 0
        if (prev && prev.to > prev.from) {
          const at = prev.animatables && prev.animatables[0]
          if (at && typeof at.masterFrame === 'number') {
            const t = (at.masterFrame - prev.from) / (prev.to - prev.from)
            if (t >= 0 && t <= 1) phase = t
          }
        }
        if (prev) prev.stop()
        target.start(true, 1.0)
        if (phase > 0 && target.to > target.from) {
          try { target.goToFrame(target.from + phase * (target.to - target.from)) } catch (e) { /* non-fatal */ }
        }
        this.current = target
        this._locoAt = tNow
      }
    }

    // floating nametag: project head-level world position to screen
    if (this._nameTag) {
      const show = !this._corpse && this.host.isAlive !== false && this.holder
      if (show) {
        const engine = this.scene.getEngine()
        const camera = this.scene.getCameraByName('camera')
        if (camera) {
          const headY = this.holder.position.y + 1.4
          const wp = new BABYLON.Vector3(this.holder.position.x, headY, this.holder.position.z)
          const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
          const sp = BABYLON.Vector3.Project(wp, BABYLON.Matrix.Identity(), this.scene.getTransformMatrix(), vp)
          if (sp.z > 0 && sp.z < 1) {
            this._nameTag.style.display = 'block'
            this._nameTag.style.left = sp.x + 'px'
            this._nameTag.style.top = sp.y + 'px'
          } else {
            this._nameTag.style.display = 'none'
          }
        }
      } else {
        this._nameTag.style.display = 'none'
      }
    }
  }

  // Build a copy of `src` that drives only upper-body bones (spine-and-up + arms),
  // so it overlays locomotion without touching the legs. Shares the source's
  // Animation objects (src stays stopped). Returns null if src is missing/empty.
  _maskUpperBody(src, name) {
    if (!src) return null
    const g = new BABYLON.AnimationGroup(name, this.scene)
    src.targetedAnimations.forEach((ta) => {
      const tn = ta.target && ta.target.name
      if (tn && !LOWER_BODY_BONES.has(tn)) g.addTargetedAnimation(ta.animation, ta.target)
    })
    if (g.targetedAnimations.length === 0) { g.dispose(); return null }
    g.normalize(src.from, src.to)
    return g
  }

  // ---- ONE-SHOT OVERLAYS (shoot / hit) ------------------------------------
  // Play a non-looping clip once, then return to locomotion. Guarded so stop()'s
  // end observable (fired synchronously by Babylon) can't recurse or fire stale.
  _playOneShot(group, weight) {
    if (!group || this.disposed || this._corpse) return
    // bump token so any pending end-handler from a prior one-shot is neutralized
    const token = ++this._oneShotToken
    if (this._oneShot && this._oneShot !== group) {
      // stop the previous overlay WITHOUT letting its (now-stale) end handler run
      this._oneShot.onAnimationGroupEndObservable.clear()
      this._oneShot.stop()
    }
    this._oneShot = group
    group.onAnimationGroupEndObservable.clear()
    group.onAnimationGroupEndObservable.addOnce(() => {
      // ignore if superseded (a newer one-shot started) or we've been disposed
      if (token !== this._oneShotToken || this.disposed) return
      this._oneShot = null
    })
    group.stop()          // reset to frame 0 (fires end obs, but we just cleared it)
    group.start(false, 1.0) // one-shot, non-looping
  }

  // Remote-player shoot feedback (called from Simulator's WeaponFired handler).
  // Rapid fire (SMG) retriggers cleanly by restarting from frame 0.
  playShoot() {
    if (!this.ready || this._corpse) return
    this._playOneShot(this.shootUpper || this.shootClip)
  }

  // Begin (or extend) a hit-stop freeze of `ms`, applied in update(). Clamped so a
  // stream of hits reads as one brief freeze, not a long stall. `kill` raises the cap
  // to KILL_STOP_MAX_MS for a Doom-style kill emphasis on THIS victim's body only —
  // never a global timescale change (this is a live multiplayer client). No-op while a
  // corpse — the death clip owns the rig (kills call this just BEFORE _dropCorpse).
  hitStop(ms, kill) {
    if (this._corpse || this.disposed) return
    const now = performance.now()
    const cap = kill ? KILL_STOP_MAX_MS : HIT_STOP_MAX_MS
    this._hitStopUntil = Math.min(Math.max(this._hitStopUntil || 0, now + ms), now + cap)
  }

  // Brief hit react. Lowest one-shot priority — never override an active shoot.
  playHit() {
    if (!this.ready || this._corpse) return
    if (this._oneShot === (this.shootUpper || this.shootClip)) return // don't stomp a shoot
    this._playOneShot(this.hitUpper || this.hitClip)
  }

  // ---- CORPSE MODE (owned by FragLayer) -----------------------------------
  // Enter/leave corpse mode. On enter we play the DEATH CLIP once and freeze on
  // its last frame (falling back to a procedural tip only if the clip is missing),
  // remembering each material's base tint so darken + restore is exact. On leave
  // we restore pose, tint, opacity + resume idle — the model is reused by the SAME
  // player when they respawn, so leaving MUST be a clean reset.
  setCorpse(on) {
    if (!this.ready || !this.holder) { this._corpse = on; return }
    if (on) {
      if (this._corpse) return // already a corpse; don't re-snapshot
      this._corpse = true
      this._hidden = false
      // stop locomotion + any one-shot so the death clip owns the skeleton
      this._oneShotToken++
      if (this._oneShot) { this._oneShot.onAnimationGroupEndObservable.clear(); this._oneShot.stop(); this._oneShot = null }
      if (this.current) { this.current.stop(); this.current = null }
      // snapshot base tints so we can darken then restore precisely
      if (!this._baseTints) {
        this._baseTints = []
        this.meshes.forEach((m) => {
          const mat = m.material
          if (mat && mat.diffuseColor) {
            this._baseTints.push({
              mat,
              diff: mat.diffuseColor.clone(),
              emis: mat.emissiveColor ? mat.emissiveColor.clone() : null,
            })
          }
        })
      }
      // darken the corpse
      this._baseTints.forEach((t) => {
        t.mat.diffuseColor.copyFrom(t.diff).scaleInPlace(0.4)
        if (t.emis && t.mat.emissiveColor) t.mat.emissiveColor.copyFrom(t.emis).scaleInPlace(0.4)
      })
      this._applyDeathClip()
    } else {
      this._corpse = false
      this._hidden = false
      this._usingDeathClip = false
      // stop the death clip if it was playing
      if (this.deathClip) { this.deathClip.onAnimationGroupEndObservable.clear(); this.deathClip.stop() }
      // restore tint
      if (this._baseTints) {
        this._baseTints.forEach((t) => {
          t.mat.diffuseColor.copyFrom(t.diff)
          if (t.emis && t.mat.emissiveColor) t.mat.emissiveColor.copyFrom(t.emis)
        })
      }
      // restore pose/opacity + resume idle so the reused model is pristine
      this.holder.rotationQuaternion = null
      this.holder.rotation.set(0, 0, 0)
      this.meshes.forEach((m) => { m.visibility = 1 })
      this.holder.setEnabled(this.host.isAlive !== false)
      // play() not start(): start() is a silent no-op while the group still reads as
      // started (see _applyDeathClip), which would hand the respawned body back with a
      // frozen rig. play() re-runs stop+start and always leaves the clip evaluating.
      if (this.idle) { this.idle.play(true); this.current = this.idle }
    }
  }

  // Play the death clip once and freeze on the last frame. FragLayer still owns
  // the corpse lifecycle (tint/persist/fade/reset); this just supplies the pose.
  // If the clip is missing we fall back to FragLayer's procedural tip (applyCorpsePose).
  //
  // Two Babylon 9 AnimationGroup quirks have to be survived here, because setCorpse has
  // already stopped locomotion — a death clip that fails to run leaves NOTHING driving
  // the skeleton, i.e. the body stands frozen in bind pose for the whole corpse window:
  //   1. start() returns immediately while the group still reads _isStarted. A stop()
  //      that finds no animatables to end never clears that flag, so the group can sit
  //      "started" with ZERO animatables and every later start() is a silent no-op.
  //      play() runs stop+start (or restarts a live group), which always clears it.
  //   2. stop() fires onAnimationGroupEndObservable SYNCHRONOUSLY, so an end-handler
  //      registered before the restart is eaten by our own restart. Register it after.
  _applyDeathClip() {
    if (!this.deathClip) { this._abandonDeathClip(); return }
    this._usingDeathClip = true
    this._deathClipRunning = false
    this._deathClipFrames = 0
    this._deathClipSince = performance.now()
    const clip = this.deathClip
    clip.onAnimationGroupEndObservable.clear()
    // played faster than 1x so the ~2.375s fall completes well inside the 2.5s
    // respawn window (see DEATH_CLIP_SPEED) instead of getting truncated by jitter.
    clip.speedRatio = DEATH_CLIP_SPEED
    clip.play(false)
    clip.onAnimationGroupEndObservable.addOnce(() => {
      // freeze on the last frame (goToFrame the end) — only if still a corpse. Babylon
      // has usually already stopped the group by the time it raises this, in which case
      // both calls no-op and the rig simply holds the last frame it evaluated.
      if (!this._corpse || this.disposed) return
      clip.pause()
      clip.goToFrame(clip.to)
    })
    if (!clip.isPlaying || clip.animatables.length === 0) this._abandonDeathClip()
  }

  // The death clip could not be made to run. Hand the pose back to FragLayer's
  // procedural tip (applyCorpsePose) and put a locomotion clip back on the rig, so the
  // body tips over as a corpse instead of standing frozen in bind pose.
  _abandonDeathClip() {
    this._usingDeathClip = false
    this._deathClipRunning = false
    if (this.deathClip) { this.deathClip.onAnimationGroupEndObservable.clear(); this.deathClip.stop() }
    if (this.idle) { this.idle.play(true); this.current = this.idle }
  }

  // hide the visible body outright (gib case: chunks replace the body)
  setHidden(on) {
    this._hidden = !!on
    if (this.holder) this.holder.setEnabled(!this._hidden)
  }

  // tip the body over up to 90deg around a horizontal axis, falling AWAY from the
  // killer (killerYaw = world yaw from victim toward killer). tip is 0..1.
  // FALLBACK ONLY: skipped when the death clip is driving the pose.
  applyCorpsePose(killerYaw, tip) {
    if (!this.holder || this._usingDeathClip) return
    const angle = tip * (Math.PI / 2) // up to 90deg
    // tip axis is horizontal, perpendicular to the killer direction, so the body
    // rotates to fall directly away from the shooter.
    const axis = new BABYLON.Vector3(Math.cos(killerYaw), 0, -Math.sin(killerYaw))
    this.holder.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis, angle)
  }

  // final corpse life: sink into the floor + fade the meshes. k is 0..1.
  setCorpseFade(k) {
    if (!this.holder) return
    this.holder.position.y -= k * 0.02 // gentle sink each frame while k ramps
    const vis = Math.max(0, 1 - k)
    this.meshes.forEach((m) => { m.visibility = vis })
  }

  dispose() {
    this.disposed = true
    if (this._nameTag) { this._nameTag.remove(); this._nameTag = null }
    this._oneShotToken++
    // masked overlays share Animation objects with the source groups; dispose the
    // wrappers first (just releases their animatables), then the source groups.
    if (this.shootUpper) { this.shootUpper.onAnimationGroupEndObservable.clear(); this.shootUpper.dispose() }
    if (this.hitUpper) { this.hitUpper.onAnimationGroupEndObservable.clear(); this.hitUpper.dispose() }
    Object.values(this.groups).forEach((g) => {
      g.onAnimationGroupEndObservable.clear()
      g.dispose()
    })
    if (this._weaponRoot) this._weaponRoot.dispose()
    if (this._helmetRoot) this._helmetRoot.dispose()
    if (this._armorRoots) { this._armorRoots.forEach((r) => { try { r.dispose() } catch (e) {} }); this._armorRoots = null }
    if (this.meshes) this.meshes.forEach((m) => m.dispose())
    if (this.holder) this.holder.dispose()
  }
}
