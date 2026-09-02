import { logger } from '../utils/logger.js'
import { JulesClient } from './JulesClient.js'
import type { StreamManager } from '../streams/StreamManager.js'
import { getEffectiveConfig, JULES_POLLING } from '../../config.js'
import { t } from '../../strings.js'
import {
  completeConversationTurn,
  markConversationTurnResponded,
} from './ConversationQueue.js'
import {
  applyActivityToTurnState,
  type TurnResponseState,
} from '../utils/sessionOutcome.js'
import { reactionStageForState, isIdleSessionState } from '../utils/sessionState.js'
import { formatErrorForDiscord } from '../utils/errors.js'
import { isJulesRateLimitError } from './ActivityPollScheduler.js'
import { julesRequestCoordinator as activityPollScheduler } from './JulesRequestCoordinator.js'
import {
  activeStreams,
  processedActivityIdsMap,
  teardownStreamState,
} from './streamRegistry.js'
import { updateReaction } from './reactions.js'
import { initializeProcessedActivityIds, persistDeliveredActivity } from './deliveryCursor.js'
import { getFreshSessionInfo } from './sessionInfo.js'
import type { JulesActivity, JulesSession } from './julesTypes.js'
import type { JulesDiscordChannel } from './channelTypes.js'
import { createTypingController } from './stream/typingIndicator.js'
import { createStreamTurnTarget } from './stream/streamTurnTarget.js'
import {
  handlePlanGenerated,
  handleProgressUpdated,
  handleAgentMessaged,
  handleSessionCompleted,
  handleSessionFailed,
  handleUserMessaged,
  type ActivityHandlerContext,
} from './stream/activityHandlers.js'

export async function runJulesStream(
  sessionId: string,
  thread: JulesDiscordChannel,
  streamManager: StreamManager,
  initialProcessedIds?: Set<string>,
  onReady?: () => void,
  options: { chatbotMode?: boolean; sessionFactory?: (sessionId: string) => JulesSession } = {},
) {
  const chatbotMode = options.chatbotMode === true
  const getSession = options.sessionFactory ?? ((id: string) => JulesClient.getSession(id))

  if (activeStreams.has(thread.id)) {
    logger.debug(
      `[runJulesStream] activeStreams already has thread ${thread.id}. Exiting stream handler creation.`,
    )
    return
  }
  activeStreams.add(thread.id)
  activityPollScheduler.register(thread.id)
  logger.debug(
    `[runJulesStream] Starting stream handler for thread ${thread.id}, sessionId: ${sessionId}`,
  )

  const typingController = createTypingController(thread)
  const turnTarget = createStreamTurnTarget(thread)

  let historyHydratedForNextStream = false
  let turnState: TurnResponseState = { awaitingAgentReply: false }
  let processedActivityIds = processedActivityIdsMap.get(thread.id)
  if (!processedActivityIds) {
    try {
      const session = getSession(sessionId)
      const initialized = await initializeProcessedActivityIds(
        session,
        sessionId,
        thread,
        initialProcessedIds,
      )
      processedActivityIds = initialized.ids
      historyHydratedForNextStream = initialized.hydrated
      turnState = initialized.turnState
    } catch (err) {
      logger.error(
        `[runJulesStream] Failed to restore delivery cursor for thread ${thread.id}; falling back to replay:`,
        err,
      )
      processedActivityIds = initialProcessedIds ? new Set(initialProcessedIds) : new Set<string>()
    }
    processedActivityIdsMap.set(thread.id, processedActivityIds)
  }

  try {
    onReady?.()
  } catch {
    // A misbehaving ready callback must not take down the stream handler.
  }

  let consecutiveFailures = 0
  const maxRetries = 20
  let retryDelay = 5000
  let operationPhase: 'jules' | 'activity' = 'jules'
  let pauseNoticeSent = false
  let emptyPollsWithoutActivity = 0

  const markActivityProcessed = async (activity: JulesActivity) => {
    processedActivityIds!.add(activity.id)
    await persistDeliveredActivity(thread.id, activity)
    consecutiveFailures = 0
    retryDelay = 5000
  }

  while (consecutiveFailures < maxRetries) {
    try {
      operationPhase = 'jules'
      if (thread.isThread() && thread.archived) {
        logger.debug(`[runJulesStream] Thread ${thread.id} is archived. Exiting stream handler.`)
        typingController.stop()
        turnTarget.releaseActiveQueuedTurn('stream_ended')
        teardownStreamState(thread.id, sessionId)
        return
      }

      logger.debug(`[runJulesStream] Fetching session info for ${sessionId}...`)
      const session = getSession(sessionId)
      let info = await activityPollScheduler.request(() => getFreshSessionInfo(session))
      logger.debug(`[runJulesStream] Session ${sessionId} info: state=${info?.state}`)

      if (!info) {
        logger.debug(
          `Session ${sessionId} not found or deleted on backend. Exiting stream handler.`,
        )
        typingController.stop()
        turnTarget.releaseActiveQueuedTurn('stream_ended')
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (info && info.state === 'failed') {
        logger.debug(`Session ${sessionId} is failed. Exiting stream handler.`)
        typingController.stop()
        turnTarget.releaseActiveQueuedTurn('session_failed')
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (isIdleSessionState(info?.state) && !turnTarget.getCurrentQueuedTurnId()) {
        activityPollScheduler.markIdle(thread.id, false)
      } else {
        activityPollScheduler.markActive(thread.id)
      }

      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        typingController.start()
      } else {
        typingController.stop()
      }

      if (info && info.state === 'queued') {
        const targetMessage = await turnTarget.getTarget()
        await updateReaction(targetMessage, 'queued')
      }
      let queuedWaitMs = 0
      const maxQueuedWaitMs = 2 * 60 * 1000 // 2 minutes max
      while (info && info.state === 'queued') {
        if (queuedWaitMs >= maxQueuedWaitMs) {
          logger.error(`Session ${sessionId} stuck in queued state for too long. Aborting.`)
          await thread.send(getEffectiveConfig(thread).messages.session.queued_timeout)
          turnTarget.releaseActiveQueuedTurn('stream_ended')
          teardownStreamState(thread.id, sessionId)
          typingController.stop()
          return
        }
        logger.debug(`[runJulesStream] is queued. Waiting ${JULES_POLLING.active_interval_ms}ms...`)
        await new Promise((resolve) => setTimeout(resolve, JULES_POLLING.active_interval_ms))
        queuedWaitMs += JULES_POLLING.active_interval_ms
        info = await activityPollScheduler.request(() => getFreshSessionInfo(session))
      }
      if (isIdleSessionState(info?.state) && !turnTarget.getCurrentQueuedTurnId()) {
        activityPollScheduler.markIdle(thread.id, false)
      } else {
        activityPollScheduler.markActive(thread.id)
      }

      const targetMessage = await turnTarget.getTarget()
      const reconnectStage = reactionStageForState(info?.state)
      if (reconnectStage) {
        await updateReaction(targetMessage, reconnectStage)
      }
      if (info && info.state === 'paused' && !pauseNoticeSent) {
        const lastHuman = await turnTarget.getTarget()
        const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
        const sessionUrl = info.url || 'https://jules.google'
        await thread.send(t(threadConfig.messages.session.paused_notice, { url: sessionUrl }))
        pauseNoticeSent = true
      }
      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        typingController.start()
      }

      const typingMode = getEffectiveConfig(thread).typing_indicator_mode || 'until_response'
      let skipHydrateOnce = historyHydratedForNextStream
      historyHydratedForNextStream = false
      logger.debug(`[runJulesStream] Entering scheduled activity polling for ${sessionId}...`)

      while (true) {
        const scheduledPoll = await activityPollScheduler.poll(thread.id, async () => {
          let synced = 0
          if (skipHydrateOnce) {
            skipHydrateOnce = false
          } else {
            synced = await session.activities.hydrate()
          }
          const activities = await session.activities.select({ order: 'asc' })
          return { synced, activities }
        })

        if (scheduledPoll.expired) {
          logger.info(
            `[runJulesStream] Session ${sessionId} has been idle for ${Math.round(JULES_POLLING.idle_timeout_ms / 60000)} minutes. Suspending activity polling for thread ${thread.id} until the next Discord action.`,
          )
          typingController.stop()
          turnTarget.releaseActiveQueuedTurn('stream_ended')
          teardownStreamState(thread.id, sessionId)
          return
        }

        consecutiveFailures = 0
        retryDelay = 5000
        if (scheduledPoll.value.synced > 0) {
          emptyPollsWithoutActivity = 0
          pauseNoticeSent = false
          logger.debug(
            `[runJulesStream] Incrementally hydrated ${scheduledPoll.value.synced} new activities for session ${sessionId}.`,
          )
        } else {
          emptyPollsWithoutActivity++
          if (emptyPollsWithoutActivity >= 6) {
            emptyPollsWithoutActivity = 0
            const currentInfo = await activityPollScheduler.request(() =>
              getFreshSessionInfo(session),
            )
            if (currentInfo && currentInfo.state === 'paused') {
              activityPollScheduler.markIdle(thread.id, false)
              typingController.stop()
              const target = await turnTarget.getTarget()
              await updateReaction(target, 'paused')
              if (!pauseNoticeSent) {
                const lastHuman = await turnTarget.getTarget()
                const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
                const sessionUrl = currentInfo.url || 'https://jules.google'
                await thread.send(
                  t(threadConfig.messages.session.paused_notice, { url: sessionUrl }),
                )
                pauseNoticeSent = true
              }
            } else if (currentInfo && currentInfo.state !== 'paused' && pauseNoticeSent) {
              pauseNoticeSent = false
            }
          }
        }

        for (const activity of scheduledPoll.value.activities) {
          const id = activity.id
          logger.debug(
            `[runJulesStream] Received activity from stream: ${id} type=${activity.type} originator=${activity.originator}`,
          )
          if (processedActivityIds!.has(id)) {
            logger.debug(`[runJulesStream] Activity ${id} already processed. Skipping.`)
            continue
          }
          operationPhase = 'activity'

          const type = activity.type
          const typeStr = type as string
          let queuedTurnRespondedId: string | undefined
          let queuedTurnCompletion:
            | { reason: any; turnId: string }
            | undefined

          const handlerCtx: ActivityHandlerContext = {
            sessionId,
            session,
            thread,
            streamManager,
            chatbotMode,
            turnTarget,
            stopTyping: () => typingController.stop(),
            turnState,
          }

          switch (type) {
            case 'planGenerated': {
              const res = await handlePlanGenerated(activity, handlerCtx)
              if (res.queuedTurnRespondedId) queuedTurnRespondedId = res.queuedTurnRespondedId
              break
            }
            case 'progressUpdated': {
              await handleProgressUpdated(activity, handlerCtx)
              break
            }
            case 'agentMessaged': {
              const res = await handleAgentMessaged(activity, handlerCtx)
              if (res.queuedTurnRespondedId) queuedTurnRespondedId = res.queuedTurnRespondedId
              if (res.queuedTurnCompletion) queuedTurnCompletion = res.queuedTurnCompletion
              break
            }
            case 'sessionCompleted': {
              const res = await handleSessionCompleted(activity, handlerCtx)
              turnState = res.nextTurnState
              if (res.queuedTurnCompletion) queuedTurnCompletion = res.queuedTurnCompletion
              break
            }
            case 'sessionFailed': {
              await handleSessionFailed(activity, handlerCtx, markActivityProcessed)
              return
            }
            case 'userMessaged': {
              await handleUserMessaged(activity, handlerCtx)
              break
            }
          }

          typingController.handleActivity(typeStr, typingMode)
          turnState = applyActivityToTurnState(turnState, activity)

          await markActivityProcessed(activity)
          if (queuedTurnRespondedId) {
            markConversationTurnResponded(thread.id, queuedTurnRespondedId)
          }
          if (queuedTurnCompletion) {
            completeConversationTurn(
              thread.id,
              queuedTurnCompletion.reason,
              queuedTurnCompletion.turnId,
            )
          }
          operationPhase = 'jules'
        }
      }
    } catch (err: any) {
      const isPermanentError =
        operationPhase === 'jules' &&
        err &&
        (err.status === 404 ||
          err.status === 403 ||
          err.message?.includes('404') ||
          err.message?.includes('403') ||
          err.message?.includes('Not Found') ||
          err.message?.includes('Forbidden'))
      if (isPermanentError) {
        logger.warn(
          `[runJulesStream] Permanent Jules error (${err.status || '404/403'}) for session ${sessionId}. Exiting stream handler permanently.`,
        )
        typingController.stop()
        turnTarget.releaseActiveQueuedTurn('stream_ended')
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (operationPhase === 'jules' && isJulesRateLimitError(err)) {
        const cooldownMs = Math.max(0, activityPollScheduler.getGlobalRateLimitUntil() - Date.now())
        logger.warn(
          `[runJulesStream] Jules API rate-limited thread ${thread.id}; shared polling cooldown is active for about ${Math.ceil(cooldownMs / 1000)}s. The session will stay attached and retry after the global cooldown.`,
        )
        continue
      }

      consecutiveFailures++
      logger.error(
        `[runJulesStream] [Stream Retry ${consecutiveFailures}/${maxRetries}] Error in Jules stream for thread ${thread.id}:`,
        err,
      )

      if (consecutiveFailures >= maxRetries) {
        await thread.send(
          t(getEffectiveConfig(thread).messages.session.analysis_failed_retries, {
            error: formatErrorForDiscord(err),
          }),
        )
        break
      }

      logger.debug(`Reconnecting stream in ${retryDelay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
      retryDelay = Math.min(retryDelay * 1.5, 30000)
    } finally {
      typingController.stop()
    }
  }

  logger.debug(`[runJulesStream] Exited outer while loop for thread ${thread.id}`)
  turnTarget.releaseActiveQueuedTurn('stream_ended')
  teardownStreamState(thread.id, sessionId)
}
