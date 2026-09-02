import { logger } from '../../lib/utils/logger.js'
import { Message, TextChannel } from 'discord.js'
import { prisma, getEffectiveConfig, YAML_GUILDS } from '../../config.js'
import {
  updateReaction,
  initializeChatSession,
  scheduleNudgeForConversationTurn,
} from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'
import { hasPermission } from '../../lib/utils/permissions.js'
import { markConversationTurnDispatched, type ConversationTurn } from '../../lib/jules/ConversationQueue.js'
import { sendToExistingSession, shouldIgnoreMessage } from './sessionSender.js'

export type ChatRoutingContext = {
  dbDefaultRepo?: string
}

export async function resolveChatRoutingContext(
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

export async function processChatChannelMessage(
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
