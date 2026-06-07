import { Message, Events, ThreadChannel } from 'discord.js'
import { prisma, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams, updateReaction } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { processAttachments } from '../lib/utils/docling.js'

import { hasPermission } from '../lib/utils/permissions.js'

export default {
  name: Events.MessageCreate,
  async execute(message: Message, streamManager: StreamManager) {
    // Ignore bot messages
    if (message.author.bot) return

    // Verify it is a thread
    if (!message.channel.isThread()) return

    const thread = message.channel as ThreadChannel

    const threadConfig = getEffectiveConfig(thread, message.member)
    if (threadConfig.ignore_prefix && message.content && message.content.startsWith(threadConfig.ignore_prefix)) {
      return
    }

    // Check if thread maps to a Jules session
    const sessionRecord = await prisma.debugSession.findUnique({
      where: { threadId: thread.id },
    })

    if (!sessionRecord) return

    // Enforce permission checks
    const { authorized, silent } = await hasPermission(message.member, message.author, thread)
    if (!authorized) {
      if (!silent) {
        await message.reply('❌ **You do not have permission to interact with this diagnostic session.**')
      }
      return
    }

    // Process attachments if any
    let messageContent = message.content || ''
    if (message.attachments.size > 0) {
      const attachmentList = Array.from(message.attachments.values()).map(att => ({
        name: att.name,
        url: att.url
      }))
      const parsedAttachments = await processAttachments(attachmentList, thread)
      messageContent += parsedAttachments
    }

    console.log(`[MessageCreate] Event triggered for thread ${thread.id}. Content length: ${messageContent.length}`)

    try {
      const session = JulesClient.getSession(sessionRecord.julesSessionId)

      // State check is handled in the background stream listener

      console.log(`[MessageCreate] activeStreams status for thread ${thread.id}: ${activeStreams.has(thread.id)}`)
      // Rehydrate stream listener if not already active (e.g. after bot restart)
      if (!activeStreams.has(thread.id)) {
        console.log(`[MessageCreate] Rehydrating runJulesStream for thread ${thread.id}`)
        runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
        // Give the stream listener a moment to initialize
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      thread.sendTyping().catch(() => {})

      // Update reaction to 'in_progress' immediately
      await updateReaction(message, 'in_progress')

      // Send the user prompt to Jules with metadata
      const authorNickname = message.member?.displayName || message.author.username
      const authorUsername = message.author.username
      const authorId = message.author.id
      const messageTime = message.createdAt.toISOString()
      const promptWithMetadata = `[Message details - Author Nickname: ${authorNickname}, Author Username: ${authorUsername}, Author Discord ID: ${authorId}, Message Time: ${messageTime}]\n\n${messageContent}`

      console.log(`[MessageCreate] Sending message to Jules session ${sessionRecord.julesSessionId}...`)
      await session.send(promptWithMetadata)
      console.log(`[MessageCreate] Message sent successfully to Jules session ${sessionRecord.julesSessionId}`)
    } catch (err) {
      console.error(`Failed to send message to Jules for thread ${thread.id}:`, err)
      await message.reply('❌ **Failed to deliver message to Jules. Please make sure the session is still active.**')
    }
  },
}
