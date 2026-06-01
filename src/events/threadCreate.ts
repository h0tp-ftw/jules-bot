import { ThreadChannel, Events } from 'discord.js'
import { prisma, YAML_GUILDS } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

export default {
  name: Events.ThreadCreate,
  async execute(thread: ThreadChannel, streamManager: StreamManager) {
    if (!thread.guildId) return

    // Check config.yaml overrides first
    const yamlGuild = YAML_GUILDS[thread.guildId]
    let repo = yamlGuild?.default_repo
    let forumChannelId = yamlGuild?.forum_channel_id

    // Fallback to database config if not configured in YAML
    if (!repo || !forumChannelId) {
      const config = await prisma.guildConfig.findUnique({
        where: { guildId: thread.guildId },
      })
      if (!repo) repo = config?.defaultRepo ?? undefined
      if (!forumChannelId) forumChannelId = config?.forumChannelId ?? undefined
    }

    if (!forumChannelId || thread.parentId !== forumChannelId) {
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

    if (!repo) {
      await thread.send('⚠️ **No default repository has been set for this server.** Please use the `/link-repo` command to set a default repository.')
      return
    }

    const repoName: string = repo

    await thread.send(`🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\``)

    try {
      const session = await JulesClient.createSession({
        prompt: starterMessage.content,
        repo: repoName,
        title: thread.name,
      })

      await prisma.debugSession.create({
        data: {
          threadId: thread.id,
          guildId: thread.guildId,
          julesSessionId: session.id,
          repoName: repoName,
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
