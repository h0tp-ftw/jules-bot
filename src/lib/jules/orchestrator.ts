import { logger } from '../utils/logger.js'
import type { Outcome } from '@google/jules-sdk'
import {
  ThreadChannel,
  TextChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from 'discord.js'
import { JulesClient } from './JulesClient.js'
import { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig, yamlConfig, YAML_GUILDS, JULES_POLLING } from '../../config.js'
import { t } from '../../strings.js'
import { replenishPool } from './PreWarmedManager.js'
import { resolveMessageEmojis } from '../utils/emojis.js'
import { extractReactionMarkers } from '../utils/reactionMarkers.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { formatAttachmentMetadata } from '../utils/attachments.js'
import { buildReplyAwarePrompt } from '../utils/reply.js'
import { reactionStageForState } from '../utils/sessionState.js'
import { formatErrorForDiscord } from '../utils/errors.js'
import {
  completeConversationTurn,
  enqueueConversationMessage,
  getActiveConversationTurn,
  markConversationTurnDispatched,
  markConversationTurnResponded,
  scheduleConversationNudge,
  type ConversationTurnCompletionReason,
} from './ConversationQueue.js'
import {
  applyActivityToTurnState,
  deriveTurnResponseState,
  formatCompletionFallback,
  isDiscordUserMessageActivity,
  type TurnResponseState,
} from '../utils/sessionOutcome.js'
import { isJulesRateLimitError } from './ActivityPollScheduler.js'
import {
  julesRequestCoordinator as activityPollScheduler,
  scheduleJulesRequest,
} from './JulesRequestCoordinator.js'

export type JulesDiscordChannel = ThreadChannel | TextChannel

import {
  activeStreams,
  autoRejectedSessions,
  processedActivityIdsMap,
  teardownStreamState,
  wakeJulesStream,
} from './streamRegistry.js'

export { scheduleJulesRequest }
export { activeStreams, autoRejectedSessions, processedActivityIdsMap, wakeJulesStream }

function isIdleSessionState(state?: string): boolean {
  return (
    state === 'awaitingPlanApproval' ||
    state === 'awaitingUserFeedback' ||
    state === 'paused' ||
    state === 'completed'
  )
}
// Tracks the last reaction stage applied to a given message id so updateReaction
// can skip redundant remove/re-add API calls when the stage hasn't changed.
const messageReactionStage = new Map<string, string>()
// Bound for messageReactionStage so a long-lived process doesn't leak one entry
// per message that ever received a reaction. Map preserves insertion order, so we
// evict the oldest key once over the cap.
const MAX_REACTION_STAGE_ENTRIES = 5000

function parseEmojiForReaction(client: any, emojiStr: string): string {
  const trimmed = emojiStr.trim()
  // Match <:name:id> or <a:name:id>
  const match = trimmed.match(/^<a?:([a-zA-Z0-9_]+):([0-9]+)>$/)
  if (match) {
    return `${match[1]}:${match[2]}`
  }

  // Match raw name:id
  const rawMatch = trimmed.match(/^([a-zA-Z0-9_]+):([0-9]+)$/)
  if (rawMatch) {
    return trimmed
  }

  // Match raw ID
  if (/^[0-9]+$/.test(trimmed)) {
    const cachedEmoji = client.emojis.cache.get(trimmed)
    if (cachedEmoji) {
      return `${cachedEmoji.name}:${cachedEmoji.id}`
    }
    return trimmed
  }

  return trimmed
}

export async function getLastHumanMessage(thread: JulesDiscordChannel): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 20 })
    const sorted = Array.from(messages.values()).sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    )
    const lastHuman = sorted.find((m) => !m.author.bot)
    return lastHuman || null
  } catch (err) {
    logger.error('Failed to fetch last human message for reply:', err)
    return null
  }
}

function getActivityDate(activity: any): Date | null {
  if (!activity?.createTime) return null
  const date = new Date(activity.createTime)
  return Number.isNaN(date.getTime()) ? null : date
}

async function getLatestBotMessageTimestamp(thread: JulesDiscordChannel): Promise<number | null> {
  const botId = thread.client.user?.id
  if (!botId) return null

  try {
    const messages = await thread.messages.fetch({ limit: 100 })
    let latest: number | null = null
    for (const message of messages.values()) {
      if (message.author.id !== botId) continue
      if (latest === null || message.createdTimestamp > latest) {
        latest = message.createdTimestamp
      }
    }
    return latest
  } catch (err) {
    logger.warn(
      `[runJulesStream] Could not inspect recent Discord messages for legacy delivery recovery in thread ${thread.id}:`,
      err,
    )
    return null
  }
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

async function initializeProcessedActivityIds(
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

async function persistDeliveredActivity(threadId: string, activity: any) {
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

async function getCompletedSessionResult(session: any, sessionId: string): Promise<Outcome | null> {
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

// Remove every reaction this bot previously added to `message`. Shared by the
// state-driven updateReaction and the Jules-driven applyJulesReactions so a new
// reaction set always cleanly replaces the old one.
async function clearBotReactions(message: Message) {
  const botId = message.client.user?.id
  if (!botId) return
  for (const reaction of message.reactions.cache.values()) {
    try {
      if (reaction.me) {
        await reaction.users.remove(botId)
      }
    } catch (err) {
      // Ignore removal errors
    }
  }
}

// Record the reaction stage currently shown on a message (for dedup), evicting
// the oldest entry once over the cap so a long-lived process doesn't leak.
function rememberStage(messageId: string, stage: string) {
  messageReactionStage.set(messageId, stage)
  if (messageReactionStage.size > MAX_REACTION_STAGE_ENTRIES) {
    const oldest = messageReactionStage.keys().next().value
    if (oldest !== undefined) messageReactionStage.delete(oldest)
  }
}

export async function updateReaction(message: Message | null, newStage: string) {
  if (!message) return
  // Skip redundant work if this message is already showing the target stage.
  if (messageReactionStage.get(message.id) === newStage) return
  try {
    // Remove any existing bot reactions to clean up previous stages
    await clearBotReactions(message)

    // Add new reaction emoji
    const threadConfig = getEffectiveConfig(message.channel, message.member)
    const reactions = threadConfig.reactions || {}
    const emojiStr = reactions[newStage]
    if (emojiStr) {
      const emoji = parseEmojiForReaction(message.client, emojiStr)
      await message.react(emoji)
    }
    rememberStage(message.id, newStage)
  } catch (err) {
    logger.error(`Failed to update reaction to stage ${newStage}:`, err)
  }
}

// Apply Jules-authored reactions (parsed from [[react:…]] markers in an agent
// message) to `message`, replacing any state-driven reaction. Records a sentinel
// stage so a later lifecycle transition (completed/failed/in_progress) still
// overrides it. Each emoji is resolved through the same shortcode/custom-emoji
// pipeline as agent message text before being handed to message.react().
export async function applyJulesReactions(
  message: Message | null,
  emojis: string[],
): Promise<boolean> {
  if (!message || emojis.length === 0) return false
  try {
    await clearBotReactions(message)
    let applied = false
    for (const raw of emojis) {
      try {
        const resolved = resolveMessageEmojis(message.client, raw)
        const emoji = parseEmojiForReaction(message.client, resolved)
        await message.react(emoji)
        applied = true
      } catch (err) {
        logger.warn(`[applyJulesReactions] Could not react with "${raw}":`, err)
      }
    }
    if (applied) rememberStage(message.id, `jules:${emojis.join(' ')}`)
    return applied
  } catch (err) {
    logger.error('[applyJulesReactions] Failed to apply Jules reactions:', err)
    return false
  }
}

export async function getFreshSessionInfo(session: any): Promise<any> {
  try {
    if (session && session.sessionStorage && typeof session.sessionStorage.delete === 'function') {
      await session.sessionStorage.delete(session.id)
    }
  } catch (err) {
    logger.error(`[getFreshSessionInfo] Failed to delete cache for session ${session?.id}:`, err)
  }
  return await session.info()
}

function formatNudgeDelay(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

export function scheduleNudgeForConversationTurn(
  channel: JulesDiscordChannel,
  turnId: string,
  session: any,
  member?: any,
  dbDefaultRepo?: string,
): boolean {
  const channelConfig = getEffectiveConfig(channel, member, dbDefaultRepo)
  if (!channelConfig.nudge.enabled) return false

  const delayMs = channelConfig.nudge.after_minutes * 60 * 1000
  const nudgePrompt = channelConfig.nudge.message || channelConfig.messages.prompts.response_nudge
  const discordNotice =
    channelConfig.nudge.discord_message || channelConfig.messages.session.nudge_sent

  return scheduleConversationNudge(
    channel.id,
    delayMs,
    async (turn) => {
      logger.info(
        `[Nudge] Sending response reminder for Discord message ${turn.message.id} to Jules session ${session.id}`,
      )
      await scheduleJulesRequest(() => session.send(nudgePrompt))
      wakeJulesStream(channel.id)

      if (!channelConfig.nudge.notify_discord) return

      const content = t(discordNotice, {
        delay: formatNudgeDelay(channelConfig.nudge.after_minutes),
      })
      const chunks = splitMessage(content, 2000)
      if (chunks.length === 0) return

      try {
        await turn.message.reply({
          content: chunks[0],
          allowedMentions: { repliedUser: false },
        })
      } catch (err) {
        logger.warn(
          `[Nudge] Could not reply to Discord message ${turn.message.id}; sending notice in channel instead:`,
          err,
        )
        try {
          await channel.send(chunks[0])
        } catch (sendErr) {
          logger.warn(`[Nudge] Could not post the Discord nudge notice in ${channel.id}:`, sendErr)
          return
        }
      }

      for (const chunk of chunks.slice(1)) {
        try {
          await channel.send(chunk)
        } catch (err) {
          logger.warn(`[Nudge] Could not post a Discord nudge notice continuation:`, err)
          break
        }
      }
    },
    turnId,
  )
}

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
  options: { chatbotMode?: boolean } = {},
) {
  const chatbotMode = options.chatbotMode === true

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
      const session = JulesClient.getSession(sessionId)
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
      const session = JulesClient.getSession(sessionId)
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

export async function initializeJulesSession(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
) {
  const starterMessage = await thread.fetchStarterMessage()
  if (!starterMessage || (!starterMessage.content && starterMessage.attachments.size === 0)) {
    await thread.send(getEffectiveConfig(thread).messages.session.starter_message_unavailable)
    return
  }

  let resolveInitialized: () => void = () => {}
  let rejectInitialized: (error: unknown) => void = () => {}
  const initialized = new Promise<void>((resolve, reject) => {
    resolveInitialized = resolve
    rejectInitialized = reject
  })

  const completion = enqueueConversationMessage(
    thread.id,
    starterMessage,
    async (turn) => {
      try {
        await initializeJulesSessionCore(
          thread,
          repoName,
          branchName,
          streamManager,
          starterMessage,
          turn.id,
        )
        resolveInitialized()
        return true
      } catch (err) {
        rejectInitialized(err)
        throw err
      }
    },
    () => updateReaction(starterMessage, 'queued'),
  )
  void completion.catch((err) => {
    logger.error(`[initializeJulesSession] Queued starter turn failed for ${thread.id}:`, err)
  })

  await initialized
}

async function initializeJulesSessionCore(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
  starterMessage: Message,
  queueTurnId: string,
) {
  const authorNickname = starterMessage.member?.displayName || starterMessage.author.username
  const authorUsername = starterMessage.author.username
  const authorId = starterMessage.author.id
  const messageTime = starterMessage.createdAt.toISOString()
  const threadTitle = thread.name

  const threadConfig = getEffectiveConfig(thread, starterMessage.member)

  let starterContent = starterMessage.content || ''
  if (starterMessage.attachments.size > 0) {
    const attachmentList = Array.from(starterMessage.attachments.values()).map((att) => ({
      name: att.name,
      url: att.url,
      contentType: att.contentType || undefined,
      size: att.size || undefined,
    }))

    starterContent += formatAttachmentMetadata(attachmentList, threadConfig.messages.attachments)
  }

  const promptWithMetadata = await buildReplyAwarePrompt(
    starterMessage,
    threadConfig.reply_context_mode,
    threadConfig.messages.prompts.metadata_header_with_title,
    {
      nickname: authorNickname,
      username: authorUsername,
      id: authorId,
      message_id: starterMessage.id,
      time: messageTime,
      title: threadTitle,
      content: starterContent,
    },
    threadConfig.messages.prompts,
  )

  let session: any = null
  let usedPreWarmed = false
  let initialSkipIds: Set<string> | undefined
  let initialCursorActivity: any = null
  let welcomePlanRejected = false
  let welcomeFeedback = ''

  // Determine matching contextKey and pool eligibility
  let contextKey: string | null = null
  let usePool = false

  const channelsConfig = yamlConfig.channels || {}
  const rolesConfig = yamlConfig.roles || {}

  if (
    thread.id &&
    channelsConfig[thread.id] &&
    channelsConfig[thread.id].pre_warmed_sessions?.enabled
  ) {
    contextKey = thread.id
    usePool = true
  } else if (
    thread.parentId &&
    channelsConfig[thread.parentId] &&
    channelsConfig[thread.parentId].pre_warmed_sessions?.enabled
  ) {
    contextKey = thread.parentId
    usePool = true
  } else {
    // Check roles
    if (starterMessage.member && starterMessage.member.roles) {
      for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
        let hasRole = false
        const roles = starterMessage.member.roles as any
        if (roles && roles.cache) {
          hasRole = roles.cache.has(roleKey) || roles.cache.some((r: any) => r.name === roleKey)
        } else if (Array.isArray(roles)) {
          hasRole = roles.includes(roleKey)
        }
        if (
          hasRole &&
          roleVal &&
          typeof roleVal === 'object' &&
          (roleVal as any).pre_warmed_sessions?.enabled
        ) {
          contextKey = roleKey
          usePool = true
          break
        }
      }
    }
  }

  if (!usePool) {
    // Check if global pool is enabled and prompts are NOT overridden
    const globalConfig = getEffectiveConfig()
    const isPromptOverridden =
      threadConfig.diagnostic_prompt !== globalConfig.diagnostic_prompt ||
      threadConfig.agents_personality !== globalConfig.agents_personality ||
      threadConfig.soul_personality !== globalConfig.soul_personality

    if (threadConfig.pre_warmed_sessions.enabled && !isPromptOverridden) {
      contextKey = null
      usePool = true
    }
  }

  // Pre-warmed sessions are currently only created for the default branch (usually 'main')
  const isDefaultBranch = branchName === (threadConfig.default_branch || 'main')

  if (usePool && isDefaultBranch) {
    let preWarmed = await prisma.preWarmedSession.findFirst({
      where: { repoName, ready: true, contextKey },
      orderBy: { createdAt: 'asc' },
    })

    if (!preWarmed) {
      const warming = await prisma.preWarmedSession.findFirst({
        where: { repoName, ready: false, contextKey },
        orderBy: { createdAt: 'asc' },
      })
      if (warming) {
        const statusMsg = await thread.send(threadConfig.messages.session.prewarming_wait)
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
          const check = await prisma.preWarmedSession.findUnique({
            where: { id: warming.id },
          })
          if (check && check.ready) {
            preWarmed = check
            break
          }
        }
        await statusMsg.delete().catch(() => {})
      }
    }

    if (preWarmed) {
      try {
        session = JulesClient.getSession(preWarmed.id)

        const info = await activityPollScheduler.request(() => getFreshSessionInfo(session))
        logger.debug(
          `[initializeJulesSession] Session ${session.id} state at consumption: ${info.state}`,
        )

        if (info && (info.state === 'failed' || info.state === 'completed')) {
          logger.warn(
            `[initializeJulesSession] Session ${session.id} is in ${info.state} state. Discarding and creating new session.`,
          )
          await prisma.preWarmedSession.delete({ where: { id: preWarmed.id } })
          throw new Error(`Pre-warmed session ${session.id} is in ${info.state} state`)
        }

        // Load history activities for the pre-warmed session to get greeting/plans.
        // Sync once through the shared Jules request budget, then read locally.
        let activities: any[] = []
        try {
          await activityPollScheduler.request(() => session.activities.hydrate())
          activities = await session.activities.select({ order: 'asc' })
        } catch (histErr) {
          logger.error(
            `[initializeJulesSession] Failed to fetch history for pre-warmed session ${session.id}:`,
            histErr,
          )
        }

        // If auto-reject is enabled, we check if there's any active plan to reject
        if (threadConfig.auto_reject?.enabled) {
          const hasActivePlan = !!(info as any).plan
          const hasPlanInHistory = activities.some((a: any) => a.type === 'planGenerated')

          if (hasActivePlan || hasPlanInHistory || info.state === 'awaitingPlanApproval') {
            logger.debug(
              `[initializeJulesSession] Plan detected for session ${session.id} (Active: ${hasActivePlan}, History: ${hasPlanInHistory}, State: ${info.state}). Marking for rejection.`,
            )
            welcomePlanRejected = true
            welcomeFeedback =
              threadConfig.auto_reject?.message || threadConfig.messages.prompts.auto_reject_default
          }
        }

        if (activities.length > 0) {
          logger.debug(
            `[initializeJulesSession] Session ${session.id} has ${activities.length} activities.`,
          )
          initialSkipIds = new Set(activities.map((a: any) => a.id))
          initialCursorActivity = activities[activities.length - 1]
          for (const activity of activities) {
            logger.debug(`[initializeJulesSession] Activity Type: ${activity.type}`)
            if (activity.type === 'agentMessaged') {
              const rawMessage = activity.message || (activity as any).agentMessaged?.message || ''
              // Strip any reaction markers from replayed messages so they never
              // render literally. Replay doesn't re-apply the reactions themselves.
              const body = threadConfig.jules_reactions?.enabled
                ? extractReactionMarkers(rawMessage).text
                : rawMessage
              if (body) {
                const resolved = resolveMessageEmojis(thread.client, body)
                const splits = splitMessage(resolved, 2000)
                for (const chunk of splits) {
                  await thread.send(chunk)
                }
              }
            } else if (activity.type === 'planGenerated') {
              const plan = activity.plan || (activity as any).planGenerated?.plan
              if (plan && plan.steps) {
                logger.debug(
                  `[initializeJulesSession] Rendering plan from history for session ${session.id}`,
                )
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
                  .setFooter({ text: threadConfig.messages.plan.welcome_footer })

                const histTarget = await getLastHumanMessage(thread)
                if (histTarget) {
                  await histTarget.reply({ embeds: [embed] })
                } else {
                  await thread.send({ embeds: [embed] })
                }
              }
            }
          }
        }

        if (welcomePlanRejected) {
          autoRejectedSessions.add(session.id)
          const botEmoji = threadConfig.bot_emoji || '🐙'
          logger.debug(
            `[initializeJulesSession] Automatically rejecting welcome plan for pre-warmed session ${session.id}`,
          )
          await thread.send(
            t(threadConfig.messages.plan.auto_rejected_notice, {
              emoji: botEmoji,
              feedback: welcomeFeedback,
            }),
          )
        }

        await prisma.preWarmedSession.delete({
          where: { id: preWarmed.id },
        })

        usedPreWarmed = true
        logger.debug(
          `[initializeJulesSession] Consumed pre-warmed session ${session.id} for repo ${repoName} (Context: ${contextKey || 'global'})`,
        )
      } catch (err) {
        logger.error(
          `[initializeJulesSession] Failed to rehydrate pre-warmed session ${preWarmed.id}:`,
          err,
        )
        session = null
      }
    }
  }

  if (!session) {
    markConversationTurnDispatched(thread.id, queueTurnId)
    session = await scheduleJulesRequest(() =>
      JulesClient.createSession({
        prompt: promptWithMetadata,
        repo: repoName,
        branch: branchName,
        title: thread.name,
        thread: thread,
        member: starterMessage.member,
      }),
    )
  }

  await prisma.debugSession.create({
    data: {
      threadId: thread.id,
      guildId: thread.guildId,
      julesSessionId: session.id,
      repoName: repoName,
      deliveryCursorInitialized: true,
      lastDeliveredActivityId: initialCursorActivity?.id || null,
      lastDeliveredActivityAt: getActivityDate(initialCursorActivity),
    },
  })

  // Ensure autoRejectedSessions entry persists if we rejected a plan during initialization,
  // so runJulesStream doesn't try to reject the SAME plan again.
  // We will only delete it AFTER the user prompt is sent and we want to allow a NEW rejection.

  // Start processing events in the background
  if (!usedPreWarmed) {
    runJulesStream(session.id, thread, streamManager, initialSkipIds)
  }

  if (usedPreWarmed) {
    await thread.send(threadConfig.messages.session.prewarmed_ready)
    thread.sendTyping().catch(() => {})

    if (welcomePlanRejected) {
      // Send rejection separately BEFORE the user prompt
      const rejectionDirective = t(threadConfig.messages.prompts.auto_reject_directive_welcome, {
        feedback: welcomeFeedback,
      })
      logger.debug(
        `[initializeJulesSession] Sending auto-rejection directive for session ${session.id}`,
      )
      await scheduleJulesRequest(() => session.send(rejectionDirective))

      // Wait for it to process the rejection so it's ready for the prompt
      logger.debug(
        `[initializeJulesSession] Waiting for session ${session.id} to process rejection...`,
      )
      for (let i = 0; i < 20; i++) {
        const info = await scheduleJulesRequest(() => getFreshSessionInfo(session))
        if (info.state !== 'queued') {
          logger.debug(
            `[initializeJulesSession] Session ${session.id} finished processing rejection (State: ${info.state})`,
          )
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      // Briefly wait for any immediate follow-up activities to settle
      await new Promise((r) => setTimeout(r, 2000))

      // Now that we've rejected the welcome plan, we clear the set so that the
      // FIRST plan for the ACTUAL prompt can also be rejected.
      autoRejectedSessions.delete(session.id)
    }

    logger.debug(`[initializeJulesSession] Sending user prompt to session ${session.id}`)
    markConversationTurnDispatched(thread.id, queueTurnId)
    await scheduleJulesRequest(() => session.send(promptWithMetadata))

    // Start processing events in the background for prewarmed session after sending the prompt
    runJulesStream(session.id, thread, streamManager, initialSkipIds)

    replenishPool(repoName, contextKey).catch(() => {})
  } else if (usePool) {
    replenishPool(repoName, contextKey).catch(() => {})
  }

  scheduleNudgeForConversationTurn(thread, queueTurnId, session, starterMessage.member, repoName)
}

export async function initializeChatSession(
  message: Message,
  repoName: string,
  branchName: string,
  streamManager: StreamManager,
) {
  if (!message.guildId || message.channel.type !== ChannelType.GuildText) {
    throw new Error('Chat sessions can only be initialized from a normal guild text channel.')
  }

  const channel = message.channel as TextChannel
  const channelConfig = getEffectiveConfig(channel, message.member, repoName)

  let messageContent = message.content || ''
  if (message.attachments.size > 0) {
    const attachmentList = Array.from(message.attachments.values()).map((att) => ({
      name: att.name,
      url: att.url,
      contentType: att.contentType || undefined,
      size: att.size || undefined,
    }))
    messageContent += formatAttachmentMetadata(attachmentList, channelConfig.messages.attachments)
  }

  const promptWithMetadata = await buildReplyAwarePrompt(
    message,
    channelConfig.reply_context_mode,
    channelConfig.messages.prompts.metadata_header_with_channel,
    {
      nickname: message.member?.displayName || message.author.username,
      username: message.author.username,
      id: message.author.id,
      message_id: message.id,
      time: message.createdAt.toISOString(),
      channel: channel.name,
      content: messageContent,
    },
    channelConfig.messages.prompts,
  )

  const session = await scheduleJulesRequest(() =>
    JulesClient.createSession({
      prompt: promptWithMetadata,
      repo: repoName,
      branch: branchName,
      title: channel.name,
      thread: channel,
      member: message.member,
    }),
  )

  await prisma.debugSession.create({
    data: {
      threadId: channel.id,
      guildId: message.guildId,
      julesSessionId: session.id,
      repoName,
      deliveryCursorInitialized: true,
    },
  })

  void runJulesStream(session.id, channel, streamManager, undefined, undefined, {
    chatbotMode: true,
  }).catch((err) => {
    logger.error(
      `[initializeChatSession] Stream failed for chatbot channel ${channel.id}, session ${session.id}:`,
      err,
    )
  })

  return session
}

export async function rehydrateActiveStreams(client: any, streamManager: StreamManager) {
  logger.debug('[rehydrateActiveStreams] Starting rehydration of active streams...')
  try {
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    const sessions = await prisma.debugSession.findMany({
      where: {
        updatedAt: { gte: oneDayAgo },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    })

    logger.debug(
      `[rehydrateActiveStreams] Found ${sessions.length} sessions in DB updated in the last 24 hours.`,
    )

    const guildConfigs = await prisma.guildConfig.findMany({
      select: { guildId: true, chatChannelId: true },
    })
    const guildConfigById = new Map(guildConfigs.map((config) => [config.guildId, config]))
    const idleCutoffMs = Date.now() - JULES_POLLING.idle_timeout_ms

    for (const session of sessions) {
      try {
        const channel = await client.channels.fetch(session.threadId)
        if (!channel || (!channel.isThread() && channel.type !== ChannelType.GuildText)) continue
        const sessionChannel = channel as JulesDiscordChannel
        if (!sessionChannel.isThread()) {
          const configuredChatChannelId =
            YAML_GUILDS[session.guildId]?.chat_channel_id ||
            guildConfigById.get(session.guildId)?.chatChannelId
          if (configuredChatChannelId !== sessionChannel.id) {
            logger.debug(
              `[rehydrateActiveStreams] Text channel ${sessionChannel.id} is no longer the configured chatbot channel for guild ${session.guildId}. Skipping.`,
            )
            continue
          }
        }
        if (sessionChannel.isThread() && (sessionChannel.archived || sessionChannel.locked)) {
          logger.debug(
            `[rehydrateActiveStreams] Thread ${sessionChannel.id} is archived or locked. Skipping.`,
          )
          continue
        }

        // Do not grant every old completed session a fresh one-hour polling window
        // just because the bot restarted. For records older than the idle grace
        // period, spend one paced info request to keep only genuinely active work.
        if (session.updatedAt.getTime() < idleCutoffMs) {
          const remoteSession = JulesClient.getSession(session.julesSessionId)
          const info = await scheduleJulesRequest(() => getFreshSessionInfo(remoteSession))
          if (!info || info.state === 'failed' || isIdleSessionState(info.state)) {
            logger.debug(
              `[rehydrateActiveStreams] Session ${session.julesSessionId} is stale and ${info?.state || 'unavailable'}; leaving it dormant until the next Discord action.`,
            )
            continue
          }
        }

        const chatbotMode = !sessionChannel.isThread()
        logger.debug(
          `[rehydrateActiveStreams] Rehydrating stream for ${chatbotMode ? 'chatbot channel' : 'thread'} ${sessionChannel.id}, sessionId: ${session.julesSessionId}`,
        )
        // runJulesStream checks if it's already active. Its initialization and all
        // Jules network calls are paced by the shared scheduler, so startup no
        // longer needs a separate fixed inter-session sleep.
        void runJulesStream(
          session.julesSessionId,
          sessionChannel,
          streamManager,
          undefined,
          undefined,
          { chatbotMode },
        ).catch((err) => {
          logger.error(
            `[rehydrateActiveStreams] Stream failed for session ${session.julesSessionId} in ${sessionChannel.id}:`,
            err,
          )
        })
      } catch (err) {
        logger.error(
          `[rehydrateActiveStreams] Failed to rehydrate session ${session.julesSessionId} for thread ${session.threadId}:`,
          err,
        )
      }
    }
  } catch (err) {
    logger.error('[rehydrateActiveStreams] Failed to query active sessions from database:', err)
  }
}
