// HUMAN-TOPOLOGY hit-registration proof.
//
// probe-hitreg.ts validates bots, where rawEntity === smoothEntity and the one
// entity is in the historian. A HUMAN is structurally different (deployPlayer):
// the raw entity lives in a private channel (NOT instance.entities, NOT the
// historian) and a SEPARATE smooth entity is what hitscan can ever see. This
// probe rebuilds exactly that topology in-process and fires the real performShot
// at it over known clear-LOS positions.
//
//   npx tsx scripts/probe-human.ts
import * as BABYLON from '../common/babylon.node.js'
import GameInstance from '../server/GameInstance'
import PlayerCharacter from '../common/entity/PlayerCharacter'
import { weapons } from '../common/weaponsConfig'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
const gi = new GameInstance('dm_hex2', 'FFA')
for (let i = 0; i < 200 && !gi.mapReady; i++) await sleep(100)
if (!gi.mapReady) throw new Error('map never ready')

// shooter: a plain bot (that path is already proven)
gi.addBot(0)
const A = gi.bots[gi.bots.length - 1]
A.latency = 0
A.rawEntity.currentWeaponIndex = 0
// park the fill bots far away
gi.bots.forEach(h => { if (h !== A) { h.rawEntity.x = 9000; h.rawEntity.y = 9000; h.rawEntity.z = 9000; h.rawEntity.mesh.computeWorldMatrix(true) } })

// victim: HUMAN topology, mirroring deployPlayer exactly —
// raw in a channel (never instance.entities), smooth via instance.addEntity.
const raw = new PlayerCharacter()
raw.mesh.checkCollisions = true
const channel = gi.instance.createChannel()
channel.addEntity(raw)                    // private channel — historian never sees it
const smooth = new PlayerCharacter()
smooth.mesh.checkCollisions = false
gi.instance.addEntity(smooth)             // THIS is what hitscan can hit
// bot:true so damagePlayer skips socket messages (no real websocket here); the
// damage/hp path itself is identical for bots and humans.
const handle = { bot: true, rawEntity: raw, smoothEntity: smooth, respawnAt: null, positions: [] }
raw.client = handle
smooth.client = handle

// clear-LOS pair measured by probe-hitreg (open-air above the floor)
const P = { x: -3, y: 6, z: -10 }, Q = { x: -3, y: 6, z: -2 }
A.rawEntity.x = P.x; A.rawEntity.y = P.y; A.rawEntity.z = P.z
raw.x = Q.x; raw.y = Q.y; raw.z = Q.z
smooth.x = Q.x; smooth.y = Q.y; smooth.z = Q.z
raw.spawnImmunity = 0; smooth.spawnImmunity = 0
const dx = Q.x - P.x, dy = Q.y - P.y, dz = Q.z - P.z
A.rawEntity.rotationY = Math.atan2(dx, dz)
A.rawEntity.rotationX = -Math.atan2(dy, Math.hypot(dx, dz))
A.rawEntity.mesh.computeWorldMatrix(true)
raw.mesh.computeWorldMatrix(true); smooth.mesh.computeWorldMatrix(true)
for (let t = 0; t < 12; t++) gi.instance.update()

console.log(`victim raw nid=${raw.nid} (channel) smooth nid=${smooth.nid} (historian)`)
const hp0 = raw.hitpoints
for (let s = 0; s < 3; s++) {
	A.rawEntity.weaponsState[0].onCooldown = false
	A.rawEntity.weaponsState[0].cooldownTimer = 0
	gi.performShot(A)
	gi.instance.update()
}
console.log(`3 rifle shots at 8m clear LOS: victim hp ${hp0} -> raw=${raw.hitpoints} smooth=${smooth.hitpoints}`)
const dmg = hp0 - raw.hitpoints
const lockstep = raw.hitpoints === smooth.hitpoints
console.log(dmg === 45 && lockstep
	? 'PASS  exactly 15/shot, raw+smooth in lockstep — human topology hit-reg OK'
	: `FAIL  expected 45 dmg in lockstep, got ${dmg} (lockstep=${lockstep})`)

// and the occlusion side: put a real wall between them (the blocked pair from the
// 1v1 traces) and confirm zero damage
const P2 = { x: 12.52, y: 7.26, z: -14.66 }, Q2 = { x: -3.88, y: 2.47, z: -10.83 }
A.rawEntity.x = P2.x; A.rawEntity.y = P2.y; A.rawEntity.z = P2.z
raw.x = Q2.x; raw.y = Q2.y; raw.z = Q2.z
smooth.x = Q2.x; smooth.y = Q2.y; smooth.z = Q2.z
const dx2 = Q2.x - P2.x, dy2 = Q2.y - P2.y, dz2 = Q2.z - P2.z
A.rawEntity.rotationY = Math.atan2(dx2, dz2)
A.rawEntity.rotationX = -Math.atan2(dy2, Math.hypot(dx2, dz2))
A.rawEntity.mesh.computeWorldMatrix(true)
raw.mesh.computeWorldMatrix(true); smooth.mesh.computeWorldMatrix(true)
for (let t = 0; t < 12; t++) gi.instance.update()
const hp1 = raw.hitpoints
for (let s = 0; s < 3; s++) {
	A.rawEntity.weaponsState[0].onCooldown = false
	A.rawEntity.weaponsState[0].cooldownTimer = 0
	gi.performShot(A)
	gi.instance.update()
}
console.log(`3 shots through the 1v1's blocked sightline: hp ${hp1} -> ${raw.hitpoints}`)
console.log(raw.hitpoints === hp1
	? 'PASS  wall blocked every shot (matches brute-force geometry truth)'
	: 'FAIL  damage leaked through the wall')
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
