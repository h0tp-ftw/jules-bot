import { logger } from '../../lib/utils/logger.js'
import { Message, DMChannel } from 'discord.js'
import { prisma, getEffectiveConfig } from '../../config.js'
import { JulesClient } from '../../lib/jules/JulesClient.js'
import {
  updateReaction,
  scheduleNudgeForConversationTurn,
  scheduleJulesRequest,
  runJulesStream,
} from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'
import { hasPermission } from '../../lib/utils/permissions.js'
import {
  markConversationTurnDispatched,
  type ConversationTurn,
} from '../../lib/jules/ConversationQueue.js'
import { sendToExistingSession, shouldIgnoreMessage } from './sessionSender.js'
import { startTypingLoop, stopTypingLoop } from '../../lib/utils/typingManager.js'
import { deliverWithReply } from '../../lib/utils/replyDelivery.js'
import { formatAttachmentMetadata } from '../../lib/utils/attachments.js'
import { buildReplyAwarePrompt } from '../../lib/utils/reply.js'

export async function processDMMessage(
  message: Message,
  channel: DMChannel,
  streamManager: StreamManager,
  turn: ConversationTurn,
): Promise<boolean> {
  const channelConfig = getEffectiveConfig(channel, null, 'NO_CODEBASE')
  if (shouldIgnoreMessage(message, channel, 'NO_CODEBASE')) return false
  if (!message.content && message.attachments.size === 0) return false

  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: channel.id },
  })

  if (sessionRecord) {
    return await sendToExistingSession(
      message,
      channel,
      sessionRecord,
      streamManager,
      true,
      turn.id,
      'NO_CODEBASE',
    )
  }

  const { authorized, silent } = await hasPermission(null, message.author, channel)
  if (!authorized) {
    if (!silent) {
      await deliverWithReply(channel, message, channelConfig.reply_mode, {
        content: channelConfig.messages.errors.no_permission_session,
      })
    }
    await updateReaction(message, 'failed')
    return false
  }

  try {
    if (channelConfig.typing_indicator_mode === 'strict_state') {
      channel.sendTyping().catch(() => {})
    } else {
      startTypingLoop(channel)
    }
    markConversationTurnDispatched(channel.id, turn.id)

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
      channelConfig.messages.prompts.metadata_header,
      {
        nickname: message.author.displayName || message.author.username,
        username: message.author.username,
        id: message.author.id,
        message_id: message.id,
        time: message.createdAt.toISOString(),
        content: messageContent,
      },
      channelConfig.messages.prompts,
    )

    const session = await scheduleJulesRequest(() =>
      JulesClient.createSession({
        prompt: promptWithMetadata,
        repo: 'NO_CODEBASE',
        branch: '',
        title: `DM: ${message.author.username}`,
        thread: channel,
        member: null,
        omitPersonas: true,
      }),
    )

    await prisma.debugSession.create({
      data: {
        threadId: channel.id,
        guildId: 'DM',
        julesSessionId: session.id,
        repoName: 'NO_CODEBASE',
        deliveryCursorInitialized: true,
      },
    })

    void runJulesStream(session.id, channel, streamManager, undefined, undefined, {
      chatbotMode: true,
    }).catch((err) => {
      logger.error(
        `[processDMMessage] Stream failed for DM ${channel.id}, session ${session.id}:`,
        err,
      )
    })

    scheduleNudgeForConversationTurn(channel, turn.id, session, null, 'NO_CODEBASE')
    return true
  } catch (err) {
    logger.error(`Failed to start DM session for channel ${channel.id}:`, err)
    stopTypingLoop(channel.id)
    await updateReaction(message, 'failed').catch(() => {})
    await deliverWithReply(channel, message, channelConfig.reply_mode, {
      content: channelConfig.messages.session.message_delivery_failed,
    })
    return false
  }
}
