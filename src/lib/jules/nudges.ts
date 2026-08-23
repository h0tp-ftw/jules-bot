import { logger } from '../utils/logger.js'
import { getEffectiveConfig } from '../../config.js'
import { t } from '../../strings.js'
import { splitMessage } from '../utils/messageSplitter.js'
import { scheduleConversationNudge } from './ConversationQueue.js'
import { scheduleJulesRequest } from './JulesRequestCoordinator.js'
import { wakeJulesStream } from './streamRegistry.js'
import type { JulesDiscordChannel } from './channelTypes.js'

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
