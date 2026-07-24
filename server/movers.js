// UT99 LIFTS — server-authoritative mover state machine + the "platform clamp" carry.
//
// The map registry carries the raw lift data (MOVERS, native units — see
// common/mapRegistry.js dm_gantry162); this module turns each into a replicated
// common/entity/Mover.js (a collidable box floor whose y is driven by the state machine)
// and owns the clock. There is NO client-side mover simulation — the client only nengi-
// interpolates the replicated position (and predicts its OWN carry against that interp).
//
// CARRYING lives OUTSIDE common/applyCommand.js (untouched — golden harness stays byte-
// identical). After the normal sim step, both sides run the same idempotent clamp: a rider
// standing on the platform footprint within a height band is pinned to the platform surface
// (raw+smooth on the server; the owner's predicted entity on the client — Simulator.js).
// Because the clamp is "y := platform rest height", client and server converge with no
// Teleported-style handover, even though the client's view of the platform lags ~one interp
// window (~100 ms) behind the server — the documented ride-desync tradeoff.
//
// The Mover's checkCollisions box additionally makes the platform a real STANDABLE floor
// (the shared floor probe lands on it) — critical here because Deck16's shafts are baked
// HOLES (RECON Q3): without the box a rest-state platform is a walk-in pit.

import { MOVER_STATE } from '../common/entity/Mover'
import Mover from '../common/entity/Mover'

// --- carry geometry (world metres) ---------------------------------------------------
// A rider rests RIDE_REST above the platform SURFACE TOP: ellipsoid radius (0.5) + the
// sim's resting floor gap (FLOOR_GAP_TARGET 0.0316). Same value the client clamp uses.
export const RIDE_REST = 0.5316
// Horizontal skin past the footprint edge, and the vertical grab band around the rest
// height (feet on / just above the platform). velY above JUMP_EPS = jumping off, disengage.
export const CARRY_SKIN = 0.2
export const CARRY_BAND_BELOW = 0.8
export const CARRY_BAND_ABOVE = 1.2
export const JUMP_EPS = 0.1

// Collidable platform thickness (world). The real UT platform is ~0.2 m; we make the
// collision/visual box chunkier so the floor probe lands reliably and a fast rise can't
// clip a rider between ticks (the clamp is the real carry, but a solid box is the floor).
const BOX_HEIGHT = 0.6

// StayOpenTime at the top key (seconds). UT class default is 4.0; spec says use 3.
const STAY_OPEN = 3.0

// smoothstep ease (GlideByTime feel) — a gentle accelerate/decelerate over the ride.
const ease = t => t * t * (3 - 2 * t)

// Surface top (world y of the standable face) for a mover in its current state.
function surfaceTopY(m) {
	return m.restTopW + (m.topTopW - m.restTopW) * ease(m.t)
}

// Is this alive entity a rider (XZ inside footprint+skin, feet within the grab band)?
function isRider(entity, m, top) {
	const dx = entity.x - m.cx
	const dz = entity.z - m.cz
	if (dx < -m.half - CARRY_SKIN || dx > m.half + CARRY_SKIN) return false
	if (dz < -m.half - CARRY_SKIN || dz > m.half + CARRY_SKIN) return false
	const rideY = top + RIDE_REST
	return entity.y >= rideY - CARRY_BAND_BELOW && entity.y <= rideY + CARRY_BAND_ABOVE
}

export default class MoverController {
	// gi = GameInstance. Reads gi.map.MOVERS (native units), builds a Mover entity per lift.
	constructor(gi) {
		this.gi = gi
		this.movers = []
		this.entities = []
		const map = gi.map
		const list = Array.isArray(map && map.MOVERS) ? map.MOVERS : []
		const s = (map && map.scale) || 1
		for (const raw of list) {
			const halfW = raw.half * s
			const m = {
				kind: raw.kind || 'lift',
				cx: raw.x * s,
				cz: raw.z * s,
				half: halfW,
				restTopW: raw.restY * s, // world y of the standable face at the bottom key
				topTopW: raw.topY * s,   // ...and at the top key
				moveTime: raw.moveTime || 1.0,
				t: 0,                    // 0 = bottom, 1 = top
				state: MOVER_STATE.AT_BOTTOM,
				stayTimer: 0,
			}
			// replicated box: entity.y is the box CENTRE, so its top face = surfaceTop.
			const ent = new Mover()
			ent.width = halfW * 2
			ent.height = BOX_HEIGHT
			ent.depth = halfW * 2
			ent.x = m.cx
			ent.z = m.cz
			ent.y = m.restTopW - BOX_HEIGHT / 2
			ent.state = m.state
			ent.mesh.computeWorldMatrix(true)
			gi.instance.addEntity(ent)
			m.entity = ent
			this.movers.push(m)
			this.entities.push(ent)
		}
		if (this.movers.length) console.log(`[movers] ${map.id}: ${this.movers.length} lift(s) built`)
	}

	// Advance every mover one tick. `aliveEntities` = raw entities that can ride (used
	// only for TRIGGER detection; the carry itself is applied per-entity via carry()).
	tick(delta, aliveEntities) {
		for (const m of this.movers) {
			const top = surfaceTopY(m)
			let riderPresent = false
			for (const e of aliveEntities) {
				if (isRider(e, m, top)) { riderPresent = true; break }
			}
			// TIMED lift (UT bBumpOpenTimed): rises on the RISING EDGE of a rider stepping
			// on, holds StayOpenTime at the top, then descends REGARDLESS of occupancy (a
			// rider standing on it rides back down — "descend after pause", DESIGN §2). The
			// rising-edge boarding (riderPresent && !wasRider) is what stops a rider who rode
			// back to the bottom from instantly re-launching the lift — they must step off and
			// on again, exactly like a UT bump-trigger.
			const boarding = riderPresent && !m._wasRider
			switch (m.state) {
				case MOVER_STATE.AT_BOTTOM:
					if (boarding) m.state = MOVER_STATE.RISING
					break
				case MOVER_STATE.RISING:
					m.t += delta / m.moveTime
					if (m.t >= 1) { m.t = 1; m.state = MOVER_STATE.AT_TOP; m.stayTimer = STAY_OPEN }
					break
				case MOVER_STATE.AT_TOP:
					m.stayTimer -= delta
					if (m.stayTimer <= 0) m.state = MOVER_STATE.DESCENDING
					break
				case MOVER_STATE.DESCENDING:
					m.t -= delta / m.moveTime
					if (m.t <= 0) { m.t = 0; m.state = MOVER_STATE.AT_BOTTOM }
					break
			}
			m._wasRider = riderPresent
			if (m.state !== m._lastState) {
				console.log(`[movers] ${this.gi.map.id} lift state ${m._lastState} -> ${m.state} (t=${m.t.toFixed(2)}, rider=${riderPresent})`)
				m._lastState = m.state
			}
			// publish position + state onto the replicated entity, keep the world matrix
			// fresh so moveWithCollisions collides against the platform where it now is.
			const newTop = surfaceTopY(m)
			m.entity.y = newTop - BOX_HEIGHT / 2
			m.entity.state = m.state
			m.entity.mesh.computeWorldMatrix(true)
		}
	}

	// Idempotent platform clamp for one entity. If it is standing on any mover's footprint
	// within the grab band and not jumping off, pin it to the platform rest height and
	// ground it. Returns true if carried. Used server-side per raw entity (caller mirrors
	// y/velY/grounded to smooth); the client runs the same logic in Simulator against the
	// INTERPOLATED mover entities.
	carry(entity) {
		for (const m of this.movers) {
			const top = surfaceTopY(m)
			const rideY = top + RIDE_REST
			const dx = entity.x - m.cx
			const dz = entity.z - m.cz
			if (dx < -m.half - CARRY_SKIN || dx > m.half + CARRY_SKIN) continue
			if (dz < -m.half - CARRY_SKIN || dz > m.half + CARRY_SKIN) continue
			if (entity.y < rideY - CARRY_BAND_BELOW || entity.y > rideY + CARRY_BAND_ABOVE) continue
			if (entity.velY > JUMP_EPS) continue // jumping off disengages
			entity.y = rideY
			entity.velY = 0
			entity.grounded = true
			return true
		}
		return false
	}
}
