// MENU SAFETY (v1): the explicit client -> server "put me in the arena" request.
//
// A nengi socket connection is a stream subscription, NOT a combatant: the server
// creates no PlayerCharacter pair, counts no human, and retires no autofill bot
// until this command is received and validated (server/GameInstance.deployPlayer).
// The acknowledgment is the EXISTING Identity message + the entity-create snapshot
// (the same contract the old connect-time spawn used), so the client needs no new
// ack handler — createPlayerFactory fires exactly as before, just later.
//
// Sent by Simulator.requestDeploy() on the PLAY click (instant play preserved —
// one click, no extra confirm) and by the map-rotation auto-rejoin path. The
// server rate-limits it (1 per 3s) and silently drops repeats/spam, so a spoofed
// flood costs nothing and a duplicate can never double-spawn.
class DeployCommand {
	constructor() { }
}

DeployCommand.protocol = {}

export default DeployCommand
