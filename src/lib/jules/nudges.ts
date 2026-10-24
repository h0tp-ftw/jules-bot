import { logger } from '../utils/logger.js'
import { getEffectiveConfig, prisma } from '../../config.js'
import { t } from '../../strings.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { deliverWithReply } from '../utils/replyDelivery.js'
import { createSystemEmbed } from '../utils/embeds.js'
import { scheduleConversationNudge, clearConversationQueue } from './ConversationQueue.js'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import { wakeJulesStream, teardownStreamState } from './streamRegistry.js'
import type { JulesDiscordChannel } from './channelTypes.js'

function formatNudgeDelay(minutes: number, messages: any): string {
  const template =
    minutes === 1 ? messages.session.nudge_delay_minute : messages.session.nudge_delay_minutes
  return t(template, { minutes })
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
      const currentNudgeCount = turn.nudgeCount || 1
      const maxNudges = channelConfig.nudge.max_nudges || 3
      const shouldAutoReset = channelConfig.nudge.auto_reset && currentNudgeCount >= maxNudges

      if (shouldAutoReset) {
        const totalMinutes = channelConfig.nudge.after_minutes * currentNudgeCount
        const delayStr = formatNudgeDelay(totalMinutes, channelConfig.messages)
        logger.warn(
          `[Nudge] Reached max inactivity nudges (${currentNudgeCount}/${maxNudges}) for channel ${channel.id}. Resetting session and clearing queues.`,
        )

        // 1. Teardown stream and delete session from DB
        teardownStreamState(channel.id, session.id)
        try {
          await prisma.debugSession.delete({
            where: { threadId: channel.id },
          })
        } catch (err) {
          logger.debug(`[Nudge] DebugSession for ${channel.id} was already removed:`, err)
        }

        // 2. Clear conversation queue (cancels timers, unblocks waiters, discards pending messages)
        clearConversationQueue(channel.id, 'cleared')

        // 3. Post notification to Discord
        if (channelConfig.nudge.notify_discord) {
          const resetNotice = t(channelConfig.messages.session.inactivity_reset_notice, {
            delay: delayStr,
          })
          const replyable = turn.message.channelId === channel.id ? turn.message : null
          try {
            await deliverWithReply(channel, replyable, channelConfig.reply_mode, {
              embeds: [
                createSystemEmbed('error', {
                  title: '⏳ Session Timed Out',
                  description: resetNotice,
                }),
              ],
            })
          } catch (err) {
            logger.warn(`[Nudge] Could not post inactivity reset notice in ${channel.id}:`, err)
          }
        }
        return
      }

      logger.info(
        `[Nudge] Sending response reminder for Discord message ${turn.message.id} to Jules session ${session.id}`,
      )
      await scheduleJulesRequest(() => session.send(nudgePrompt))
      wakeJulesStream(channel.id)

      if (!channelConfig.nudge.notify_discord) return

      const totalMinutes = channelConfig.nudge.after_minutes * currentNudgeCount
      const content = t(discordNotice, {
        delay: formatNudgeDelay(totalMinutes, channelConfig.messages),
      })
      const chunks = splitMessage(content, 2000)
      if (chunks.length === 0) return

      const replyable = turn.message.channelId === channel.id ? turn.message : null
      try {
        await deliverWithReply(channel, replyable, channelConfig.reply_mode, {
          embeds: [
            createSystemEmbed('warning', {
              title: '⏳ Inactivity Reminder',
              description: content,
            }),
          ],
        })
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
