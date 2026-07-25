// Does a submesh octree on the MOVEMENT colliders pay for itself?
//
// The CPU profile says Babylon collision is ~70% of active tick time, and
// _processCollisionsForSubMeshes — the broadphase that walks every submesh of every
// checkCollisions mesh — is its biggest single slice. An octree is the textbook fix.
// The codebase notes one was NOT worth it for the HITSCAN occluders, but that is a
// different mesh set answering a different query, so measure this path itself.
//
// INTERLEAVED A/B: a first attempt showed a 35% swing between two sequential runs,
// which is drift, not signal. Alternate configurations and take medians.
//
//   npx tsx scripts/probe-octree.ts [mapId]
import '@babylonjs/core/Culling/Octrees/index.js'
import GameInstance from '../server/GameInstance'
import nengiConfig from '../common/nengiConfig'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DT = 1 / nengiConfig.UPDATE_RATE

const main = async () => {
const gi = new GameInstance(process.argv[2] || 'dm_hex2', null)
for (let i = 0; i < 300 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never ready')
while (gi.bots.length < 8) gi.addBot(gi.bots.length)
while (gi.bots.length > 8) gi.removeBot(gi.bots[gi.bots.length - 1])

// GameInstance keeps no scene handle, but the occluder clones do — each was cloned
// from a movement collider and shares its scene.
const scene = gi.occluderMeshes.length ? gi.occluderMeshes[0].getScene() : null
if (!scene) throw new Error('no scene handle')
const withGeom = scene.meshes.filter(m =>
  m.checkCollisions && m.getTotalVertices && m.getTotalVertices() > 0 &&
  m.name !== 'player' && !/^occluder_/.test(m.name))
let sub = 0
withGeom.forEach(m => { sub += (m.subMeshes || []).length })
console.log('movement colliders: ' + withGeom.length + ' meshes, ' + sub + ' submeshes')
console.log('(broadphase walks all of them per player per collision step)\n')

const bench = (ticks) => {
  for (let i = 0; i < 250; i++) gi.update(DT)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < ticks; i++) gi.update(DT)
  return Number(process.hrtime.bigint() - t0) / 1e6 / ticks
}
const med = a => { const c = a.slice().sort((x, y) => x - y); return c[c.length >> 1] }
const drop = () => withGeom.forEach(m => { m._submeshesOctree = null })
const build = () => {
  let n = 0
  withGeom.forEach(m => {
    if (typeof m.createOrUpdateSubmeshesOctree === 'function') { m.createOrUpdateSubmeshesOctree(32, 2); n++ }
  })
  return n
}

const A = [], B = []
let built = 0
for (let r = 0; r < 3; r++) {
  drop()
  const a = bench(900); A.push(a)
  built = build()
  const b = bench(900); B.push(b)
  console.log('  round ' + r + ':  no-octree ' + a.toFixed(3) + ' ms   octree ' + b.toFixed(3) + ' ms')
}
const before = med(A), after = med(B)
console.log('\noctrees built on ' + built + ' meshes')
console.log('median no-octree : ' + before.toFixed(3) + ' ms/tick')
console.log('median octree    : ' + after.toFixed(3) + ' ms/tick')
const gain = (1 - after / before) * 100
console.log('delta            : ' + (before - after).toFixed(3) + ' ms/tick (' + gain.toFixed(1) + '%)')
console.log('\n' + (gain > 10
  ? 'WORTH IT — wire createOrUpdateSubmeshesOctree into _loadMapMesh'
  : 'NOT WORTH IT at this roster/geometry — the ~12-tri subdivision already gives\n' +
    'the per-submesh AABB cull enough to bite on; leave the collider path alone.'))
}
main().then(() => process.exit(0), e => { console.error('FAILED:', e.message); process.exit(1) })
