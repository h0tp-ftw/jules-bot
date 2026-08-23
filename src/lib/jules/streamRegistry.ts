import { julesRequestCoordinator as activityPollScheduler } from './JulesRequestCoordinator.js'

// Module-level per-thread state shared by the session stream lifecycle.
export const activeStreams = new Set<string>()
export const autoRejectedSessions = new Set<string>()
export const processedActivityIdsMap = new Map<string, Set<string>>()

export function wakeJulesStream(channelId: string): void {
  activityPollScheduler.wake(channelId)
}

// Release all per-thread module state for a stream handler that is exiting for
// good (failed / archived / deleted / retries exhausted). Centralized so every
// exit path cleans up the same sets — previously some paths leaked
// autoRejectedSessions or processedActivityIdsMap. Completed/idle sessions now
// stay warm only for a bounded grace period; after that, the next Discord action
// rehydrates them on demand instead of keeping an eternal Jules poller alive.
export function teardownStreamState(threadId: string, sessionId?: string) {
  activityPollScheduler.remove(threadId)
  activeStreams.delete(threadId)
  processedActivityIdsMap.delete(threadId)
  if (sessionId) autoRejectedSessions.delete(sessionId)
}
