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
import { prisma, getEffectiveConfig, yamlConfig, YAML_GUILDS } from '../../config.js'
import { t } from '../../strings.js'
import { replenishPool } from './PreWarmedManager.js'
import { resolveMessageEmojis } from '../utils/emojis.js'
import { extractReactionMarkers } from '../utils/reactionMarkers.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { formatAttachmentMetadata } from '../utils/attachments.js'
import { reactionStageForState } from '../utils/sessionState.js'
import { formatErrorForDiscord } from '../utils/errors.js'
import { startTypingLoop, stopTypingLoop } from '../utils/typingManager.js'
import { deliverWithReply } from '../utils/replyDelivery.js'
import {
  bindTurnTarget,
  createTurnTargetState,
  isTurnAwaitingReply,
  resolveTurnTarget,
} from '../utils/turnTargets.js'
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

export type JulesDiscordChannel = ThreadChannel | TextChannel

export const activeStreams = new Set<string>()
export const autoRejectedSessions = new Set<string>()
export const processedActivityIdsMap = new Map<string, Set<string>>()
// Tracks the last reaction stage applied to a given message id so updateReaction
// can skip redundant remove/re-add API calls when the stage hasn't changed.
const messageReactionStage = new Map<string, string>()
// Bound for messageReactionStage so a long-lived process doesn't leak one entry
// per message that ever received a reaction. Map preserves insertion order, so we
// evict the oldest key once over the cap.
const MAX_REACTION_STAGE_ENTRIES = 5000
// An activity created at least this long before its handler connected is a
// stale pre-restart backlog item, not part of a turn racing the connect.
const STALE_REPLAY_GRACE_MS = 60 * 1000

// Release all per-thread module state for a stream handler that is exiting for
// good (failed / archived / deleted / retries exhausted). Centralized so every
// exit path cleans up the same sets — previously some paths leaked
// autoRejectedSessions or processedActivityIdsMap. NOTE: a *completed* session
// deliberately does NOT tear down — its stream stays alive to handle follow-ups.
function teardownStreamState(threadId: string, sessionId?: string) {
  activeStreams.delete(threadId)
  processedActivityIdsMap.delete(threadId)
  if (sessionId) autoRejectedSessions.delete(sessionId)
}

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
    const synced = await session.activities.hydrate()
    hydrated = true
    logger.debug(`[runJulesStream] Hydrated ${synced} activities for session ${sessionId}.`)
  } catch (err) {
    logger.warn(`[runJulesStream] Failed to hydrate history for session ${sessionId}:`, err)
  }

  const activities: any[] = []
  try {
    for await (const activity of session.history()) {
      activities.push(activity)
    }
  } catch (err) {
    logger.error(`[runJulesStream] Failed to read history for session ${sessionId}:`, err)
  }

  return { activities, hydrated }
}

async function initializeProcessedActivityIds(
  session: any,
  sessionId: string,
  thread: JulesDiscordChannel,
  initialProcessedIds?: Set<string>,
): Promise<{
  ids: Set<string>
  hydrated: boolean
  turnState: TurnResponseState
  // Every activity id present in history at connect time. Activities in this
  // set but not in `ids` are post-restart recovery replays: they predate any
  // queue turn this process dispatches, so they must never be attributed to
  // (or complete) one.
  historyIds: Set<string>
}> {
  const { activities, hydrated } = await hydrateSessionHistory(session, sessionId)
  const ids = initialProcessedIds ? new Set(initialProcessedIds) : new Set<string>()
  const result = () => ({
    ids,
    hydrated,
    turnState: deriveTurnResponseState(activities, ids),
    historyIds: new Set<string>(activities.map((activity: any) => activity.id)),
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
    return await session.result({ timeoutMs: 15_000 })
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
    // A failed clear/react can leave the message with no reaction at all while
    // the dedup map still records the previous stage — a later update for that
    // same stage would then be skipped forever. Forget the stage so the next
    // attempt always re-applies.
    messageReactionStage.delete(message.id)
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
    if (applied) {
      rememberStage(message.id, `jules:${emojis.join(' ')}`)
    } else {
      // The old reaction was cleared but nothing new stuck; forget the
      // remembered stage so the state-driven fallback re-applies it instead of
      // being deduped away.
      messageReactionStage.delete(message.id)
    }
    return applied
  } catch (err) {
    messageReactionStage.delete(message.id)
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
      await session.send(nudgePrompt)

      if (!channelConfig.nudge.notify_discord) return

      const content = t(discordNotice, {
        delay: formatNudgeDelay(channelConfig.nudge.after_minutes),
      })
      const chunks = splitMessage(content, 2000)
      if (chunks.length === 0) return

      // A starter message for a thread spawned from a text channel lives in
      // the parent channel — replying to it would post the notice there.
      const noticeTarget = turn.message.channelId === channel.id ? turn.message : null
      try {
        await deliverWithReply(channel, noticeTarget, 'reply_silent', { content: chunks[0] })
      } catch (err) {
        logger.warn(`[Nudge] Could not post the Discord nudge notice in ${channel.id}:`, err)
        return
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
  logger.debug(
    `[runJulesStream] Starting stream handler for thread ${thread.id}, sessionId: ${sessionId}`,
  )

  // Typing state is shared per channel via typingManager, so the dispatch path
  // (messageCreate / interactions) and this stream handler drive a single loop
  // instead of racing separate timers that expire at different moments.
  const startTyping = () => startTypingLoop(thread)
  const stopTyping = () => stopTypingLoop(thread.id)

  let historyHydratedForNextStream = false
  let turnState: TurnResponseState = { awaitingAgentReply: false }
  // Activity ids that already existed in history when this handler connected —
  // used to tell post-restart recovery replays apart from live responses.
  // `connectTimeHistoryKnown` records whether the snapshot was actually taken;
  // when cursor restoration fails we fall back to time-only staleness instead
  // of treating the empty set as "nothing is a replay".
  const connectedAtMs = Date.now()
  let connectTimeHistoryIds = new Set<string>()
  let connectTimeHistoryKnown = false
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
      connectTimeHistoryIds = initialized.historyIds
      connectTimeHistoryKnown = true
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

  // A stale replay is a post-restart recovery delivery of an old backlog item:
  // present in the connect-time history snapshot AND created well before this
  // handler connected. The time component matters — a live turn racing the
  // connect (its send() beat the history fetch, e.g. messageCreate's 5s
  // onReady timeout) puts its echo in the snapshot too, but created within
  // seconds of connect, and that echo must stay bindable or the turn could
  // never be attributed. When the snapshot itself failed, judge by time alone
  // rather than treating everything as live.
  const isStaleReplayActivity = (activity: any): boolean => {
    if (connectTimeHistoryKnown && !connectTimeHistoryIds.has(activity.id)) return false
    const createdAt = getActivityDate(activity)
    // No timestamp to judge recency by: trust the snapshot verdict if we have
    // one, otherwise assume live (at-least-once delivery bias).
    if (!createdAt) return connectTimeHistoryKnown
    return createdAt.getTime() < connectedAtMs - STALE_REPLAY_GRACE_MS
  }

  // Keep the response target pinned to the queue turn that produced the current
  // Jules activities. Without this, several rapid Discord messages make a
  // getLastHumanMessage() lookup attach the first reply to the newest message.
  // The binding/rebinding rules live in turnTargets.ts (unit-tested).
  const targetState = createTurnTargetState(getActiveConversationTurn(thread.id))

  const releaseActiveQueuedTurn = (reason: ConversationTurnCompletionReason) => {
    const activeTurn = getActiveConversationTurn(thread.id)
    if (activeTurn) completeConversationTurn(thread.id, reason, activeTurn.id)
  }

  // Used to keep the typing indicator alive on reconnects even when the session
  // state is terminal — follow-ups to a completed session stay in `completed`
  // until Jules starts replying.
  const hasUnansweredDispatchedTurn = () =>
    isTurnAwaitingReply(getActiveConversationTurn(thread.id))

  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
    const resolved = resolveTurnTarget(targetState, getActiveConversationTurn(thread.id))
    if (resolved) return resolved

    if (forceRefresh || !targetState.targetFetched) {
      const fetched = await getLastHumanMessage(thread)
      if (fetched) {
        targetState.cachedTarget = fetched
        targetState.targetFetched = true
      }
    }
    return targetState.cachedTarget
  }

  // Reply only to a message with a real queue *binding* (the turn's echo, the
  // starter binding, or the swallowed-echo recovery) that lives in this
  // channel. Everything weaker — the "latest human message" fetch, the
  // unbound-active-turn guess used for post-restart replays, or a
  // parent-channel starter message (threads spawned from a text channel
  // message — Message#reply posts into the *parent* channel) — is good enough
  // for a status reaction, but a visible Discord reply to it would present the
  // content as answering the wrong message or land it in the wrong channel;
  // those cases fall back to a plain channel send instead.
  const getReplyTarget = (): Message | null => {
    // Refresh the same-turn message reference first.
    resolveTurnTarget(targetState, getActiveConversationTurn(thread.id))
    const bound = targetState.boundTarget
    return bound && bound.channelId === thread.id ? bound : null
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
      let info = await getFreshSessionInfo(session)
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

      // Typing mode is process-level config (loaded at boot, not hot-reloaded),
      // so resolve it once per connect instead of re-resolving for every activity.
      const typingMode = getEffectiveConfig(thread).typing_indicator_mode || 'until_response'

      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        startTyping()
      } else if (typingMode !== 'strict_state' && hasUnansweredDispatchedTurn()) {
        // until_response only: a dispatched Discord message is still waiting on
        // its reply (e.g. a follow-up sent to a completed session), so keep the
        // indicator alive instead of clearing it just because the session state
        // is terminal. strict_state documents typing as mirroring the session
        // state, so there it stops.
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
        logger.debug(`[runJulesStream] is queued. Waiting 5s...`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        queuedWaitMs += 5000
        info = await getFreshSessionInfo(session)
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
      if (
        info &&
        (info.state === 'inProgress' || info.state === 'planning' || info.state === 'queued')
      ) {
        startTyping()
      }

      // stream() replays the SDK's local cache and then switches to future
      // updates. Force a network sync first so replies produced during a bot
      // restart or transient disconnect are present in that replay.
      if (historyHydratedForNextStream) {
        historyHydratedForNextStream = false
      } else {
        const synced = await session.activities.hydrate()
        logger.debug(
          `[runJulesStream] Hydrated ${synced} activities before subscribing to session ${sessionId}.`,
        )
      }

      logger.debug(`[runJulesStream] Subscribing to session stream for ${sessionId}...`)
      for await (const activity of session.stream()) {
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
              await session.send(feedback)
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

            const msg = await deliverWithReply(thread, getReplyTarget(), threadConfig.reply_mode, {
              embeds: [embed],
              components: [row],
            })

            await prisma.debugSession.update({
              where: { threadId: thread.id },
              data: { planMessageId: msg.id },
            })
            if (targetState.boundTurnId) queuedTurnRespondedId = targetState.boundTurnId
            break
          }

          case 'progressUpdated': {
            logger.debug(`[runJulesStream] progressUpdated for ${sessionId}`)
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
            const rawMessage = activity.message || (activity as any).agentMessaged?.message || ''
            // Swallowed-echo recovery: a live agent reply while no turn is
            // bound answers the waiting dispatched turn — without this bind
            // the completion below would no-op and the turn would block the
            // channel queue forever. Connect-time history replays are excluded:
            // they predate every turn this process dispatched (they are
            // post-restart recovery deliveries, not answers to the current
            // turn), so attributing them would falsely complete a fresh turn.
            // Deliberately NOT extended to a *stale* binding (bound turn
            // completed, newer turn dispatched): in that state a trailing
            // activity of the completed turn is indistinguishable from an
            // answer whose echo was swallowed, and guessing wrong would
            // complete the new turn before Jules ever saw it — so the stale
            // case keeps upstream's behavior (completion no-ops until the new
            // turn's own echo binds it).
            if (rawMessage && !targetState.boundTurnId && !isStaleReplayActivity(activity)) {
              const activeTurn = getActiveConversationTurn(thread.id)
              if (activeTurn?.dispatchedAt) bindTurnTarget(targetState, activeTurn)
            }
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
                for (let i = 0; i < splits.length; i++) {
                  if (i === 0) {
                    await deliverWithReply(thread, getReplyTarget(), threadConfig.reply_mode, {
                      content: splits[i],
                    })
                  } else {
                    await thread.send(splits[i])
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
            if (targetState.boundTurnId && rawMessage) {
              queuedTurnRespondedId = targetState.boundTurnId
              queuedTurnCompletion = {
                reason: 'agent_responded',
                turnId: targetState.boundTurnId,
              }
            }
            break
          }

          case 'sessionCompleted': {
            logger.debug(`[runJulesStream] sessionCompleted for ${sessionId}`)
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
              for (let i = 0; i < splits.length; i++) {
                if (i === 0) {
                  await deliverWithReply(thread, getReplyTarget(), threadConfig.reply_mode, {
                    content: splits[i],
                  })
                } else {
                  await thread.send(splits[i])
                }
              }
              turnState = { awaitingAgentReply: false }
            }

            if (targetState.boundTurnId) {
              queuedTurnCompletion = {
                reason: 'session_completed',
                turnId: targetState.boundTurnId,
              }
            } else if (!isStaleReplayActivity(activity)) {
              // No binding to attribute precisely (e.g. the turn's echo never
              // streamed and the session went plan → completion with no agent
              // message): release whatever dispatched turn is active, exactly
              // like sessionFailed does — a live terminal event must never
              // leave the channel queue jammed. Stale replayed completions
              // stay excluded so a pre-restart backlog can't release a fresh
              // turn.
              releaseActiveQueuedTurn('session_completed')
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
            if (targetState.boundTurnId) {
              completeConversationTurn(thread.id, 'session_failed', targetState.boundTurnId)
            } else {
              releaseActiveQueuedTurn('session_failed')
            }
            teardownStreamState(thread.id, sessionId)
            stopTyping()
            return
          }

          case 'userMessaged': {
            logger.debug(`[runJulesStream] userMessaged for ${sessionId}`)
            // Bind only on a *live* echo. A stale replay of an old echo
            // (post-restart recovery of an undelivered backlog) says nothing
            // about the queue turn active now — binding on it would attribute
            // the stale agent reply replayed right after it to the fresh turn,
            // delivering duplicate content onto that message and completing
            // the turn before Jules ever saw it.
            if (isDiscordUserMessageActivity(activity) && !isStaleReplayActivity(activity)) {
              bindTurnTarget(targetState, getActiveConversationTurn(thread.id))
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

      logger.debug(`[runJulesStream] Stream loop finished for ${sessionId}.`)
      stopTyping()
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
        activeStreams.delete(thread.id)
        processedActivityIdsMap.delete(thread.id)
        return
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

  const promptWithMetadata = t(threadConfig.messages.prompts.metadata_header_with_title, {
    nickname: authorNickname,
    username: authorUsername,
    id: authorId,
    time: messageTime,
    title: threadTitle,
    content: starterContent,
  })

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

        const info = await getFreshSessionInfo(session)
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

        // Load history activities for the pre-warmed session to get greeting/plans
        const activities: any[] = []
        try {
          for await (const act of session.history()) {
            activities.push(act)
          }
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
                const replyable = histTarget?.channelId === thread.id ? histTarget : null
                await deliverWithReply(thread, replyable, threadConfig.reply_mode, {
                  embeds: [embed],
                })
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
    session = await JulesClient.createSession({
      prompt: promptWithMetadata,
      repo: repoName,
      branch: branchName,
      title: thread.name,
      thread: thread,
      member: starterMessage.member,
    })
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
    // Sustained loop instead of a one-shot bubble: the stream handler (started
    // below) takes ownership and stops it once Jules visibly responds. In
    // strict_state mode typing mirrors the session state, so the stream's
    // connect-time check drives it instead.
    if (threadConfig.typing_indicator_mode !== 'strict_state') {
      startTypingLoop(thread)
    }

    try {
      if (welcomePlanRejected) {
        // Send rejection separately BEFORE the user prompt
        const rejectionDirective = t(threadConfig.messages.prompts.auto_reject_directive_welcome, {
          feedback: welcomeFeedback,
        })
        logger.debug(
          `[initializeJulesSession] Sending auto-rejection directive for session ${session.id}`,
        )
        await session.send(rejectionDirective)

        // Wait for it to process the rejection so it's ready for the prompt
        logger.debug(
          `[initializeJulesSession] Waiting for session ${session.id} to process rejection...`,
        )
        for (let i = 0; i < 20; i++) {
          const info = await getFreshSessionInfo(session)
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
      await session.send(promptWithMetadata)
    } catch (err) {
      // No stream handler exists yet to own the typing loop; without this stop
      // a failed init would leave the channel "typing" until the 30-minute
      // safety timeout.
      stopTypingLoop(thread.id)
      throw err
    }

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

  const promptWithMetadata = t(channelConfig.messages.prompts.metadata_header_with_channel, {
    nickname: message.member?.displayName || message.author.username,
    username: message.author.username,
    id: message.author.id,
    time: message.createdAt.toISOString(),
    channel: channel.name,
    content: messageContent,
  })

  const session = await JulesClient.createSession({
    prompt: promptWithMetadata,
    repo: repoName,
    branch: branchName,
    title: channel.name,
    thread: channel,
    member: message.member,
  })

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

        const chatbotMode = !sessionChannel.isThread()
        logger.debug(
          `[rehydrateActiveStreams] Rehydrating stream for ${chatbotMode ? 'chatbot channel' : 'thread'} ${sessionChannel.id}, sessionId: ${session.julesSessionId}`,
        )
        // runJulesStream checks if it's already active, so this is safe
        runJulesStream(
          session.julesSessionId,
          sessionChannel,
          streamManager,
          undefined,
          undefined,
          { chatbotMode },
        )

        // Wait 1.5 seconds between rehydrations to avoid hitting Jules API rate limits
        await new Promise((resolve) => setTimeout(resolve, 1500))
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
