import nengi from 'nengi'
import { Engine, MeshBuilder, Vector3 } from '../babylon.node.js'

// TDM MATCH STATE — the low-rate carrier for everything the HUD needs about the
// match as a whole: phase, both team scores, the countdown, and the winner. It is
// DELIBERATELY a separate nengi entity, NOT fields on PlayerCharacter: the player
// protocol streams at the 40Hz UPDATE_RATE, and match state changes only on a
// score/phase flip (or the ~2Hz timer publish). nengi delta-compresses each entity
// independently, so an entity whose fields rarely change is near-free on the wire.
//
// It is server-authoritative in every sense: the server owns the single instance
// (GameInstance.matchState), writes its fields from the match state machine, and the
// client only READS them to paint the HUD. The client never constructs a score.
//
// It carries a bare position-holder mesh for the SAME reason MegaHealthPickup/Pickup
// do: the server records EVERY entity into the lag-comp historian each tick
// (server/lagCompensatedHitscanCheck.js reads realEntity.mesh.position), so an entity
// with no mesh would throw the first time anyone fires. GameInstance parks it high
// ABOVE the play space (inside the nengi view AABB, so it still replicates) where no
// shot passes, and the client factory keeps it invisible — it is never rendered and,
// having no `.client`, can never resolve to a damage target.
//
// PHASE mirrors GameInstance.MATCH_PHASE:
//   0 ACTIVE       — a live match; timeRemainingMs counts down toward TIME_LIMIT_MS
//   1 MATCH_END    — intermission; `winner` is set, scores frozen at their final value
//   2 SUDDEN_DEATH — overtime: scores were exactly tied at the 8:00 check or at 10:00,
//                    so the match plays on with NO clock until the first frag / lead
//                    change decides it (replaces the old DRAW-on-tie outcome).
export const MATCH_PHASE = { ACTIVE: 0, MATCH_END: 1, SUDDEN_DEATH: 2 }
// WINNER encoding: 0 = team 0 (RED), 1 = team 1 (BLUE), 2 = draw / none-yet. In FFA the
// winner is an INDIVIDUAL, so `winner` is unused (stays DRAW) — the client derives its
// own victory/defeat from the authoritative networked per-player kill counts.
export const MATCH_WINNER = { TEAM0: 0, TEAM1: 1, DRAW: 2 }
// MODE encoding carried on the MatchState so the client knows how to read the match:
//   0 TDM — two team scores, friendly fire off
//   1 FFA — no teams, individual frag scoring, everyone can damage everyone
export const MATCH_MODE = { TDM: 0, FFA: 1 }

class MatchState {
	constructor(startX = 0, startY = 0, startZ = 0) {
		const scene = Engine.LastCreatedScene
		if (scene) {
			// tiny non-pickable placeholder (mirrors Pickup/Mega). Invisible on visual
			// engines — it is a pure data entity, never rendered.
			this.mesh = MeshBuilder.CreateBox('matchState', { size: 0.2 }, scene)
			this.mesh.position.set(startX, startY, startZ)
			this.mesh.isPickable = false
			if (scene.getEngine().name !== 'NullEngine') {
				this.mesh.isVisible = false
				this.mesh.setEnabled(false)
			}
		} else {
			this.mesh = { position: new Vector3(startX, startY, startZ), dispose() {} }
		}

		this.phase = MATCH_PHASE.ACTIVE
		// team scores CAN go negative (a suicide/void death is -1 to the victim's own
		// team, standard TDM), so these are signed Int16 on the wire.
		this.teamScore0 = 0
		this.teamScore1 = 0
		this.timeRemainingMs = 0
		this.winner = MATCH_WINNER.DRAW
		// game mode (TDM/FFA). Set by GameInstance from the map/constant at boot; the
		// client reads it to pick the team scoreboard vs the FFA leaderboard + announcer.
		this.mode = MATCH_MODE.TDM
	}

	get x() { return this.mesh.position.x }
	set x(value) { this.mesh.position.x = value }

	get y() { return this.mesh.position.y }
	set y(value) { this.mesh.position.y = value }

	get z() { return this.mesh.position.z }
	set z(value) { this.mesh.position.z = value }
}

MatchState.protocol = {
	// position carried ONLY so nengi's per-client AABB culler keeps this entity in
	// every client's view (it reads entity.x/y/z). No interp — it never meaningfully moves.
	x: { type: nengi.Float32 },
	y: { type: nengi.Float32 },
	z: { type: nengi.Float32 },
	phase: nengi.UInt8,
	teamScore0: nengi.Int16,
	teamScore1: nengi.Int16,
	timeRemainingMs: nengi.UInt32,
	winner: nengi.UInt8,
	mode: nengi.UInt8
}

export default MatchState
