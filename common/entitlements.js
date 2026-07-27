// What owning a Degen Tournament NFT actually grants in-game.
//
// Keyed by the asset's ON-CHAIN NAME, which is the one field readable straight out of the
// raw Core account without deserialising the plugin tail (name sits at a fixed offset;
// the Attributes plugin does not). Names are stable — they are set at mint and only the
// update authority can change them.
//
// Pure data, no wall-clock, no randomness: safe in common/ where it runs on both sides.
//
// SEASON 1 (2026-07-26): every WEAPON in this collection grants its weapon. That is the
// whole economy — since no non-pistol weapon spawns on the floor any more
// (common/pickupConfig.js), this table is the ONLY way to carry one across a respawn.
// An unlinked player fights with the pistol, or with whatever they loot off a corpse
// until they die. Retiring a grant here is what makes a weapon unobtainable, so treat
// this file as live economy config, not a lookup table.
//
// The armour pieces are already worn by everyone (they are cosmetic Cloth with no damage
// reduction), so they are listed with no grant — present so the link screen can show a
// holder their full collection, and so that giving armour a mechanical effect later is a
// one-line change here rather than a new system.

// The LIVE Season 1 collection, minted on MAINNET 2026-07-26. DEGEN holds update
// authority and the 500bps royalty. Holding an asset in this collection is what grants
// the weapons below — walletLink.js filters on exactly this address, so pointing it at
// the wrong network silently grants nobody anything.
export const COLLECTION_MAINNET = 'EYAkv35MGh7FhnY32wZ6pckxa7Aw9hQYbu8JJJhpn1JW'
export const COLLECTION_DEVNET = 'CS9gJkpP9CUY834gYC19aWmtZSGAw2Rchj1aoMBG1NNC'
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'

// name -> entitlement. `weaponIndex` must match common/weaponsConfig.js.
export const NFT_ENTITLEMENTS = {
  'Long Debt':        { kind: 'weapon', weaponIndex: 6, label: 'Sniper' },
  'Vector Rifle':     { kind: 'weapon', weaponIndex: 0, label: 'Rifle' },
  'Static Repeater':  { kind: 'weapon', weaponIndex: 1, label: 'SMG' },
  'Breach Ward':      { kind: 'weapon', weaponIndex: 2, label: 'Shotgun' },
  'Degen Helm':       { kind: 'cosmetic', label: 'Helm' },
  'Cloth Cuirass':    { kind: 'cosmetic', label: 'Cuirass' },
  'Cloth Pauldron':   { kind: 'cosmetic', label: 'Pauldron' },
  'Cloth Sabaton':    { kind: 'cosmetic', label: 'Sabaton' },
  'Cloth Joint Cap':  { kind: 'cosmetic', label: 'Joint Cap' },
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
