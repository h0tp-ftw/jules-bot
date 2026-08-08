import { JULES_POLLING } from '../../config.js'
import { ActivityPollScheduler } from './ActivityPollScheduler.js'

export const julesRequestCoordinator = new ActivityPollScheduler(JULES_POLLING)

export function scheduleJulesRequest<T>(operation: () => Promise<T>): Promise<T> {
  return julesRequestCoordinator.request(operation)
}
