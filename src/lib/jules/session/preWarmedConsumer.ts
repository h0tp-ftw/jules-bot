import { logger } from '../../utils/logger.js'
import { EmbedBuilder, Message, ThreadChannel } from 'discord.js'
import { JulesClient } from '../JulesClient.js'
import { prisma, getEffectiveConfig, yamlConfig } from '../../../config.js'
import { t } from '../../../strings.js'
import { resolveMessageEmojis } from '../../utils/emojis.js'
import { extractReactionMarkers } from '../../utils/reactionMarkers.js'
import { splitMessage } from '../../utils/messageSplitter.js'
import { markConversationTurnDispatched } from '../ConversationQueue.js'
import {
  julesRequestCoordinator as activityPollScheduler,
  scheduleJulesRequest,
} from '../JulesRequestCoordinator.js'
import { autoRejectedSessions } from '../streamRegistry.js'
import { getLastHumanMessage } from '../discordHistory.js'
import { getFreshSessionInfo } from '../sessionInfo.js'

export type PreWarmedConsumptionResult = {
  session: any
  contextKey: string | null
  initialSkipIds: Set<string> | undefined
  initialCursorActivity: any
  welcomePlanRejected: boolean
  welcomeFeedback: string
}

export function resolvePoolContext(
  thread: ThreadChannel,
  starterMember: any,
  branchName: string,
  threadConfig: any,
): { contextKey: string | null; usePool: boolean } {
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
  } else if (starterMember && starterMember.roles) {
    for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
      let hasRole = false
      const roles = starterMember.roles as any
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

  if (!usePool) {
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

  const isDefaultBranch = branchName === (threadConfig.default_branch || 'main')
  return { contextKey, usePool: usePool && isDefaultBranch }
}

async function fetchOrWaitForPreWarmedSession(
  repoName: string,
  contextKey: string | null,
  thread: ThreadChannel,
  threadConfig: any,
) {
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

  return preWarmed
}

async function replayHistoryActivities(session: any, thread: ThreadChannel, threadConfig: any) {
  let activities: any[] = []
  try {
    await activityPollScheduler.request(() => session.activities.hydrate())
    activities = await session.activities.select({ order: 'asc' })
  } catch (histErr) {
    logger.error(
      `[preWarmedConsumer] Failed to fetch history for pre-warmed session ${session.id}:`,
      histErr,
    )
  }

  if (activities.length > 0) {
    logger.debug(`[preWarmedConsumer] Session ${session.id} has ${activities.length} activities.`)
    for (const activity of activities) {
      logger.debug(`[preWarmedConsumer] Activity Type: ${activity.type}`)
      if (activity.type === 'agentMessaged') {
        const rawMessage = activity.message || (activity as any).agentMessaged?.message || ''
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
            `[preWarmedConsumer] Rendering plan from history for session ${session.id}`,
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

  return activities
}

export async function consumePreWarmedSession(
  repoName: string,
  contextKey: string | null,
  thread: ThreadChannel,
  threadConfig: any,
): Promise<PreWarmedConsumptionResult | null> {
  const preWarmed = await fetchOrWaitForPreWarmedSession(
    repoName,
    contextKey,
    thread,
    threadConfig,
  )
  if (!preWarmed) return null

  try {
    const session = JulesClient.getSession(preWarmed.id)
    const info = await activityPollScheduler.request(() => getFreshSessionInfo(session))
    logger.debug(`[preWarmedConsumer] Session ${session.id} state at consumption: ${info.state}`)

    if (info && (info.state === 'failed' || info.state === 'completed')) {
      logger.warn(
        `[preWarmedConsumer] Session ${session.id} is in ${info.state} state. Discarding and creating new session.`,
      )
      await prisma.preWarmedSession.delete({ where: { id: preWarmed.id } })
      throw new Error(`Pre-warmed session ${session.id} is in ${info.state} state`)
    }

    const activities = await replayHistoryActivities(session, thread, threadConfig)
    let welcomePlanRejected = false
    let welcomeFeedback = ''

    if (threadConfig.auto_reject?.enabled) {
      const hasActivePlan = !!(info as any).plan
      const hasPlanInHistory = activities.some((a: any) => a.type === 'planGenerated')

      if (hasActivePlan || hasPlanInHistory || info.state === 'awaitingPlanApproval') {
        logger.debug(
          `[preWarmedConsumer] Plan detected for session ${session.id} (Active: ${hasActivePlan}, History: ${hasPlanInHistory}, State: ${info.state}). Marking for rejection.`,
        )
        welcomePlanRejected = true
        welcomeFeedback =
          threadConfig.auto_reject?.message || threadConfig.messages.prompts.auto_reject_default
      }
    }

    if (welcomePlanRejected) {
      autoRejectedSessions.add(session.id)
      const botEmoji = threadConfig.bot_emoji || '🐙'
      logger.debug(
        `[preWarmedConsumer] Automatically rejecting welcome plan for pre-warmed session ${session.id}`,
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

    const initialSkipIds = activities.length > 0 ? new Set(activities.map((a: any) => a.id)) : undefined
    const initialCursorActivity = activities.length > 0 ? activities[activities.length - 1] : null

    logger.debug(
      `[preWarmedConsumer] Consumed pre-warmed session ${session.id} for repo ${repoName} (Context: ${contextKey || 'global'})`,
    )

    return {
      session,
      contextKey,
      initialSkipIds,
      initialCursorActivity,
      welcomePlanRejected,
      welcomeFeedback,
    }
  } catch (err) {
    logger.error(
      `[preWarmedConsumer] Failed to rehydrate pre-warmed session ${preWarmed.id}:`,
      err,
    )
    return null
  }
}

export async function dispatchPreWarmedUserTurn(
  session: any,
  thread: ThreadChannel,
  promptWithMetadata: string,
  welcomePlanRejected: boolean,
  welcomeFeedback: string,
  threadConfig: any,
  queueTurnId: string,
) {
  await thread.send(threadConfig.messages.session.prewarmed_ready)
  thread.sendTyping().catch(() => {})

  if (welcomePlanRejected) {
    const rejectionDirective = t(threadConfig.messages.prompts.auto_reject_directive_welcome, {
      feedback: welcomeFeedback,
    })
    logger.debug(
      `[preWarmedConsumer] Sending auto-rejection directive for session ${session.id}`,
    )
    await scheduleJulesRequest(() => session.send(rejectionDirective))

    logger.debug(
      `[preWarmedConsumer] Waiting for session ${session.id} to process rejection...`,
    )
    for (let i = 0; i < 20; i++) {
      const info = await scheduleJulesRequest(() => getFreshSessionInfo(session))
      if (info.state !== 'queued') {
        logger.debug(
          `[preWarmedConsumer] Session ${session.id} finished processing rejection (State: ${info.state})`,
        )
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    await new Promise((r) => setTimeout(r, 2000))
    autoRejectedSessions.delete(session.id)
  }

  logger.debug(`[preWarmedConsumer] Sending user prompt to session ${session.id}`)
  markConversationTurnDispatched(thread.id, queueTurnId)
  await scheduleJulesRequest(() => session.send(promptWithMetadata))
}
