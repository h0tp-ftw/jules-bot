import { logger } from '../../lib/utils/logger.js'
import type { ModalSubmitInteraction, ThreadChannel } from 'discord.js'
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js'
import { getEffectiveConfig, MESSAGES } from '../../config.js'
import { t } from '../../strings.js'
import { JulesClient } from '../../lib/jules/JulesClient.js'
import { initializeJulesSession } from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'

// Custom-branch input and branch-search modal submissions.
export async function handleModalSubmitInteraction(
  interaction: ModalSubmitInteraction,
  streamManager: StreamManager,
) {
  const parts = interaction.customId.split(':')
  const kind = parts[0]
  const threadId = parts[1]
  if (!kind || !threadId) return

  try {
    const thread = (await interaction.client.channels.fetch(threadId)) as ThreadChannel
    const repoName = parts.slice(2).join(':')
    const threadConfig = getEffectiveConfig(thread, interaction.member)
    const msgs = threadConfig.messages

    if (kind === 'modal-branch') {
      const branchName = interaction.fields.getTextInputValue('branch-input')
      const botEmoji = threadConfig.bot_emoji || '🐙'

      if (interaction.isFromMessage()) {
        await interaction.update({
          content: t(msgs.session.initializing, {
            emoji: botEmoji,
            repo: repoName,
            branch: branchName,
          }),
          components: [],
        })
      } else {
        await interaction.reply({
          content: t(msgs.session.initializing, {
            emoji: botEmoji,
            repo: repoName,
            branch: branchName,
          }),
          ephemeral: true,
        })
      }

      await initializeJulesSession(thread, repoName, branchName, streamManager)
    } else if (kind === 'modal-search-branch') {
      const query = interaction.fields.getTextInputValue('search-query')

      if (interaction.isFromMessage()) {
        await interaction.deferUpdate()
      } else {
        await interaction.deferReply({ ephemeral: true })
      }

      // Find the selected repo branches
      const repos = await JulesClient.getConnectedRepos()
      const selectedRepo = repos.find((r) => r.name === repoName)

      if (!selectedRepo) {
        if (interaction.isFromMessage()) {
          await interaction.followUp({ content: msgs.errors.repo_not_found, ephemeral: true })
        } else {
          await interaction.editReply({ content: msgs.errors.repo_not_found })
        }
        return
      }

      const branches = selectedRepo.branches || []

      // Check for exact case-insensitive match
      const exactMatch = branches.find(
        (b) => b === query || b.toLowerCase() === query.toLowerCase(),
      )
      if (exactMatch) {
        const botEmoji = threadConfig.bot_emoji || '🐙'
        if (interaction.isFromMessage()) {
          await interaction.editReply({
            content: t(msgs.session.initializing, {
              emoji: botEmoji,
              repo: repoName,
              branch: exactMatch,
            }),
            components: [],
          })
        } else {
          await interaction.editReply({
            content: t(msgs.session.initializing, {
              emoji: botEmoji,
              repo: repoName,
              branch: exactMatch,
            }),
          })
        }
        await initializeJulesSession(thread, repoName, exactMatch, streamManager)
        return
      }

      const filteredBranches = branches.filter((b) => b.toLowerCase().includes(query.toLowerCase()))

      if (filteredBranches.length === 0) {
        if (interaction.isFromMessage()) {
          await interaction.followUp({
            content: t(msgs.setup.no_branches_matched, { query }),
            ephemeral: true,
          })
        } else {
          await interaction.editReply({
            content: t(msgs.setup.no_branches_matched, { query }),
          })
        }
        return
      }

      const options: StringSelectMenuOptionBuilder[] = []
      const maxFiltered = 23 // Leave 2 slots for Search Again and Reset
      const displayBranches = filteredBranches.slice(0, maxFiltered)

      for (const b of displayBranches) {
        options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
      }

      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(msgs.setup.search_again_option)
          .setValue('search-branch-prompt'),
        new StringSelectMenuOptionBuilder()
          .setLabel(msgs.setup.clear_search_option)
          .setValue('clear-search'),
      )

      const branchSelect = new StringSelectMenuBuilder()
        .setCustomId(`select-branch:${thread.id}:${repoName}`)
        .setPlaceholder(t(msgs.setup.branch_search_results_placeholder, { query }))
        .addOptions(options)

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
      if (interaction.isFromMessage()) {
        await interaction.editReply({
          content: t(msgs.setup.configure_select_branch_search, { repo: repoName, query }),
          components: [row],
        })
      } else {
        await interaction.editReply({
          content: t(msgs.setup.configure_select_branch_search, { repo: repoName, query }),
          components: [row],
        })
      }
    }
  } catch (err) {
    logger.error(`Failed to process modal submit for thread ${threadId}:`, err)
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: MESSAGES.errors.session_setup_error,
          ephemeral: true,
        })
      } else {
        await interaction.followUp({
          content: MESSAGES.errors.session_setup_error,
          ephemeral: true,
        })
      }
    } catch (apiErr) {
      logger.error('Failed to send error reply to expired interaction:', apiErr)
    }
  }
}
