import { logger } from '../utils/logger.js'
import type { Outcome } from '@google/jules-sdk'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import type { JulesSession, JulesSessionInfo } from './julesTypes.js'

// Force a fresh session.info() by bypassing the SDK's local cache. Every call
// goes through the shared scheduler so it obeys the global rate-limit budget.
export async function getFreshSessionInfo(session: JulesSession): Promise<JulesSessionInfo> {
  try {
    if (session?.sessionStorage && typeof session.sessionStorage.delete === 'function') {
      await session.sessionStorage.delete(session.id)
    }
  } catch (err) {
    logger.error(`[getFreshSessionInfo] Failed to delete cache for session ${session?.id}:`, err)
  }
  return await session.info()
}

// Retrieve the final artifact of a completed session (e.g. its pull request).
// A missing result must not fail the stream — completion handling proceeds
// without it.
export async function getCompletedSessionResult(
  session: JulesSession,
  sessionId: string,
): Promise<Outcome | null> {
  try {
    return await scheduleJulesRequest(() => session.result({ timeoutMs: 15_000 }))
  } catch (err) {
    logger.warn(
      `[runJulesStream] Session ${sessionId} completed, but its result could not be retrieved:`,
      err,
    )
    return null
  }
}
