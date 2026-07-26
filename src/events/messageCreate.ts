import { logger } from '../lib/utils/logger.js'
import { Message, Events, ThreadChannel, TextChannel, ChannelType } from 'discord.js'
import { prisma, getEffectiveConfig, YAML_GUILDS } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import {
  runJulesStream,
  activeStreams,
  updateReaction,
  initializeChatSession,
  type JulesDiscordChannel,
} from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { formatAttachmentMetadata } from '../lib/utils/attachments.js'
import { t } from '../strings.js'
import { hasPermission } from '../lib/utils/permissions.js'

const chatChannelQueues = new Map<string, Promise<void>>()

function shouldIgnoreMessage(
  message: Message,
  channel: JulesDiscordChannel,
  dbDefaultRepo?: string,
) {
  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)
  return Boolean(
    channelConfig.ignore_prefix &&
    message.content &&
    message.content.startsWith(channelConfig.ignore_prefix),
  )
}

async function sendToExistingSession(
  message: Message,
  channel: JulesDiscordChannel,
  sessionRecord: { julesSessionId: string },
  streamManager: StreamManager,
  chatbotMode: boolean,
  dbDefaultRepo?: string,
) {
  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)

  const { authorized, silent } = await hasPermission(message.member, message.author, channel)
  if (!authorized) {
    if (!silent) {
      await message.reply(channelConfig.messages.errors.no_permission_session)
    }
    return
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

  if (!messageContent) return

  logger.debug(
    `[MessageCreate] Event triggered for ${chatbotMode ? 'chatbot channel' : 'thread'} ${channel.id}. Content length: ${messageContent.length}`,
  )

  try {
    const session = JulesClient.getSession(sessionRecord.julesSessionId)

    logger.debug(
      `[MessageCreate] activeStreams status for channel ${channel.id}: ${activeStreams.has(channel.id)}`,
    )
    // Rehydrate the stream listener if not already active — e.g. after a bot
    // restart, or when continuing an old/completed session whose handler is no
    // longer running. Wait until the listener has replayed history into its
    // skip set before sending so the reply to this message is not swallowed.
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

    const promptWithMetadata = t(channelConfig.messages.prompts.metadata_header, {
      nickname: message.member?.displayName || message.author.username,
      username: message.author.username,
      id: message.author.id,
      time: message.createdAt.toISOString(),
      content: messageContent,
    })

    logger.debug(
      `[MessageCreate] Sending message to Jules session ${sessionRecord.julesSessionId}...`,
    )
    await session.send(promptWithMetadata)
    logger.debug(
      `[MessageCreate] Message sent successfully to Jules session ${sessionRecord.julesSessionId}`,
    )
  } catch (err) {
    logger.error(`Failed to send message to Jules for channel ${channel.id}:`, err)
    await message.reply(channelConfig.messages.session.message_delivery_failed)
  }
}

async function processThreadMessage(
  message: Message,
  thread: ThreadChannel,
  streamManager: StreamManager,
) {
  if (shouldIgnoreMessage(message, thread)) return

  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: thread.id },
  })
  if (!sessionRecord) return

  await sendToExistingSession(message, thread, sessionRecord, streamManager, false)
}

async function processChatChannelMessage(
  message: Message,
  channel: TextChannel,
  streamManager: StreamManager,
  dbDefaultRepo?: string,
) {
  if (shouldIgnoreMessage(message, channel, dbDefaultRepo)) return
  if (!message.content && message.attachments.size === 0) return

  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)
  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: channel.id },
  })

  if (sessionRecord) {
    await sendToExistingSession(message, channel, sessionRecord, streamManager, true, dbDefaultRepo)
    return
  }

  const { authorized, silent } = await hasPermission(message.member, message.author, channel)
  if (!authorized) {
    if (!silent) {
      await message.reply(channelConfig.messages.errors.no_permission_session)
    }
    return
  }

  const repoName = channelConfig.default_repo
  if (!repoName) {
    await message.reply(channelConfig.messages.setup.no_default_repo)
    return
  }

  const branchName = channelConfig.default_branch || 'main'
  try {
    await updateReaction(message, 'queued')
    channel.sendTyping().catch(() => {})
    await initializeChatSession(message, repoName, branchName, streamManager)
  } catch (err) {
    logger.error(`Failed to start chatbot session for channel ${channel.id}:`, err)
    await updateReaction(message, 'failed').catch(() => {})
    await message.reply(channelConfig.messages.session.start_failed)
  }
}

async function enqueueChatChannelMessage(
  message: Message,
  channel: TextChannel,
  streamManager: StreamManager,
  dbDefaultRepo?: string,
) {
  const previous = chatChannelQueues.get(channel.id) || Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(() => processChatChannelMessage(message, channel, streamManager, dbDefaultRepo))

  chatChannelQueues.set(channel.id, current)
  try {
    await current
  } finally {
    if (chatChannelQueues.get(channel.id) === current) {
      chatChannelQueues.delete(channel.id)
    }
  }
}

export default {
  name: Events.MessageCreate,
  async execute(message: Message, streamManager: StreamManager) {
    if (message.author.bot) return

    if (message.channel.isThread()) {
      await processThreadMessage(message, message.channel as ThreadChannel, streamManager)
      return
    }

    if (!message.guildId || message.channel.type !== ChannelType.GuildText) return

    const yamlGuild = YAML_GUILDS[message.guildId]
    const dbConfig = await prisma.guildConfig.findUnique({
      where: { guildId: message.guildId },
    })
    const chatChannelId = yamlGuild?.chat_channel_id || dbConfig?.chatChannelId
    if (!chatChannelId || message.channel.id !== chatChannelId) return

    await enqueueChatChannelMessage(
      message,
      message.channel as TextChannel,
      streamManager,
      dbConfig?.defaultRepo || undefined,
    )
  },
}
