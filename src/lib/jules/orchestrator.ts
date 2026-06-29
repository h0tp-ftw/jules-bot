import { logger } from '../utils/logger.js'
import {
  ThreadChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from 'discord.js'
import { JulesClient } from './JulesClient.js'
import { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig, yamlConfig } from '../../config.js'
import { t } from '../../strings.js'
import { replenishPool } from './PreWarmedManager.js'
import { resolveMessageEmojis } from '../utils/emojis.js'
import { extractReactionMarkers } from '../utils/reactionMarkers.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { formatAttachmentMetadata } from '../utils/attachments.js'
import { reactionStageForState } from '../utils/sessionState.js'
import { formatErrorForDiscord } from '../utils/errors.js'

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

export async function getLastHumanMessage(thread: ThreadChannel): Promise<Message | null> {
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

export async function runJulesStream(
  sessionId: string,
  thread: ThreadChannel,
  streamManager: StreamManager,
  initialProcessedIds?: Set<string>,
  // Fired once the processed-activity skip set is populated (history replayed),
  // i.e. when it's safe for a caller to session.send() a follow-up without the
  // new activities being swallowed by history pre-population. Used by
  // messageCreate to gate the send instead of racing a fixed timeout.
  onReady?: () => void,
) {
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

  let processedActivityIds = processedActivityIdsMap.get(thread.id)
  if (!processedActivityIds) {
    processedActivityIds = initialProcessedIds || new Set<string>()
    processedActivityIdsMap.set(thread.id, processedActivityIds)
    if (!initialProcessedIds) {
      try {
        const session = JulesClient.getSession(sessionId)
        logger.debug(
          `[runJulesStream] Pre-populating processed activities for thread ${thread.id} from history...`,
        )
        for await (const act of session.history()) {
          processedActivityIds.add(act.id)
        }
        logger.debug(`[runJulesStream] Pre-populated ${processedActivityIds.size} activities.`)
      } catch (err) {
        logger.error(`Failed to pre-populate processed activities for thread ${thread.id}:`, err)
      }
    } else {
      logger.debug(
        `[runJulesStream] Using provided initial processed activity IDs (count: ${processedActivityIds.size})`,
      )
    }
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

  // Cache the "last human message" used as the reaction/reply target. Fetching it
  // hits the Discord REST API, so fetch once and only refresh when a new user
  // message arrives (userMessaged) instead of re-fetching on every activity.
  let cachedTarget: Message | null = null
  let targetFetched = false
  const getTarget = async (forceRefresh = false): Promise<Message | null> => {
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
      if (thread.archived) {
        logger.debug(`[runJulesStream] Thread ${thread.id} is archived. Exiting stream handler.`)
        stopTyping()
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
        teardownStreamState(thread.id, sessionId)
        return
      }

      if (info && info.state === 'failed') {
        logger.debug(`Session ${sessionId} is failed. Exiting stream handler.`)
        stopTyping()
        teardownStreamState(thread.id, sessionId)
        return
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

      // Typing mode is process-level config (loaded at boot, not hot-reloaded),
      // so resolve it once per connect instead of re-resolving for every activity.
      const typingMode = getEffectiveConfig(thread).typing_indicator_mode || 'until_response'

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
        processedActivityIds.add(id)
        consecutiveFailures = 0
        retryDelay = 5000

        const type = activity.type
        const typeStr = type as string

        switch (type) {
          case 'planGenerated': {
            logger.debug(`[runJulesStream] planGenerated for ${sessionId}`)
            const plan = activity.plan || (activity as any).planGenerated?.plan
            if (!plan || !plan.steps) break

            const lastHuman = await getTarget()
            const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
            const autoReject = threadConfig.auto_reject || {}
            const shouldAutoReject = autoReject.enabled && !autoRejectedSessions.has(sessionId)
            if (shouldAutoReject) {
              autoRejectedSessions.add(sessionId)
              const feedback =
                autoReject.message || threadConfig.messages.prompts.auto_reject_default
              await thread.send(
                t(threadConfig.messages.plan.auto_rejected_notice, {
                  emoji: '🤖',
                  feedback,
                }),
              )
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

            let msg
            if (target) {
              msg = await target.reply({
                embeds: [embed],
                components: [row],
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
            if (title || description) {
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
            if (rawMessage) {
              const target = await getTarget()
              // Resolve the toggle with the same (thread + creator-role) context the
              // session prompt was built with, so the parse/strip behavior matches
              // whether Jules was actually told about the marker protocol.
              const reactionsEnabled =
                getEffectiveConfig(thread, target?.member).jules_reactions?.enabled === true
              const { text: bodyText, emojis } = reactionsEnabled
                ? extractReactionMarkers(rawMessage)
                : { text: rawMessage, emojis: [] as string[] }

              // bodyText can be empty when Jules sends only a reaction marker — in
              // that case react without posting an empty message.
              if (bodyText) {
                const resolved = resolveMessageEmojis(thread.client, bodyText)
                const splits = splitMessage(resolved, 2000)
                if (target) {
                  for (let i = 0; i < splits.length; i++) {
                    if (i === 0) {
                      await target.reply(splits[i])
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
            break
          }

          case 'sessionCompleted': {
            logger.debug(`[runJulesStream] sessionCompleted for ${sessionId}`)
            const target = await getTarget()
            await updateReaction(target, 'completed')
            await streamManager.finalizeSession(thread.id, true)
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
            teardownStreamState(thread.id, sessionId)
            stopTyping()
            return
          }

          case 'userMessaged': {
            logger.debug(`[runJulesStream] userMessaged for ${sessionId}`)
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
      }

      logger.debug(`[runJulesStream] Stream loop finished for ${sessionId}.`)
      stopTyping()
    } catch (err: any) {
      // Check if error is 404 Not Found or 403 Forbidden (permanent failure)
      const isPermanentError =
        err &&
        (err.status === 404 ||
          err.status === 403 ||
          err.message?.includes('404') ||
          err.message?.includes('403') ||
          err.message?.includes('Not Found') ||
          err.message?.includes('Forbidden'))
      if (isPermanentError) {
        console.log(
          `[runJulesStream] Permanent error (${err.status || '404/403'}) for session ${sessionId}. Exiting stream handler permanently.`,
        )
        stopTyping()
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
    await session.send(promptWithMetadata)

    // Start processing events in the background for prewarmed session after sending the prompt
    runJulesStream(session.id, thread, streamManager, initialSkipIds)

    replenishPool(repoName, contextKey).catch(() => {})
  } else if (usePool) {
    replenishPool(repoName, contextKey).catch(() => {})
  }
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

    for (const session of sessions) {
      try {
        const channel = await client.channels.fetch(session.threadId)
        if (!channel || !channel.isThread()) continue
        const thread = channel as ThreadChannel
        if (thread.archived || thread.locked) {
          logger.debug(
            `[rehydrateActiveStreams] Thread ${thread.id} is archived or locked. Skipping.`,
          )
          continue
        }

        logger.debug(
          `[rehydrateActiveStreams] Rehydrating stream for thread ${thread.id}, sessionId: ${session.julesSessionId}`,
        )
        // runJulesStream checks if it's already active, so this is safe
        runJulesStream(session.julesSessionId, thread, streamManager)

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
