import { Message, Events, ThreadChannel } from 'discord.js'
import { prisma, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams, updateReaction } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'
import { formatAttachmentMetadata } from '../lib/utils/attachments.js'
import { t } from '../strings.js'

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
        await message.reply(threadConfig.messages.errors.no_permission_session)
      }
      return
    }

    // Process attachments if any
    let messageContent = message.content || ''
    if (message.attachments.size > 0) {
      const attachmentList = Array.from(message.attachments.values()).map(att => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType || undefined,
        size: att.size || undefined
      }))

      messageContent += formatAttachmentMetadata(attachmentList, threadConfig.messages.attachments)
    }

    console.log(`[MessageCreate] Event triggered for thread ${thread.id}. Content length: ${messageContent.length}`)

    try {
      const session = JulesClient.getSession(sessionRecord.julesSessionId)

      // State check is handled in the background stream listener

      console.log(`[MessageCreate] activeStreams status for thread ${thread.id}: ${activeStreams.has(thread.id)}`)
      // Rehydrate the stream listener if not already active — e.g. after a bot
      // restart, or when continuing an old/completed session whose handler is no
      // longer running. Wait until the listener has replayed history into its
      // skip set (the onReady signal) before sending, so the reply to THIS
      // message isn't swallowed as "already seen". Capped at 5s so a slow or
      // stuck history replay can't block message delivery indefinitely.
      if (!activeStreams.has(thread.id)) {
        console.log(`[MessageCreate] Rehydrating runJulesStream for thread ${thread.id}`)
        let signalReady: () => void = () => {}
        const ready = new Promise<void>((resolve) => {
          signalReady = resolve
        })
        runJulesStream(sessionRecord.julesSessionId, thread, streamManager, undefined, signalReady)
        await Promise.race([
          ready,
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ])
      }

      thread.sendTyping().catch(() => {})

      // Update reaction to 'in_progress' immediately
      await updateReaction(message, 'in_progress')

      // Send the user prompt to Jules with metadata
      const authorNickname = message.member?.displayName || message.author.username
      const authorUsername = message.author.username
      const authorId = message.author.id
      const messageTime = message.createdAt.toISOString()
      const promptWithMetadata = t(threadConfig.messages.prompts.metadata_header, {
        nickname: authorNickname,
        username: authorUsername,
        id: authorId,
        time: messageTime,
        content: messageContent,
      })

      console.log(`[MessageCreate] Sending message to Jules session ${sessionRecord.julesSessionId}...`)
      await session.send(promptWithMetadata)
      console.log(`[MessageCreate] Message sent successfully to Jules session ${sessionRecord.julesSessionId}`)
    } catch (err) {
      console.error(`Failed to send message to Jules for thread ${thread.id}:`, err)
      await message.reply(threadConfig.messages.session.message_delivery_failed)
    }
  },
}
