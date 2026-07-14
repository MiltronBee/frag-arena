import Obstacle from '../common/entity/Obstacle'
import { OBSTACLE_SPECS, obstacleY } from '../common/arenaConfig'

export default instance => {
	const obstacles = new Map()

	OBSTACLE_SPECS.forEach(spec => {
		const obstacle = new Obstacle()
		obstacle.x = spec.x
		obstacle.y = spec.y === undefined ? obstacleY(spec.height) : spec.y
		obstacle.z = spec.z
		obstacle.width = spec.width
		obstacle.height = spec.height
		obstacle.depth = spec.depth
		obstacle.style = spec.style

		instance.addEntity(obstacle)
		obstacles.set(obstacle.nid, obstacle)
		obstacle.mesh.computeWorldMatrix(true)
	})

	return obstacles
}
