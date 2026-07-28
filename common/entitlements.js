// What owning a Degen Tournament NFT actually grants in-game.
//
// Keyed by the asset's ON-CHAIN NAME, which is the one field readable straight out of the
// raw Core account without deserialising the plugin tail (name sits at a fixed offset;
// the Attributes plugin does not). Names are stable — they are set at mint and only the
// update authority can change them. A name here that does not match a minted name grants
// nothing, silently, so this table and render/items.mjs must not drift.
//
// Pure data, no wall-clock, no randomness: safe in common/ where it runs on both sides.

// The LIVE collection, minted 2026-07-27 at degentournament.fun. The previous Season 1
// collection was burned in full; pointing at it would find nobody holding anything.
export const COLLECTION_MAINNET = '5u2raT68foyJiMJPGHMZxkoZWs81djASsn4cfkQhQsUv'
export const COLLECTION_DEVNET = 'CS9gJkpP9CUY834gYC19aWmtZSGAw2Rchj1aoMBG1NNC'
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'

// ── ARMOUR FINISHES ────────────────────────────────────────────────────────────
// A set is worn as ONE finish — no mixing. The rule is deliberate: these are Cloths, and
// a half-gold half-ebony Cloth reads as a bug rather than as a choice. `FINISHES` is the
// display order, weakest-looking first, and doubles as the equip screen's tab order.
export const FINISHES = ['Gold', 'Silver', 'Ebony', 'Solana']

// The five mount slots a full set covers. Used by the equip screen to show which pieces
// of a chosen finish the holder is missing.
export const ARMOR_SLOTS = ['Helm', 'Cuirass', 'Pauldron', 'Joint Cap', 'Sabaton']

// name -> entitlement. `weaponIndex` must match common/weaponsConfig.js.
//
// Every WEAPON grants its weapon — that is the whole Season 1 economy, since no non-pistol
// weapon spawns on the arena floor any more. Armour is cosmetic: it carries a `finish` and
// a `slot` instead of a grant, which is what lets the equip screen group a set and refuse
// a mixed one.
export const NFT_ENTITLEMENTS = {
  // ── weapons ──
  'Long Debt':       { kind: 'weapon', weaponIndex: 6, label: 'Sniper' },
  'Vector Rifle':    { kind: 'weapon', weaponIndex: 0, label: 'Rifle' },
  'Static Repeater': { kind: 'weapon', weaponIndex: 1, label: 'SMG' },
  'Breach Ward':     { kind: 'weapon', weaponIndex: 2, label: 'Shotgun' },

  // ── armour: Gold (the un-prefixed names are the original finish) ──
  'Degen Helm':      { kind: 'armor', finish: 'Gold', slot: 'Helm' },
  'Cloth Cuirass':   { kind: 'armor', finish: 'Gold', slot: 'Cuirass' },
  'Cloth Pauldron':  { kind: 'armor', finish: 'Gold', slot: 'Pauldron' },
  'Cloth Joint Cap': { kind: 'armor', finish: 'Gold', slot: 'Joint Cap' },
  'Cloth Sabaton':   { kind: 'armor', finish: 'Gold', slot: 'Sabaton' },

  // ── armour: Silver ──
  'Silver Degen Helm':      { kind: 'armor', finish: 'Silver', slot: 'Helm' },
  'Silver Cloth Cuirass':   { kind: 'armor', finish: 'Silver', slot: 'Cuirass' },
  'Silver Cloth Pauldron':  { kind: 'armor', finish: 'Silver', slot: 'Pauldron' },
  'Silver Cloth Joint Cap': { kind: 'armor', finish: 'Silver', slot: 'Joint Cap' },
  'Silver Cloth Sabaton':   { kind: 'armor', finish: 'Silver', slot: 'Sabaton' },

  // ── armour: Ebony ──
  'Ebony Degen Helm':      { kind: 'armor', finish: 'Ebony', slot: 'Helm' },
  'Ebony Cloth Cuirass':   { kind: 'armor', finish: 'Ebony', slot: 'Cuirass' },
  'Ebony Cloth Pauldron':  { kind: 'armor', finish: 'Ebony', slot: 'Pauldron' },
  'Ebony Cloth Joint Cap': { kind: 'armor', finish: 'Ebony', slot: 'Joint Cap' },
  'Ebony Cloth Sabaton':   { kind: 'armor', finish: 'Ebony', slot: 'Sabaton' },

  // ── armour: Solana Gradient ──
  'Solana Degen Helm':      { kind: 'armor', finish: 'Solana', slot: 'Helm' },
  'Solana Cloth Cuirass':   { kind: 'armor', finish: 'Solana', slot: 'Cuirass' },
  'Solana Cloth Pauldron':  { kind: 'armor', finish: 'Solana', slot: 'Pauldron' },
  'Solana Cloth Joint Cap': { kind: 'armor', finish: 'Solana', slot: 'Joint Cap' },
  'Solana Cloth Sabaton':   { kind: 'armor', finish: 'Solana', slot: 'Sabaton' },
}

/** Weapon indices a holder of `names` is entitled to carry. */
export function grantedWeapons(names) {
  const out = []
  for (const n of names) {
    const e = NFT_ENTITLEMENTS[n]
    if (e && e.kind === 'weapon' && !out.includes(e.weaponIndex)) out.push(e.weaponIndex)
  }
  return out
}

/**
 * Which armour finishes a holder can actually WEAR, and how complete each one is.
 * Returns [{ finish, slots:[...], complete:bool }] in FINISHES order.
 *
 * A finish is offered as soon as the holder has ANY piece of it — a lone Solana pauldron
 * is still worth showing off. `complete` is what the equip screen uses to mark a full set,
 * and duplicates collapse: holding three Ebony Sabatons is one Sabaton slot filled.
 */
export function ownedFinishes(names) {
  const bySlot = {}
  for (const n of names || []) {
    const e = NFT_ENTITLEMENTS[n]
    if (!e || e.kind !== 'armor') continue
    ;(bySlot[e.finish] = bySlot[e.finish] || new Set()).add(e.slot)
  }
  return FINISHES
    .filter((f) => bySlot[f])
    .map((f) => ({
      finish: f,
      slots: ARMOR_SLOTS.filter((s) => bySlot[f].has(s)),
      complete: ARMOR_SLOTS.every((s) => bySlot[f].has(s)),
    }))
}

/**
 * Resolve a requested finish against what the holder owns. Returns the finish to wear, or
 * null for the default kit.
 *
 * Server-side authority for the no-mixing rule: the client sends a preference, and a
 * client that asks for a finish it does not hold gets the default rather than its request.
 */
export function resolveFinish(names, requested) {
  const owned = ownedFinishes(names)
  const hit = owned.find((o) => o.finish === requested)
  return hit ? hit.finish : null
}
