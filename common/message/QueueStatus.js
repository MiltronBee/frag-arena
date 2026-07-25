import nengi from 'nengi'

// ARENA FULL -> SPECTATOR QUEUE. Sent to a client whose DeployCommand could not be
// honoured because the arena is at capacity, and re-sent to everyone still waiting
// whenever the queue shifts, so the position they see stays true.
//
// `position` is 1-based (1 = next in). A position of 0 means "you are being deployed
// now" and is the queue's exit signal — the entity-create snapshot follows it.
class QueueStatus {
	constructor(position, size, capacity) {
		this.position = position
		this.size = size
		this.capacity = capacity
	}
}

QueueStatus.protocol = {
	position: nengi.UInt8,
	size: nengi.UInt8,
	capacity: nengi.UInt8,
}

export default QueueStatus
