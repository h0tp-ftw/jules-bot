import { logger } from '../lib/utils/logger.js'
import { Message, Events, ThreadChannel, TextChannel, ChannelType } from 'discord.js'
import { prisma, getEffectiveConfig, YAML_GUILDS, yamlConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import {
  runJulesStream,
  activeStreams,
  updateReaction,
  initializeChatSession,
  scheduleNudgeForConversationTurn,
  scheduleJulesRequest,
  wakeJulesStream,
  type JulesDiscordChannel,
} from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { formatAttachmentMetadata } from '../lib/utils/attachments.js'
import { t } from '../strings.js'
import { hasPermission } from '../lib/utils/permissions.js'
import {
  enqueueConversationMessage,
  markConversationTurnDispatched,
  type ConversationTurn,
} from '../lib/jules/ConversationQueue.js'
import { isConfiguredThreadParent } from '../lib/utils/channelRouting.js'

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

type SessionRoutingRecord = {
  julesSessionId: string
}

type ThreadRoutingContext = {
  dbDefaultRepo?: string
  sessionRecord?: SessionRoutingRecord
}

async function resolveThreadRoutingContext(
  message: Message,
  thread: ThreadChannel,
): Promise<ThreadRoutingContext | null> {
  if (!message.guildId) return null

  const sessionRecord = await prisma.debugSession.findUnique({
    where: { threadId: thread.id },
  })
  const yamlGuild = YAML_GUILDS[message.guildId]
  const dbConfig = await prisma.guildConfig.findUnique({
    where: { guildId: message.guildId },
  })
  const dbDefaultRepo = dbConfig?.defaultRepo || undefined

  if (sessionRecord) {
    if (shouldIgnoreMessage(message, thread, dbDefaultRepo)) return null
    return { dbDefaultRepo, sessionRecord }
  }

  const forumChannelId = yamlGuild?.forum_channel_id || dbConfig?.forumChannelId
  const channelsConfig = yamlConfig.channels || {}
  if (!isConfiguredThreadParent(thread.parentId, forumChannelId, channelsConfig)) return null
  if (shouldIgnoreMessage(message, thread, dbDefaultRepo)) return null
  if (!message.content && message.attachments.size === 0) return null

  return { dbDefaultRepo }
}

async function processThreadMessage(
  message: Message,
  thread: ThreadChannel,
  streamManager: StreamManager,
  turn: ConversationTurn,
  routing: ThreadRoutingContext,
): Promise<boolean> {
  const sessionRecord =
    routing.sessionRecord ||
    (await prisma.debugSession.findUnique({
      where: { threadId: thread.id },
    }))
  if (!sessionRecord) {
    await updateReaction(message, 'failed')
    return false
  }

  return await sendToExistingSession(
    message,
    thread,
    sessionRecord,
    streamManager,
    false,
    turn.id,
    routing.dbDefaultRepo,
  )
}

type ChatRoutingContext = {
  dbDefaultRepo?: string
}

async function resolveChatRoutingContext(
  message: Message,
  channel: TextChannel,
): Promise<ChatRoutingContext | null> {
  if (!message.guildId) return null

  const yamlGuild = YAML_GUILDS[message.guildId]
  const dbConfig = await prisma.guildConfig.findUnique({
    where: { guildId: message.guildId },
  })
  const chatChannelId = yamlGuild?.chat_channel_id || dbConfig?.chatChannelId
  if (!chatChannelId || channel.id !== chatChannelId) return null

  const dbDefaultRepo = dbConfig?.defaultRepo || undefined
  if (shouldIgnoreMessage(message, channel, dbDefaultRepo)) return null
  if (!message.content && message.attachments.size === 0) return null

  return { dbDefaultRepo }
}

async function processChatChannelMessage(
  message: Message,
  channel: TextChannel,
  streamManager: StreamManager,
  turn: ConversationTurn,
  dbDefaultRepo?: string,
): Promise<boolean> {
  const channelConfig = getEffectiveConfig(channel, message.member, dbDefaultRepo)
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
      dbDefaultRepo,
    )
  }

  const { authorized, silent } = await hasPermission(message.member, message.author, channel)
  if (!authorized) {
    if (!silent) {
      await message.reply(channelConfig.messages.errors.no_permission_session)
    }
    await updateReaction(message, 'failed')
    return false
  }

  const repoName = channelConfig.default_repo
  if (!repoName) {
    await message.reply(channelConfig.messages.setup.no_default_repo)
    await updateReaction(message, 'failed')
    return false
  }

  const branchName = channelConfig.default_branch || 'main'
  try {
    channel.sendTyping().catch(() => {})
    markConversationTurnDispatched(channel.id, turn.id)
    const session = await initializeChatSession(message, repoName, branchName, streamManager)
    scheduleNudgeForConversationTurn(channel, turn.id, session, message.member, dbDefaultRepo)
    return true
  } catch (err) {
    logger.error(`Failed to start chatbot session for channel ${channel.id}:`, err)
    await updateReaction(message, 'failed').catch(() => {})
    await message.reply(channelConfig.messages.session.start_failed)
    return false
  }
}

export default {
  name: Events.MessageCreate,
  async execute(message: Message, streamManager: StreamManager) {
    if (message.author.bot) return

    if (message.channel.isThread()) {
      const thread = message.channel as ThreadChannel
      if (message.id === thread.id) return
      const routing = await resolveThreadRoutingContext(message, thread)
      if (!routing) return

      await enqueueConversationMessage(
        thread.id,
        message,
        (turn) => processThreadMessage(message, thread, streamManager, turn, routing),
        () => updateReaction(message, 'queued'),
      )
      return
    }

    if (!message.guildId || message.channel.type !== ChannelType.GuildText) return

    const channel = message.channel as TextChannel
    const routing = await resolveChatRoutingContext(message, channel)
    if (!routing) return

    await enqueueConversationMessage(
      channel.id,
      message,
      (turn) =>
        processChatChannelMessage(message, channel, streamManager, turn, routing.dbDefaultRepo),
      () => updateReaction(message, 'queued'),
    )
  },
}
