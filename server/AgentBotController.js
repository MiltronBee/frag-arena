// FRAGBENCH v0 — the "motor cortex" half of the strategist+controller split from the
// locked roundtable spec (_work/modes/roundtable-transcript-v3.md §5): an external LLM
// strategist emits low-rate INTENT; this controller (a plain BotController subclass)
// keeps executing aim/strafe/path/fire in the 40Hz think loop. The LLM never touches a
// tick-level input, so the latency wall never applies to it.
//
// v0 intent surface (deliberately small — target priority IS the v0 strategy axis):
//   { targetNid:  <nid|null>  pin the fight onto this combatant while they're alive
//                             (falls back to native nearest-target when absent/dead),
//     holdFire:   <bool>      suppress the trigger (disengage/reposition posture) }
// Deferred (spec'd, not built): goto/waypoint goals, combat_posture profiles, the
// semantic-noise observation mutations, the reference-controller Docker container.
import BotController from './BotController'

class AgentBotController extends BotController {
	constructor(entity, weaponIndex) {
		super(entity, weaponIndex)
		this.intent = { targetNid: null, holdFire: false }
		this.agentLabel = null // benchmark entrant name (set by the AgentGateway)
	}

	think(delta, now, combatants, occluderMeshes) {
		const it = this.intent
		if (it && it.targetNid != null) {
			const pinned = combatants.find(c => c.nid === it.targetNid && c.isAlive !== false)
			if (pinned) {
				// pin: install the target and keep the native retarget timer pushed out so
				// super.think()'s nearest-enemy pick never overrides a live strategist order
				this.target = pinned
				this.retargetAt = now + 1000
			} else {
				it.targetNid = null // died or left — release to native targeting
			}
		}
		const command = super.think(delta, now, combatants, occluderMeshes)
		if (it && it.holdFire) command.fireInput = false
		return command
	}
}

export default AgentBotController
