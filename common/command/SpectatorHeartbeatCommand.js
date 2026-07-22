// MENU SAFETY (v1): spectator activity heartbeat — keeps a MENU session alive.
//
// The spectator AFK timeout (server/GameInstance.js SPECTATOR_AFK_MS) is a true
// INACTIVITY timeout, not a hard session cap: real menu gestures (clicks, keys)
// make the client send this empty command (throttled client-side in
// Simulator._spectatorActivity), and the server stamps
// client._lastSpectatorActivityAt — rate-limited server-side to one accepted
// stamp per HEARTBEAT_MIN_INTERVAL_MS, so a spoofed flood costs one Date.now().
//
// SECURITY: the handler does NOTHING but refresh that timestamp for SPECTATOR
// sessions. It cannot create an entity, retire a bot, move, fire, or bypass the
// deploy handshake — DOM state is never combat authority; this only keeps a
// menu socket from being reaped while someone reads the whitepaper.
class SpectatorHeartbeatCommand {
	constructor() { }
}

SpectatorHeartbeatCommand.protocol = {}

export default SpectatorHeartbeatCommand
