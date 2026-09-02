import { logger } from '../../utils/logger.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import type { StreamManager } from '../../streams/StreamManager.js'
import { prisma, getEffectiveConfig } from '../../../config.js'
import { t } from '../../../strings.js'
import {
  completeConversationTurn,
  type ConversationTurnCompletionReason,
} from '../ConversationQueue.js'
import {
  formatCompletionFallback,
  type TurnResponseState,
} from '../../utils/sessionOutcome.js'
import { resolveMessageEmojis } from '../../utils/emojis.js'
import { extractReactionMarkers } from '../../utils/reactionMarkers.js'
import { splitMessage } from '../../utils/messageSplitter.js'
import {
  julesRequestCoordinator as activityPollScheduler,
  scheduleJulesRequest,
} from '../JulesRequestCoordinator.js'
import { autoRejectedSessions, teardownStreamState } from '../streamRegistry.js'
import { updateReaction, applyJulesReactions } from '../reactions.js'
import { getCompletedSessionResult } from '../sessionInfo.js'
import type { JulesActivity, JulesSession } from '../julesTypes.js'
import type { JulesDiscordChannel } from '../channelTypes.js'
import type { StreamTurnTarget } from './streamTurnTarget.js'

export type ActivityHandlerContext = {
  sessionId: string
  session: JulesSession
  thread: JulesDiscordChannel
  streamManager: StreamManager
  chatbotMode: boolean
  turnTarget: StreamTurnTarget
  stopTyping: () => void
  turnState: TurnResponseState
}

export async function handlePlanGenerated(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
): Promise<{ queuedTurnRespondedId?: string }> {
  logger.debug(`[runJulesStream] planGenerated for ${ctx.sessionId}`)
  activityPollScheduler.markIdle(ctx.thread.id)
  const plan = activity.plan || (activity as any).planGenerated?.plan
  if (!plan || !plan.steps) return {}

  const lastHuman = await ctx.turnTarget.getTarget()
  const threadConfig = getEffectiveConfig(ctx.thread, lastHuman?.member)
  const autoReject = threadConfig.auto_reject || {}
  const shouldAutoReject =
    ctx.chatbotMode || (autoReject.enabled && !autoRejectedSessions.has(ctx.sessionId))

  if (shouldAutoReject) {
    if (!ctx.chatbotMode) autoRejectedSessions.add(ctx.sessionId)
    const feedback = ctx.chatbotMode
      ? threadConfig.messages.prompts.chatbot_mode_plan_feedback
      : autoReject.message || threadConfig.messages.prompts.auto_reject_default
    if (!ctx.chatbotMode) {
      await ctx.thread.send(
        t(threadConfig.messages.plan.auto_rejected_notice, {
          emoji: '🤖',
          feedback,
        }),
      )
    }
    await scheduleJulesRequest(() => ctx.session.send(feedback))
    activityPollScheduler.markActive(ctx.thread.id)
    const target = await ctx.turnTarget.getTarget()
    await updateReaction(target, 'in_progress')
    return {}
  }

  const target = await ctx.turnTarget.getTarget()
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
    .setDescription(stepsText.slice(0, 4000) || threadConfig.messages.plan.embed_no_details)
    .setColor(0x00ae86)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`plan-approve:${ctx.thread.id}`)
      .setLabel(threadConfig.messages.plan.approve_button)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`plan-reject:${ctx.thread.id}`)
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
    msg = await ctx.thread.send({
      embeds: [embed],
      components: [row],
    })
  }

  await prisma.debugSession.update({
    where: { threadId: ctx.thread.id },
    data: { planMessageId: msg.id },
  })

  const currentQueuedTurnId = ctx.turnTarget.getCurrentQueuedTurnId()
  return { queuedTurnRespondedId: currentQueuedTurnId }
}

export async function handleProgressUpdated(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
): Promise<void> {
  logger.debug(`[runJulesStream] progressUpdated for ${ctx.sessionId}`)
  activityPollScheduler.markActive(ctx.thread.id)
  const target = await ctx.turnTarget.getTarget()
  await updateReaction(target, 'in_progress')
  const title = activity.title || (activity as any).progressUpdated?.title || ''
  const description = activity.description || (activity as any).progressUpdated?.description || ''

  if (!ctx.chatbotMode && (title || description)) {
    await ctx.streamManager.handleProgress(
      ctx.thread.id,
      title || description,
      title ? description || undefined : undefined,
    )
  }
}

export async function handleAgentMessaged(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
): Promise<{
  queuedTurnRespondedId?: string
  queuedTurnCompletion?: { reason: ConversationTurnCompletionReason; turnId: string }
}> {
  logger.debug(`[runJulesStream] agentMessaged for ${ctx.sessionId}`)
  activityPollScheduler.markIdle(ctx.thread.id)
  const rawMessage = activity.message || (activity as any).agentMessaged?.message || ''

  if (rawMessage) {
    const target = await ctx.turnTarget.getTarget()
    const threadConfig = getEffectiveConfig(ctx.thread, target?.member)
    const reactionsEnabled = threadConfig.jules_reactions?.enabled === true
    const { text: bodyText, emojis } = reactionsEnabled
      ? extractReactionMarkers(rawMessage)
      : { text: rawMessage, emojis: [] as string[] }

    if (bodyText) {
      const resolved = resolveMessageEmojis(ctx.thread.client, bodyText)
      const splits = splitMessage(resolved, 2000)
      if (target && threadConfig.reply_mode !== 'send') {
        const allowedMentions =
          threadConfig.reply_mode === 'reply_silent' ? { repliedUser: false } : undefined
        for (let i = 0; i < splits.length; i++) {
          if (i === 0) {
            await target.reply({ content: splits[i], allowedMentions })
          } else {
            await ctx.thread.send(splits[i])
          }
        }
      } else {
        for (const chunk of splits) {
          await ctx.thread.send(chunk)
        }
      }
    }

    if (!(emojis.length > 0 && (await applyJulesReactions(target, emojis)))) {
      await updateReaction(target, 'responded')
    }
  }

  const currentQueuedTurnId = ctx.turnTarget.getCurrentQueuedTurnId()
  if (currentQueuedTurnId && rawMessage) {
    return {
      queuedTurnRespondedId: currentQueuedTurnId,
      queuedTurnCompletion: {
        reason: 'agent_responded',
        turnId: currentQueuedTurnId,
      },
    }
  }
  return {}
}

export async function handleSessionCompleted(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
): Promise<{
  queuedTurnCompletion?: { reason: ConversationTurnCompletionReason; turnId: string }
  nextTurnState: TurnResponseState
}> {
  logger.debug(`[runJulesStream] sessionCompleted for ${ctx.sessionId}`)
  activityPollScheduler.markIdle(ctx.thread.id)
  const target = await ctx.turnTarget.getTarget()
  const outcome = await getCompletedSessionResult(ctx.session, ctx.sessionId)
  const pullRequestUrl = outcome?.pullRequest?.url

  await updateReaction(target, 'completed')
  await ctx.streamManager.finalizeSession(ctx.thread.id, true, undefined, { pullRequestUrl })

  let nextTurnState = ctx.turnState
  if (ctx.turnState.awaitingAgentReply) {
    logger.warn(
      `[runJulesStream] Session ${ctx.sessionId} completed without an agent reply for the latest Discord turn; posting a result fallback.`,
    )
    const threadConfig = getEffectiveConfig(ctx.thread, target?.member)
    const fallback = formatCompletionFallback(threadConfig.messages, {
      pullRequestUrl,
      latestProgress: ctx.turnState.latestProgress,
    })
    const splits = splitMessage(fallback, 2000)
    if (target && threadConfig.reply_mode !== 'send') {
      const allowedMentions =
        threadConfig.reply_mode === 'reply_silent' ? { repliedUser: false } : undefined
      for (let i = 0; i < splits.length; i++) {
        if (i === 0) {
          await target.reply({ content: splits[i], allowedMentions })
        } else {
          await ctx.thread.send(splits[i])
        }
      }
    } else {
      for (const chunk of splits) {
        await ctx.thread.send(chunk)
      }
    }
    nextTurnState = { awaitingAgentReply: false }
  }

  autoRejectedSessions.delete(ctx.sessionId)
  ctx.stopTyping()

  const currentQueuedTurnId = ctx.turnTarget.getCurrentQueuedTurnId()
  return {
    nextTurnState,
    queuedTurnCompletion: currentQueuedTurnId
      ? {
          reason: 'session_completed',
          turnId: currentQueuedTurnId,
        }
      : undefined,
  }
}

export async function handleSessionFailed(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
  markActivityProcessed: (activity: JulesActivity) => Promise<void>,
): Promise<void> {
  logger.debug(`[runJulesStream] sessionFailed for ${ctx.sessionId}`)
  const target = await ctx.turnTarget.getTarget()
  await updateReaction(target, 'failed')
  const reason = activity.reason || (activity as any).sessionFailed?.reason || ''
  await ctx.streamManager.finalizeSession(ctx.thread.id, false, reason)
  await markActivityProcessed(activity)
  const currentQueuedTurnId = ctx.turnTarget.getCurrentQueuedTurnId()
  if (currentQueuedTurnId) {
    completeConversationTurn(ctx.thread.id, 'session_failed', currentQueuedTurnId)
  } else {
    ctx.turnTarget.releaseActiveQueuedTurn('session_failed')
  }
  teardownStreamState(ctx.thread.id, ctx.sessionId)
  ctx.stopTyping()
}

export async function handleUserMessaged(
  activity: JulesActivity,
  ctx: ActivityHandlerContext,
): Promise<void> {
  logger.debug(`[runJulesStream] userMessaged for ${ctx.sessionId}`)
  activityPollScheduler.markActive(ctx.thread.id)
  ctx.turnTarget.onUserMessaged(activity)
  await ctx.turnTarget.getTarget(true)
}
