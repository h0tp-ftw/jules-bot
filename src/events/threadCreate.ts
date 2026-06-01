import { ThreadChannel, Events, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder } from 'discord.js'
import { prisma, YAML_GUILDS, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { initializeJulesSession } from '../lib/jules/orchestrator.js'
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

    const threadConfig = getEffectiveConfig(thread, starterMessage.member)
    const isInteractive = threadConfig.interactive_selection || !repo

    if (isInteractive) {
      try {
        const repos = await JulesClient.getConnectedRepos()
        if (repos.length > 0) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`select-repo:${thread.id}`)
            .setPlaceholder('Choose a repository...')
            .addOptions(
              repos.slice(0, 25).map(r => 
                new StringSelectMenuOptionBuilder()
                  .setLabel(r.name)
                  .setValue(r.name)
              )
            )

          const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
          await thread.send({
            content: '📋 **Configure Jules Diagnostic Session**\nPlease select the repository you want to run diagnostics against:',
            components: [row],
          })
          return
        }
      } catch (err) {
        console.error('Failed to load connected repos for selection:', err)
      }
    }

    if (!repo) {
      await thread.send('⚠️ **No default repository has been set for this server.** Please use the `/link-repo` command to set a default repository.')
      return
    }

    const repoName: string = repo
    await thread.send(`🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\``)

    try {
      await initializeJulesSession(thread, repoName, 'main', streamManager)
    } catch (err) {
      console.error('Failed to start Jules session:', err)
      await thread.send('❌ **Failed to start Jules diagnostic session. Please verify your repository configuration and permissions.**')
    }
  },
}
