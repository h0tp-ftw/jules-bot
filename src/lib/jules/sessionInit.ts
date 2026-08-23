import { logger } from '../utils/logger.js'
import { ChannelType, EmbedBuilder, Message, TextChannel, ThreadChannel } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import type { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig, yamlConfig } from '../../config.js'
import { t } from '../../strings.js'
import { replenishPool } from './PreWarmedManager.js'
import { resolveMessageEmojis } from '../utils/emojis.js'
import { extractReactionMarkers } from '../utils/reactionMarkers.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { formatAttachmentMetadata } from '../utils/attachments.js'
import { buildReplyAwarePrompt } from '../utils/reply.js'
import { enqueueConversationMessage, markConversationTurnDispatched } from './ConversationQueue.js'
import {
  julesRequestCoordinator as activityPollScheduler,
  scheduleJulesRequest,
} from './JulesRequestCoordinator.js'
import { autoRejectedSessions } from './streamRegistry.js'
import { updateReaction } from './reactions.js'
import { getLastHumanMessage } from './discordHistory.js'
import { getActivityDate } from './deliveryCursor.js'
import { getFreshSessionInfo } from './sessionInfo.js'
import { scheduleNudgeForConversationTurn } from './nudges.js'
import { runJulesStream } from './runJulesStream.js'

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
