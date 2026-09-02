import { logger } from '../../lib/utils/logger.js'
import { Message } from 'discord.js'
import { getEffectiveConfig } from '../../config.js'
import { JulesClient } from '../../lib/jules/JulesClient.js'
import {
  runJulesStream,
  activeStreams,
  updateReaction,
  scheduleNudgeForConversationTurn,
  scheduleJulesRequest,
  wakeJulesStream,
  type JulesDiscordChannel,
} from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'
import { formatAttachmentMetadata } from '../../lib/utils/attachments.js'
import { buildReplyAwarePrompt } from '../../lib/utils/reply.js'
import { hasPermission } from '../../lib/utils/permissions.js'
import { markConversationTurnDispatched } from '../../lib/jules/ConversationQueue.js'

export function shouldIgnoreMessage(
  message: Message,
  channel: JulesDiscordChannel,
  dbDefaultRepo?: string,
): boolean {
  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)
  return Boolean(
    channelConfig.ignore_prefix &&
      message.content &&
      message.content.startsWith(channelConfig.ignore_prefix),
  )
}

export async function sendToExistingSession(
  message: Message,
  channel: JulesDiscordChannel,
  sessionRecord: { julesSessionId: string },
  streamManager: StreamManager,
  chatbotMode: boolean,
  turnId: string,
  dbDefaultRepo?: string,
): Promise<boolean> {
  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)

  const { authorized, silent } = await hasPermission(message.member, message.author, channel)
  if (!authorized) {
    if (!silent) {
      await message.reply(channelConfig.messages.errors.no_permission_session)
    }
    await updateReaction(message, 'failed')
    return false
  }

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

  if (!messageContent) {
    await updateReaction(message, 'failed')
    return false
  }

  logger.debug(
    `[MessageCreate] Event triggered for ${chatbotMode ? 'chatbot channel' : 'thread'} ${channel.id}. Content length: ${messageContent.length}`,
  )

  try {
    const session = JulesClient.getSession(sessionRecord.julesSessionId)

    logger.debug(
      `[MessageCreate] activeStreams status for channel ${channel.id}: ${activeStreams.has(channel.id)}`,
    )
    // Rehydrate the stream listener if not already active
    if (!activeStreams.has(channel.id)) {
      logger.debug(`[MessageCreate] Rehydrating runJulesStream for channel ${channel.id}`)
      let signalReady: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        signalReady = resolve
      })
      void runJulesStream(
        sessionRecord.julesSessionId,
        channel,
        streamManager,
        undefined,
        signalReady,
        { chatbotMode },
      ).catch((err) => {
        logger.error(
          `[MessageCreate] Rehydrated stream failed for channel ${channel.id}, session ${sessionRecord.julesSessionId}:`,
          err,
        )
      })
      await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 5000))])
    }

    channel.sendTyping().catch(() => {})
    await updateReaction(message, 'in_progress')

    const promptWithMetadata = await buildReplyAwarePrompt(
      message,
      channelConfig.reply_context_mode,
      channelConfig.messages.prompts.metadata_header,
      {
        nickname: message.member?.displayName || message.author.username,
        username: message.author.username,
        id: message.author.id,
        message_id: message.id,
        time: message.createdAt.toISOString(),
        content: messageContent,
      },
      channelConfig.messages.prompts,
    )

    logger.debug(
      `[MessageCreate] Sending message to Jules session ${sessionRecord.julesSessionId}...`,
    )
    markConversationTurnDispatched(channel.id, turnId)
    await scheduleJulesRequest(() => session.send(promptWithMetadata))
    wakeJulesStream(channel.id)
    scheduleNudgeForConversationTurn(channel, turnId, session, message.member, dbDefaultRepo)
    logger.debug(
      `[MessageCreate] Message sent successfully to Jules session ${sessionRecord.julesSessionId}`,
    )
    return true
  } catch (err) {
    logger.error(`Failed to send message to Jules for channel ${channel.id}:`, err)
    await updateReaction(message, 'failed').catch(() => {})
    await message.reply(channelConfig.messages.session.message_delivery_failed)
    return false
  }
}
