import { logger } from '../utils/logger.js'
import { prisma } from '../../config.js'
import type { TurnResponseState } from '../utils/sessionOutcome.js'
import { deriveTurnResponseState } from '../utils/sessionOutcome.js'
import { julesRequestCoordinator as activityPollScheduler } from './JulesRequestCoordinator.js'
import type { JulesDiscordChannel } from './channelTypes.js'
import { getLatestBotMessageTimestamp } from './discordHistory.js'

export function getActivityDate(activity: any): Date | null {
  if (!activity?.createTime) return null
  const date = new Date(activity.createTime)
  return Number.isNaN(date.getTime()) ? null : date
}

async function hydrateSessionHistory(
  session: any,
  sessionId: string,
): Promise<{
  activities: any[]
  hydrated: boolean
}> {
  let hydrated = false
  try {
    const synced = await activityPollScheduler.request(() => session.activities.hydrate())
    hydrated = true
    logger.debug(`[runJulesStream] Hydrated ${synced} activities for session ${sessionId}.`)
  } catch (err) {
    logger.warn(`[runJulesStream] Failed to hydrate history for session ${sessionId}:`, err)
  }

  let activities: any[] = []
  try {
    // hydrate() above already performed the network sync. Read the SDK cache
    // directly so initialization does not immediately issue a second activities
    // request through session.history().
    activities = await session.activities.select({ order: 'asc' })
  } catch (err) {
    logger.error(`[runJulesStream] Failed to read cached history for session ${sessionId}:`, err)
  }

  return { activities, hydrated }
}

export async function initializeProcessedActivityIds(
  session: any,
  sessionId: string,
  thread: JulesDiscordChannel,
  initialProcessedIds?: Set<string>,
): Promise<{ ids: Set<string>; hydrated: boolean; turnState: TurnResponseState }> {
  const { activities, hydrated } = await hydrateSessionHistory(session, sessionId)
  const ids = initialProcessedIds ? new Set(initialProcessedIds) : new Set<string>()
  const result = () => ({
    ids,
    hydrated,
    turnState: deriveTurnResponseState(activities, ids),
  })

  if (initialProcessedIds) {
    logger.debug(
      `[runJulesStream] Using provided initial processed activity IDs (count: ${ids.size})`,
    )
    return result()
  }

  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: thread.id },
    select: {
      lastDeliveredActivityId: true,
      lastDeliveredActivityAt: true,
      deliveryCursorInitialized: true,
    },
  })

  if (sessionRecord?.deliveryCursorInitialized) {
    const cursorIndex = sessionRecord.lastDeliveredActivityId
      ? activities.findIndex((activity) => activity.id === sessionRecord.lastDeliveredActivityId)
      : -1

    if (cursorIndex >= 0) {
      for (let i = 0; i <= cursorIndex; i++) ids.add(activities[i].id)
    } else if (sessionRecord.lastDeliveredActivityAt) {
      const cutoff = sessionRecord.lastDeliveredActivityAt.getTime()
      for (const activity of activities) {
        const createdAt = getActivityDate(activity)
        if (createdAt && createdAt.getTime() <= cutoff) ids.add(activity.id)
      }
    }

    logger.debug(
      `[runJulesStream] Restored ${ids.size} delivered activities from the persisted cursor for thread ${thread.id}.`,
    )
    return result()
  }

  // Existing installations have no delivery cursor. Establish a one-time
  // baseline from the newest message this bot actually posted in Discord. Jules
  // activities newer than that message remain unprocessed and are replayed,
  // which recovers replies that completed while the bot was offline.
  const latestBotMessageTimestamp = await getLatestBotMessageTimestamp(thread)
  let lastBaselineActivity: any = null
  if (latestBotMessageTimestamp !== null) {
    for (const activity of activities) {
      const createdAt = getActivityDate(activity)
      if (createdAt && createdAt.getTime() <= latestBotMessageTimestamp) {
        ids.add(activity.id)
        if (
          !lastBaselineActivity ||
          createdAt.getTime() >= (getActivityDate(lastBaselineActivity)?.getTime() || 0)
        ) {
          lastBaselineActivity = activity
        }
      }
    }
  }

  try {
    await prisma.debugSession.update({
      where: { threadId: thread.id },
      data: {
        deliveryCursorInitialized: true,
        lastDeliveredActivityId: lastBaselineActivity?.id || null,
        lastDeliveredActivityAt: getActivityDate(lastBaselineActivity),
      },
    })
  } catch (err) {
    logger.error(
      `[runJulesStream] Failed to initialize delivery cursor for thread ${thread.id}:`,
      err,
    )
  }

  logger.info(
    `[runJulesStream] Initialized legacy delivery cursor for thread ${thread.id}; ${ids.size} historical activities treated as delivered and ${activities.length - ids.size} left for recovery.`,
  )
  return result()
}

export async function persistDeliveredActivity(threadId: string, activity: any) {
  try {
    await prisma.debugSession.update({
      where: { threadId },
      data: {
        deliveryCursorInitialized: true,
        lastDeliveredActivityId: activity.id,
        lastDeliveredActivityAt: getActivityDate(activity),
      },
    })
  } catch (err) {
    // Discord delivery already succeeded. Keep the in-memory ID so this process
    // does not duplicate the message, and log the persistence failure for repair.
    logger.error(
      `[runJulesStream] Discord delivery succeeded but cursor persistence failed for activity ${activity.id} in thread ${threadId}:`,
      err,
    )
  }
}
