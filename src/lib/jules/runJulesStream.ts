import { logger } from '../utils/logger.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Message } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import type { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig, JULES_POLLING } from '../../config.js'
import { t } from '../../strings.js'
import {
  completeConversationTurn,
  getActiveConversationTurn,
  markConversationTurnResponded,
  type ConversationTurnCompletionReason,
} from './ConversationQueue.js'
import {
  applyActivityToTurnState,
  formatCompletionFallback,
  isDiscordUserMessageActivity,
  type TurnResponseState,
} from '../utils/sessionOutcome.js'
import { reactionStageForState, isIdleSessionState } from '../utils/sessionState.js'
import { formatErrorForDiscord } from '../utils/errors.js'
import { resolveMessageEmojis } from '../utils/emojis.js'
import { extractReactionMarkers } from '../utils/reactionMarkers.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { isJulesRateLimitError } from './ActivityPollScheduler.js'
import {
  julesRequestCoordinator as activityPollScheduler,
  scheduleJulesRequest,
} from './JulesRequestCoordinator.js'
import {
  activeStreams,
  autoRejectedSessions,
  processedActivityIdsMap,
  teardownStreamState,
} from './streamRegistry.js'
import { updateReaction, applyJulesReactions } from './reactions.js'
import { getLastHumanMessage } from './discordHistory.js'
import { initializeProcessedActivityIds, persistDeliveredActivity } from './deliveryCursor.js'
import { getFreshSessionInfo, getCompletedSessionResult } from './sessionInfo.js'
import type { JulesDiscordChannel } from './channelTypes.js'

export async function runJulesStream(
  sessionId: string,
  thread: JulesDiscordChannel,
  streamManager: StreamManager,
  initialProcessedIds?: Set<string>,
  // Fired once the processed-activity skip set is populated (history replayed),
  // i.e. when it's safe for a caller to session.send() a follow-up without the
  // new activities being swallowed by history pre-population. Used by
  // messageCreate to gate the send instead of racing a fixed timeout.
  onReady?: () => void,
  options: { chatbotMode?: boolean; sessionFactory?: (sessionId: string) => any } = {},
) {
  const chatbotMode = options.chatbotMode === true
  // Injectable session factory so tests can drive the polling loop with fakes;
  // production always resolves through the shared SDK client.
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

  let typingInterval: NodeJS.Timeout | null = null
  let typingTimeout: NodeJS.Timeout | null = null

  const startTyping = () => {
    if (typingInterval) return
    thread.sendTyping().catch(() => {})
    typingInterval = setInterval(() => {
      thread.sendTyping().catch(() => {})
    }, 8000)

    typingTimeout = setTimeout(
      () => {
        logger.warn(
          `[runJulesStream] Typing indicator timed out after 30 minutes for thread ${thread.id}`,
        )
        stopTyping()
      },
      30 * 60 * 1000,
    )
  }

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval)
      typingInterval = null
    }
    if (typingTimeout) {
      clearTimeout(typingTimeout)
      typingTimeout = null
    }
  }

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
      // Prefer at-least-once delivery if cursor restoration itself fails. This can
      // duplicate an old activity, but it avoids silently losing a new reply.
      logger.error(
        `[runJulesStream] Failed to restore delivery cursor for thread ${thread.id}; falling back to replay:`,
        err,
      )
      processedActivityIds = initialProcessedIds ? new Set(initialProcessedIds) : new Set<string>()
    }
    processedActivityIdsMap.set(thread.id, processedActivityIds)
  }

  // Skip set is ready: any activity produced by a send() issued from here on is
  // guaranteed to be treated as new rather than swallowed as "already seen".
  try {
    onReady?.()
  } catch {
    // A misbehaving ready callback must not take down the stream handler.
  }
  let consecutiveFailures = 0
  const maxRetries = 20
  let retryDelay = 5000
  let operationPhase: 'jules' | 'activity' = 'jules'

  const markActivityProcessed = async (activity: any) => {
    processedActivityIds.add(activity.id)
    await persistDeliveredActivity(thread.id, activity)
    consecutiveFailures = 0
    retryDelay = 5000
  }

  // Keep the response target pinned to the queue turn that produced the current
  // Jules activities. Without this, several rapid Discord messages make a
  // getLastHumanMessage() lookup attach the first reply to the newest message.
  // Newly created sessions can emit an agent reply without replaying their
  // initial user activity, so bind an already-dispatched starter turn up front.
  const initialActiveTurn = getActiveConversationTurn(thread.id)
  const initialQueuedTurn = initialActiveTurn?.dispatchedAt ? initialActiveTurn : undefined
  let currentQueuedTurnId: string | undefined = initialQueuedTurn?.id
  let currentQueuedTarget: Message | null = initialQueuedTurn?.message || null
  let cachedTarget: Message | null = currentQueuedTarget
  let targetFetched = currentQueuedTarget !== null
  let pauseNoticeSent = false
  let emptyPollsWithoutActivity = 0

  const releaseActiveQueuedTurn = (reason: ConversationTurnCompletionReason) => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (activeTurn) completeConversationTurn(thread.id, reason, activeTurn.id)
  }

  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (currentQueuedTurnId && activeTurn?.id === currentQueuedTurnId) {
      currentQueuedTarget = activeTurn.message
    }
    if (currentQueuedTarget) return currentQueuedTarget
    if (!currentQueuedTurnId && activeTurn) return activeTurn.message

    if (forceRefresh || !targetFetched) {
      const fetched = await getLastHumanMessage(thread)
      if (fetched) {
        cachedTarget = fetched
        targetFetched = true
      }
    }
    return cachedTarget
  }

  while (consecutiveFailures < maxRetries) {
    try {
      operationPhase = 'jules'
      if (thread.isThread() && thread.archived) {
        logger.debug(`[runJulesStream] Thread ${thread.id} is archived. Exiting stream handler.`)
        stopTyping()
        releaseActiveQueuedTurn('stream_ended')
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
        stopTyping()
        releaseActiveQueuedTurn('stream_ended')
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (info && info.state === 'failed') {
        logger.debug(`Session ${sessionId} is failed. Exiting stream handler.`)
        stopTyping()
        releaseActiveQueuedTurn('session_failed')
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (isIdleSessionState(info?.state) && !getActiveConversationTurn(thread.id)?.dispatchedAt) {
        activityPollScheduler.markIdle(thread.id, false)
      } else {
        activityPollScheduler.markActive(thread.id)
      }

      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        startTyping()
      } else {
        stopTyping()
      }

      if (info && info.state === 'queued') {
        const targetMessage = await getTarget()
        await updateReaction(targetMessage, 'queued')
      }
      let queuedWaitMs = 0
      const maxQueuedWaitMs = 2 * 60 * 1000 // 2 minutes max
      while (info && info.state === 'queued') {
        if (queuedWaitMs >= maxQueuedWaitMs) {
          logger.error(`Session ${sessionId} stuck in queued state for too long. Aborting.`)
          await thread.send(getEffectiveConfig(thread).messages.session.queued_timeout)
          releaseActiveQueuedTurn('stream_ended')
          teardownStreamState(thread.id, sessionId)
          stopTyping()
          return
        }
        logger.debug(`[runJulesStream] is queued. Waiting ${JULES_POLLING.active_interval_ms}ms...`)
        await new Promise((resolve) => setTimeout(resolve, JULES_POLLING.active_interval_ms))
        queuedWaitMs += JULES_POLLING.active_interval_ms
        info = await activityPollScheduler.request(() => getFreshSessionInfo(session))
      }
      if (isIdleSessionState(info?.state) && !getActiveConversationTurn(thread.id)?.dispatchedAt) {
        activityPollScheduler.markIdle(thread.id, false)
      } else {
        activityPollScheduler.markActive(thread.id)
      }

      const targetMessage = await getTarget()
      // Reflect the *actual* session state on (re)connect instead of always
      // stamping "in_progress". The 20x reconnect logic means the stream can
      // re-subscribe at any point in the lifecycle; unconditionally setting
      // in_progress here would clobber an awaiting-approval or completed reaction
      // every time a transient disconnect happened.
      const reconnectStage = reactionStageForState(info?.state)
      if (reconnectStage) {
        await updateReaction(targetMessage, reconnectStage)
      }
      if (info && info.state === 'paused' && !pauseNoticeSent) {
        const lastHuman = await getTarget()
        const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
        const sessionUrl = info.url || 'https://jules.google'
        await thread.send(t(threadConfig.messages.session.paused_notice, { url: sessionUrl }))
        pauseNoticeSent = true
      }
      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        startTyping()
      }

      // Typing mode is process-level config (loaded at boot, not hot-reloaded),
      // so resolve it once per connect instead of re-resolving for every activity.
      const typingMode = getEffectiveConfig(thread).typing_indicator_mode || 'until_response'

      // The Jules SDK's session.stream() is an infinite 5-second poller and its
      // raw network stream starts listing activities again on every pass. Use the
      // SDK's incremental hydrate() cursor instead, and send every sync through a
      // shared scheduler so all sessions obey one concurrency/rate-limit budget.
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
          stopTyping()
          releaseActiveQueuedTurn('stream_ended')
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
              stopTyping()
              const target = await getTarget()
              await updateReaction(target, 'paused')
              if (!pauseNoticeSent) {
                const lastHuman = await getTarget()
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
          if (processedActivityIds.has(id)) {
            logger.debug(`[runJulesStream] Activity ${id} already processed. Skipping.`)
            continue
          }
          operationPhase = 'activity'

          const type = activity.type
          const typeStr = type as string
          let queuedTurnRespondedId: string | undefined
          let queuedTurnCompletion:
            | { reason: ConversationTurnCompletionReason; turnId: string }
            | undefined

          switch (type) {
            case 'planGenerated': {
              logger.debug(`[runJulesStream] planGenerated for ${sessionId}`)
              activityPollScheduler.markIdle(thread.id)
              const plan = activity.plan || (activity as any).planGenerated?.plan
              if (!plan || !plan.steps) break

              const lastHuman = await getTarget()
              const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
              const autoReject = threadConfig.auto_reject || {}
              const shouldAutoReject =
                chatbotMode || (autoReject.enabled && !autoRejectedSessions.has(sessionId))
              if (shouldAutoReject) {
                if (!chatbotMode) autoRejectedSessions.add(sessionId)
                const feedback = chatbotMode
                  ? threadConfig.messages.prompts.chatbot_mode_plan_feedback
                  : autoReject.message || threadConfig.messages.prompts.auto_reject_default
                if (!chatbotMode) {
                  await thread.send(
                    t(threadConfig.messages.plan.auto_rejected_notice, {
                      emoji: '🤖',
                      feedback,
                    }),
                  )
                }
                await scheduleJulesRequest(() => session.send(feedback))
                activityPollScheduler.markActive(thread.id)
                const target = await getTarget()
                await updateReaction(target, 'in_progress')
                break
              }

              const target = await getTarget()
              await updateReaction(target, 'awaiting_plan_approval')

              const stepsText = plan.steps
                .map((step: any, i: number) =>
                  t(threadConfig.messages.plan.step_line, {
                    number: i + 1,
                    title: step.title,
                  }),
                )
                .join('\n')

              const embed = new EmbedBuilder()
                .setTitle(
                  t(threadConfig.messages.plan.embed_title, {
                    emoji: threadConfig.bot_emoji || '🐙',
                  }),
                )
                .setDescription(
                  stepsText.slice(0, 4000) || threadConfig.messages.plan.embed_no_details,
                )
                .setColor(0x00ae86)

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`plan-approve:${thread.id}`)
                  .setLabel(threadConfig.messages.plan.approve_button)
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`plan-reject:${thread.id}`)
                  .setLabel(threadConfig.messages.plan.reject_button)
                  .setStyle(ButtonStyle.Danger),
              )

              let msg
              if (target && threadConfig.reply_mode !== 'send') {
                const allowedMentions =
                  threadConfig.reply_mode === 'reply_silent' ? { repliedUser: false } : undefined
                msg = await target.reply({
                  embeds: [embed],
                  components: [row],
                  allowedMentions,
                })
              } else {
                msg = await thread.send({
                  embeds: [embed],
                  components: [row],
                })
              }

              await prisma.debugSession.update({
                where: { threadId: thread.id },
                data: { planMessageId: msg.id },
              })
              if (currentQueuedTurnId) queuedTurnRespondedId = currentQueuedTurnId
              break
            }

            case 'progressUpdated': {
              logger.debug(`[runJulesStream] progressUpdated for ${sessionId}`)
              activityPollScheduler.markActive(thread.id)
              // If we were awaiting approval, go back to in_progress on updates
              const target = await getTarget()
              await updateReaction(target, 'in_progress')
              const title = activity.title || (activity as any).progressUpdated?.title || ''
              const description =
                activity.description || (activity as any).progressUpdated?.description || ''
              // Pass title and description separately so StreamManager can render
              // the current step and its description distinctly. Fall back to using
              // the description as the title when no title is present.
              if (!chatbotMode && (title || description)) {
                await streamManager.handleProgress(
                  thread.id,
                  title || description,
                  title ? description || undefined : undefined,
                )
              }
              break
            }

            case 'agentMessaged': {
              logger.debug(`[runJulesStream] agentMessaged for ${sessionId}`)
              activityPollScheduler.markIdle(thread.id)
              const rawMessage = activity.message || (activity as any).agentMessaged?.message || ''
              if (rawMessage) {
                const target = await getTarget()
                const threadConfig = getEffectiveConfig(thread, target?.member)
                // Resolve the toggle with the same (thread + creator-role) context the
                // session prompt was built with, so the parse/strip behavior matches
                // whether Jules was actually told about the marker protocol.
                const reactionsEnabled = threadConfig.jules_reactions?.enabled === true
                const { text: bodyText, emojis } = reactionsEnabled
                  ? extractReactionMarkers(rawMessage)
                  : { text: rawMessage, emojis: [] as string[] }

                // bodyText can be empty when Jules sends only a reaction marker — in
                // that case react without posting an empty message.
                if (bodyText) {
                  const resolved = resolveMessageEmojis(thread.client, bodyText)
                  const splits = splitMessage(resolved, 2000)
                  if (target && threadConfig.reply_mode !== 'send') {
                    const allowedMentions =
                      threadConfig.reply_mode === 'reply_silent'
                        ? { repliedUser: false }
                        : undefined
                    for (let i = 0; i < splits.length; i++) {
                      if (i === 0) {
                        await target.reply({ content: splits[i], allowedMentions })
                      } else {
                        await thread.send(splits[i])
                      }
                    }
                  } else {
                    for (const chunk of splits) {
                      await thread.send(chunk)
                    }
                  }
                }

                // A Jules-authored reaction overrides the state stamp; fall back to
                // the normal "responded" reaction when none was supplied (or none
                // could be applied).
                if (!(emojis.length > 0 && (await applyJulesReactions(target, emojis)))) {
                  await updateReaction(target, 'responded')
                }
              }
              if (currentQueuedTurnId && rawMessage) {
                queuedTurnRespondedId = currentQueuedTurnId
                queuedTurnCompletion = {
                  reason: 'agent_responded',
                  turnId: currentQueuedTurnId,
                }
              }
              break
            }

            case 'sessionCompleted': {
              logger.debug(`[runJulesStream] sessionCompleted for ${sessionId}`)
              activityPollScheduler.markIdle(thread.id)
              const target = await getTarget()
              const outcome = await getCompletedSessionResult(session, sessionId)
              const pullRequestUrl = outcome?.pullRequest?.url

              await updateReaction(target, 'completed')
              await streamManager.finalizeSession(thread.id, true, undefined, { pullRequestUrl })

              if (turnState.awaitingAgentReply) {
                logger.warn(
                  `[runJulesStream] Session ${sessionId} completed without an agent reply for the latest Discord turn; posting a result fallback.`,
                )
                const threadConfig = getEffectiveConfig(thread, target?.member)
                const fallback = formatCompletionFallback(threadConfig.messages, {
                  pullRequestUrl,
                  latestProgress: turnState.latestProgress,
                })
                const splits = splitMessage(fallback, 2000)
                if (target && threadConfig.reply_mode !== 'send') {
                  const allowedMentions =
                    threadConfig.reply_mode === 'reply_silent' ? { repliedUser: false } : undefined
                  for (let i = 0; i < splits.length; i++) {
                    if (i === 0) {
                      await target.reply({ content: splits[i], allowedMentions })
                    } else {
                      await thread.send(splits[i])
                    }
                  }
                } else {
                  for (const chunk of splits) {
                    await thread.send(chunk)
                  }
                }
                turnState = { awaitingAgentReply: false }
              }

              if (currentQueuedTurnId) {
                queuedTurnCompletion = {
                  reason: 'session_completed',
                  turnId: currentQueuedTurnId,
                }
              }

              autoRejectedSessions.delete(sessionId)
              stopTyping()
              break
            }

            case 'sessionFailed': {
              logger.debug(`[runJulesStream] sessionFailed for ${sessionId}`)
              const target = await getTarget()
              await updateReaction(target, 'failed')
              const reason = activity.reason || (activity as any).sessionFailed?.reason || ''
              await streamManager.finalizeSession(thread.id, false, reason)
              await markActivityProcessed(activity)
              if (currentQueuedTurnId) {
                completeConversationTurn(thread.id, 'session_failed', currentQueuedTurnId)
              } else {
                releaseActiveQueuedTurn('session_failed')
              }
              teardownStreamState(thread.id, sessionId)
              stopTyping()
              return
            }

            case 'userMessaged': {
              logger.debug(`[runJulesStream] userMessaged for ${sessionId}`)
              activityPollScheduler.markActive(thread.id)
              if (isDiscordUserMessageActivity(activity)) {
                const activeTurn = getActiveConversationTurn(thread.id)
                currentQueuedTurnId = activeTurn?.id
                currentQueuedTarget = activeTurn?.message || null
                cachedTarget = currentQueuedTarget
                targetFetched = currentQueuedTarget !== null
              }
              // A new human message arrived — refresh the cached reaction/reply target.
              await getTarget(true)
              // Typing indicators handled below.
              break
            }
          }

          // Update typing status based on the (pre-resolved) typing mode.
          if (typingMode === 'strict_state') {
            // Strict state mode: keep typing active during progress updates,
            // and only stop typing when the session is completed or failed.
            if (typeStr === 'userMessaged' || typeStr === 'progressUpdated') {
              startTyping()
            } else if (typeStr === 'sessionCompleted' || typeStr === 'sessionFailed') {
              stopTyping()
            }
          } else {
            // Default mode: until_response
            // Start typing when a user message is sent, stop when agent responds or session ends.
            if (typeStr === 'userMessaged') {
              startTyping()
            } else if (
              typeStr === 'agentMessaged' ||
              typeStr === 'planGenerated' ||
              typeStr === 'sessionCompleted' ||
              typeStr === 'sessionFailed'
            ) {
              stopTyping()
            }
          }

          // Advance the per-turn response state only after all side effects for the
          // activity succeeded. This state is reconstructed from persisted history
          // after restarts, so a terminal event can detect a missing agent reply.
          turnState = applyActivityToTurnState(turnState, activity)

          // Only acknowledge an activity after every Discord/Jules side effect for
          // it succeeds. A failed send therefore remains eligible for replay after
          // the stream reconnects instead of being silently skipped forever.
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
      // Only treat 403/404 errors as permanent while talking to Jules itself.
      // Discord can also return those statuses for a particular message/reply;
      // classifying those as a deleted Jules session used to discard the reply.
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
        stopTyping()
        releaseActiveQueuedTurn('stream_ended')
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
      stopTyping()
    }
  }

  logger.debug(`[runJulesStream] Exited outer while loop for thread ${thread.id}`)
  releaseActiveQueuedTurn('stream_ended')
  teardownStreamState(thread.id, sessionId)
}
