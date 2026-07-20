// UT-STYLE PICKUP + LOADOUT config (v1). ONE tunable source of truth shared by the
// server (server/setupPickups.js + GameInstance.updatePickups) and the client
// (Simulator._updatePickups + the Pickup factory). Everything a designer wants to
// re-tune — what a UT map item becomes, how long it stays gone, how high it floats,
// which model renders it — lives HERE, as data, so nobody has to touch engine code.
//
// The MEGA-HEALTH pickup is DELIBERATELY LEFT as its own entity/code path for v1
// (common/entity/MegaHealthPickup.js + GameInstance.updateMegaHealth). It has a
// bespoke overheal/decay mechanic and a validated hand-placed position; folding it in
// here would add risk for no gain. This module is the roster of the OTHER item types.

// Pickup TYPE enum — networked as the Pickup entity's `type` UInt8 and the switch key
// the client factory + server grant both read.
export const PICKUP_TYPE = {
	WEAPON:  0,
	AMMO:    1,
	HEALTH:  2,
	ARMOR:   3, // v1-DEFERRED grant (no armor model / no armor stat) — placed + rendered
	POWERUP: 4, // v1-DEFERRED grant (no UDamage mechanic / no asset) — placed + rendered
}

// Weapon roster indices (mirror common/weaponsConfig.js): 0 Rifle, 1 SMG, 2 Shotgun,
// 3 Pistol (the spawn weapon), 4 Plasma, 5 Flak.
export const WEAPON = { RIFLE: 0, SMG: 1, SHOTGUN: 2, PISTOL: 3, PLASMA: 4, FLAK: 5 }

// ── TUNABLE: UT weapon-item → roster weapon(s) ──────────────────────────────────
// A number = fixed weapon index. An ARRAY = SPLIT: successive occurrences round-robin
// across the listed indices (so one UT item class can seed several roster weapons).
// null = OMIT (do not place).
//
// Visage ships 6 sniper_rifle spawns and has NO item that naturally maps to the SMG,
// so the sniper spawns are SPLIT across Rifle(0) and SMG(1). That makes all five
// pickup weapons (0,1,2,4,5 — every non-pistol) appear on the map. Pure design choice;
// re-point any of these to re-balance the map without touching code.
export const WEAPON_ITEM_MAP = {
	sniper_rifle:    [WEAPON.RIFLE, WEAPON.SMG], // SPLIT: alternates Rifle / SMG per spawn
	shock_rifle:     WEAPON.PLASMA,
	rocket_launcher: WEAPON.FLAK,
	ripper:          WEAPON.SHOTGUN,
	redeemer:        null,                       // OMIT — no roster analogue
}

// ── TUNABLE: UT ammo-item → the roster weapon whose RESERVE it tops up ───────────
// Ammo for a weapon the player does not own is ignored on grant (design rule). null =
// OMIT. `bullets` is the generic UT bullet box — mapped to the SMG here (the bullet
// hose most likely to run dry); re-point freely.
export const AMMO_ITEM_MAP = {
	rockets:    WEAPON.FLAK,
	shock_core: WEAPON.PLASMA,
	bullets:    WEAPON.SMG,
}

// ── TUNABLE: per-type respawn time (seconds from taken → available again) ────────
export const RESPAWN_SECONDS = {
	[PICKUP_TYPE.WEAPON]:  30,
	[PICKUP_TYPE.AMMO]:    30,
	[PICKUP_TYPE.HEALTH]:  30,
	[PICKUP_TYPE.ARMOR]:   30,
	[PICKUP_TYPE.POWERUP]: 60,
}

// ── TUNABLE: rest height above the probed floor (world units) ────────────────────
// Weapons float highest so they read as "grab me"; consumables sit lower.
export const REST_HEIGHT = {
	[PICKUP_TYPE.WEAPON]:  0.6,
	[PICKUP_TYPE.AMMO]:    0.3,
	[PICKUP_TYPE.HEALTH]:  0.3,
	[PICKUP_TYPE.ARMOR]:   0.3,
	[PICKUP_TYPE.POWERUP]: 0.9,
}

// Grant tuning (server-authoritative). HEALTH heals up to HEALTH_CAP (no overheal —
// that is the mega's job). AMMO tops the mapped weapon's reserve to its own max.
export const HEALTH_HEAL = 25
export const HEALTH_CAP = 100

// Proximity radius a living player must be within to grab a pickup (world units).
// Matches the mega's feel (MEGA.RADIUS 2.2). Server-authoritative; the client mirrors
// the same radius when predicting its own ammo/weapon refill off networked state.
export const PICKUP_RADIUS = 2.2

// CHARGING lead (seconds before respawn) the client uses to run the scale/fade-in
// "about to return" tell — mirrors the mega's CHARGE_LEAD.
export const CHARGE_LEAD_SECONDS = 5

// ── Client model URLs per type (see client/factories/createFactories.js) ─────────
// Weapon pickups pick a third-person weapon model by roster index; Plasma reuses the
// rifle silhouette and Flak the shotgun (no bespoke tp_ model for those two yet).
export const WEAPON_MODEL_URL = {
	[WEAPON.RIFLE]:   '/assets/weapons/tp_rifle.glb',
	[WEAPON.SMG]:     '/assets/weapons/tp_smg.glb',
	[WEAPON.SHOTGUN]: '/assets/weapons/tp_shotgun.glb',
	[WEAPON.PISTOL]:  '/assets/weapons/tp_pistol.glb',
	[WEAPON.PLASMA]:  '/assets/weapons/tp_rifle.glb',   // reuse rifle silhouette
	[WEAPON.FLAK]:    '/assets/weapons/tp_shotgun.glb', // reuse shotgun silhouette
}
export const PEDESTAL_MODEL_URL = '/assets/scifi/Platform_Metal.gltf'
export const HEALTH_MODEL_URL = '/assets/props/Prop_HealthPack.gltf'
export const AMMO_MODEL_URL = '/assets/props/Prop_Ammo.gltf'

// Resolve a raw registry PICKUPS entry (native units + `item`) for a given category to
// a spawn descriptor, or null to OMIT. `occurrence` is the running count of prior items
// of the SAME item key (drives the sniper Rifle/SMG split). Returns { type, weaponIndex }.
export function resolvePickup(category, entry, occurrence = 0) {
	if (category === 'weapon') {
		const m = WEAPON_ITEM_MAP[entry.item]
		if (m === null || m === undefined) return null
		const weaponIndex = Array.isArray(m) ? m[occurrence % m.length] : m
		return { type: PICKUP_TYPE.WEAPON, weaponIndex }
	}
	if (category === 'ammo') {
		const m = AMMO_ITEM_MAP[entry.item]
		if (m === null || m === undefined) return null
		return { type: PICKUP_TYPE.AMMO, weaponIndex: m }
	}
	if (category === 'health')  return { type: PICKUP_TYPE.HEALTH,  weaponIndex: 0 }
	if (category === 'armor')   return { type: PICKUP_TYPE.ARMOR,   weaponIndex: 0 }
	if (category === 'powerup') return { type: PICKUP_TYPE.POWERUP, weaponIndex: 0 }
	return null
}
