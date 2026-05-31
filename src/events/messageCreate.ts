import { Message, Events, ThreadChannel } from 'discord.js'
import { prisma } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

import { hasPermission } from '../lib/utils/permissions.js'

export default {
  name: Events.MessageCreate,
  async execute(message: Message, streamManager: StreamManager) {
    // Ignore bot messages
    if (message.author.bot) return

    // Verify it is a thread
    if (!message.channel.isThread()) return

    const thread = message.channel as ThreadChannel

    // Check if thread maps to a Jules session
    const sessionRecord = await prisma.debugSession.findUnique({
      where: { threadId: thread.id },
    })

    if (!sessionRecord) return

    // Enforce permission checks
    if (!hasPermission(message.member, message.author)) {
      await message.reply('❌ **You do not have permission to interact with this diagnostic session.**')
      return
    }

    try {
      const session = JulesClient.getSession(sessionRecord.julesSessionId)

      // Rehydrate stream listener if not already active (e.g. after bot restart)
      if (!activeStreams.has(thread.id)) {
        runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
        // Give the stream listener a moment to initialize
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      // Send the user prompt to Jules
      await session.send(message.content)
    } catch (err) {
      console.error(`Failed to send message to Jules for thread ${thread.id}:`, err)
      await message.reply('❌ **Failed to deliver message to Jules. Please make sure the session is still active.**')
    }
  },
}
