import { ThreadChannel, Events } from 'discord.js'
import { prisma } from '../config'
import { JulesClient } from '../lib/jules/JulesClient'
import { runJulesStream } from '../lib/jules/orchestrator'
import { StreamManager } from '../lib/streams/StreamManager'

export default {
  name: Events.ThreadCreate,
  async execute(thread: ThreadChannel, streamManager: StreamManager) {
    if (!thread.guildId) return

    // Find guild configuration
    const config = await prisma.guildConfig.findUnique({
      where: { guildId: thread.guildId },
    })

    if (!config || !config.forumChannelId || thread.parentId !== config.forumChannelId) {
      // Thread is not in the designated debugging forum channel
      return
    }

    // Wait a brief moment to ensure the starter message is posted
    await new Promise((resolve) => setTimeout(resolve, 2000))

    let starterMessage = null
    try {
      starterMessage = await thread.fetchStarterMessage()
    } catch (err) {
      console.error('Failed to fetch starter message:', err)
    }

    if (!starterMessage || !starterMessage.content) {
      await thread.send('⚠️ **Could not retrieve the starter message for this thread. Please reply with your issue details to start.**')
      return
    }

    const repo = config.defaultRepo
    if (!repo) {
      await thread.send('⚠️ **No default repository has been set for this server.** Please use the `/link-repo` command to set a default repository.')
      return
    }

    await thread.send(`🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repo}\``)

    try {
      const session = await JulesClient.createSession({
        prompt: starterMessage.content,
        repo: repo,
        title: thread.name,
      })

      await prisma.debugSession.create({
        data: {
          threadId: thread.id,
          guildId: thread.guildId,
          julesSessionId: session.id,
          repoName: repo,
        },
      })

      // Start processing events in the background
      runJulesStream(session.id, thread, streamManager)
    } catch (err) {
      console.error('Failed to start Jules session:', err)
      await thread.send('❌ **Failed to start Jules diagnostic session. Please verify your repository configuration and permissions.**')
    }
  },
}
