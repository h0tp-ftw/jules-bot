import { Message, Events, ThreadChannel, TextChannel, ChannelType } from 'discord.js'
import { updateReaction } from '../lib/jules/orchestrator.js'
import type { StreamManager } from '../lib/streams/StreamManager.js'
import { enqueueConversationMessage } from '../lib/jules/ConversationQueue.js'
import { resolveThreadRoutingContext, processThreadMessage } from './messages/threadHandler.js'
import { resolveChatRoutingContext, processChatChannelMessage } from './messages/chatHandler.js'

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
