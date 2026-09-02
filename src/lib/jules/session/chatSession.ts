import { logger } from '../../utils/logger.js'
import { ChannelType, Message, TextChannel } from 'discord.js'
import { JulesClient } from '../JulesClient.js'
import type { StreamManager } from '../../streams/StreamManager.js'
import { prisma, getEffectiveConfig } from '../../../config.js'
import { formatAttachmentMetadata } from '../../utils/attachments.js'
import { buildReplyAwarePrompt } from '../../utils/reply.js'
import { scheduleJulesRequest } from '../JulesRequestCoordinator.js'
import { runJulesStream } from '../runJulesStream.js'

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
