import nengi from 'nengi'

// OBJECTIVE EVENT (CTF/DOM) — the killfeed/announcer wire event for mode objectives.
// Broadcast to EVERYONE via instance.messageAll (NOT addLocalMessage, which is
// spatially culled and requires x/y — same reasoning as the Killed message). The
// client maps `kind` -> a killfeed line + an existing announcer clip (no new SFX in
// v1); `team` names the team the callout is ABOUT (flag owner / capturing team / new
// point owner), `playerNid` is the acting player's SMOOTH nid (0 if none).
export const OBJECTIVE_EVENT = {
	FLAG_TAKEN: 0,
	FLAG_DROPPED: 1,
	FLAG_RETURNED: 2,
	FLAG_CAPTURED: 3,
	DOM_CAPTURED: 4,
}

class ObjectiveEvent {
	constructor(kind = 0, team = 0, playerNid = 0) {
		this.kind = kind
		this.team = team
		this.playerNid = playerNid
	}
}

ObjectiveEvent.protocol = {
	kind: nengi.UInt8,
	team: nengi.UInt8,
	playerNid: nengi.UInt16,
}

export default ObjectiveEvent
