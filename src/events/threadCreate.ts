import { logger } from '../lib/utils/logger.js'
import {
  ThreadChannel,
  Events,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
} from 'discord.js'
import { prisma, YAML_GUILDS, getEffectiveConfig } from '../config.js'
import { t } from '../strings.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { initializeJulesSession, updateReaction } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

const pendingThreads = new Set<string>()

export default {
  name: Events.ThreadCreate,
  async execute(thread: ThreadChannel, streamManager: StreamManager) {
    if (!thread.guildId) return

    logger.debug(
      `[Event: ThreadCreate] New thread "${thread.name}" (${thread.id}) created in parent ${thread.parentId}`,
    )

    if (pendingThreads.has(thread.id)) {
      logger.debug(
        `[Event: ThreadCreate] Thread ${thread.id} is already being initialized. Skipping.`,
      )
      return
    }
    pendingThreads.add(thread.id)

    // Remove from set after a timeout to prevent memory leak
    setTimeout(() => pendingThreads.delete(thread.id), 30000)

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
      logger.error('Failed to fetch starter message:', err)
    }

    if (!starterMessage || (!starterMessage.content && starterMessage.attachments.size === 0)) {
      await thread.send(getEffectiveConfig(thread).messages.session.starter_message_unavailable)
      return
    }

    // Add reaction to indicate session setup has acknowledged the message
    await updateReaction(starterMessage, 'queued').catch(() => {})

    const threadConfig = getEffectiveConfig(thread, starterMessage.member, repo)
    const isInteractive = threadConfig.interactive_selection || !repo

    if (isInteractive) {
      try {
        const repos = await JulesClient.getConnectedRepos()
        if (repos.length > 0) {
          const options: StringSelectMenuOptionBuilder[] = []
          const defaultRepo = threadConfig.default_repo

          if (defaultRepo) {
            options.push(
              new StringSelectMenuOptionBuilder()
                .setLabel(t(threadConfig.messages.setup.default_repo_option, { repo: defaultRepo }))
                .setValue(defaultRepo),
            )
          }

          const filteredRepos = defaultRepo ? repos.filter((r) => r.name !== defaultRepo) : repos

          const maxOtherRepos = 25 - options.length
          const displayRepos = filteredRepos.slice(0, maxOtherRepos)

          for (const r of displayRepos) {
            options.push(new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.name))
          }

          const select = new StringSelectMenuBuilder()
            .setCustomId(`select-repo:${thread.id}`)
            .setPlaceholder(threadConfig.messages.setup.repo_select_placeholder)
            .addOptions(options)

          const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
          await thread.send({
            content: threadConfig.messages.setup.configure_select_repo,
            components: [row],
          })
          return
        } else {
          await thread.send(threadConfig.messages.setup.no_connected_repos)
          return
        }
      } catch (err) {
        logger.error('Failed to load connected repos for selection:', err)
        await thread.send(threadConfig.messages.setup.load_repos_failed)
        return
      }
    }

    if (!repo) {
      await thread.send(threadConfig.messages.setup.no_default_repo)
      return
    }

    const repoName: string = repo
    const branchName = threadConfig.default_branch || 'main'
    const botEmoji = threadConfig.bot_emoji || '🐙'
    await thread.send(
      t(threadConfig.messages.session.initializing, {
        emoji: botEmoji,
        repo: repoName,
        branch: branchName,
      }),
    )

    try {
      await initializeJulesSession(thread, repoName, branchName, streamManager)
    } catch (err) {
      logger.error('Failed to start Jules session:', err)
      await thread.send(threadConfig.messages.session.start_failed)
    }
  },
}
