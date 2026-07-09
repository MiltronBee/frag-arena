const authoredMount = {
  scale: 0.01,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: Math.PI / 2, z: 0 },
  anims: { idle: 'idle', fire: 'fire', reload: 'reload', draw: 'draw' }
}

export const weapons = [
  {
    index: 0,
    name: 'Rifle',
    url: '/assets/weapons/retro_rifle_arms.glb',
    ...authoredMount,
    anims: { ...authoredMount.anims, draw: null },
    muzzle: { x: 0.08, y: -0.13, z: 1.05 },
    recoilForce: 1.0,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.15,
    reloadTime: 1.5,
    magazineCapacity: 30,
    maxReserveAmmo: 90,
    damage: 15,
    range: 100
  },
  {
    index: 1,
    name: 'SMG',
    url: '/assets/weapons/retro_smg_arms.glb',
    ...authoredMount,
    muzzle: { x: 0.08, y: -0.13, z: 0.90 },
    recoilForce: 0.6,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.08,
    reloadTime: 1.2,
    magazineCapacity: 40,
    maxReserveAmmo: 120,
    damage: 10,
    range: 60
  },
  {
    index: 2,
    name: 'Shotgun',
    url: '/assets/weapons/retro_shotgun_arms.glb',
    ...authoredMount,
    anims: { ...authoredMount.anims, draw: null },
    muzzle: { x: 0.08, y: -0.15, z: 1.05 },
    recoilForce: 2.2,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.8,
    reloadTime: 2.2,
    magazineCapacity: 8,
    maxReserveAmmo: 24,
    damage: 10, // per pellet
    pellets: 8,
    spread: 0.08,
    range: 30
  },
  {
    index: 3,
    name: 'Pistol',
    url: '/assets/weapons/retro_pistol_arms.glb',
    ...authoredMount,
    isOneHanded: true,
    muzzle: { x: 0.08, y: -0.14, z: 0.70 },
    recoilForce: 0.8,
    
    // Gameplay specs
    type: 'hitscan',
    fireCooldown: 0.3,
    reloadTime: 1.0,
    magazineCapacity: 12,
    maxReserveAmmo: 36,
    damage: 20,
    range: 50
  },
  {
    index: 4,
    name: 'Plasma Rifle',
    url: '/assets/weapons/retro_rifle_arms.glb', // reuse rifle glb
    ...authoredMount,
    anims: { ...authoredMount.anims, draw: null },
    muzzle: { x: 0.08, y: -0.13, z: 1.05 },
    recoilForce: 1.2,
    
    // Gameplay specs
    type: 'projectile',
    fireCooldown: 0.25,
    reloadTime: 1.8,
    magazineCapacity: 20,
    maxReserveAmmo: 60,
    damage: 25,
    projectileSpeed: 30
  }
]
export default weapons
