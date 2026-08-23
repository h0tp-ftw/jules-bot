import { logger } from '../../lib/utils/logger.js'
import type { StringSelectMenuInteraction, ThreadChannel } from 'discord.js'
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'
import { getEffectiveConfig, MESSAGES } from '../../config.js'
import { t } from '../../strings.js'
import { JulesClient } from '../../lib/jules/JulesClient.js'
import { initializeJulesSession } from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'
import { buildBranchSelectRow } from './branchSelect.js'

// Repo and branch selection dropdowns used during session setup.
export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
  streamManager: StreamManager,
) {
  const parts = interaction.customId.split(':')
  const kind = parts[0]
  const threadId = parts[1]
  if (!kind || !threadId) return

  try {
    const thread = (await interaction.client.channels.fetch(threadId)) as ThreadChannel
    const threadConfig = getEffectiveConfig(thread, interaction.member)
    const msgs = threadConfig.messages

    if (kind === 'select-repo') {
      const repoName = interaction.values[0]
      await interaction.deferUpdate()

      // Find the selected repo branches
      const repos = await JulesClient.getConnectedRepos()
      const selectedRepo = repos.find((r) => r.name === repoName)

      if (!selectedRepo) {
        await interaction.followUp({ content: msgs.errors.repo_not_found, ephemeral: true })
        return
      }

      const branches = selectedRepo.branches || []
      const botEmoji = threadConfig.bot_emoji || '🐙'
      if (branches.length === 0) {
        const branch = selectedRepo.defaultBranch || 'main'
        await interaction.editReply({
          content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch }),
          components: [],
        })

        await initializeJulesSession(thread, repoName, branch, streamManager)
      } else {
        const defaultBranch = threadConfig.default_branch || selectedRepo.defaultBranch || 'main'
        const row = buildBranchSelectRow(thread.id, repoName, branches, defaultBranch, msgs)
        await interaction.editReply({
          content: t(msgs.setup.configure_select_branch, { repo: repoName }),
          components: [row],
        })
      }
    } else if (kind === 'select-branch') {
      const repoName = parts.slice(2).join(':')
      const branchName = interaction.values[0]

      if (branchName === 'search-branch-prompt') {
        const modal = new ModalBuilder()
          .setCustomId(`modal-search-branch:${thread.id}:${repoName}`)
          .setTitle(msgs.setup.search_modal_title)

        const queryInput = new TextInputBuilder()
          .setCustomId('search-query')
          .setLabel(msgs.setup.search_modal_input_label)
          .setRequired(true)
          .setPlaceholder(msgs.setup.search_modal_input_placeholder)
          .setStyle(TextInputStyle.Short)

        const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(queryInput)
        modal.addComponents(actionRow)

        await interaction.showModal(modal)
        return
      }

      if (branchName === 'custom-branch-input') {
        const modal = new ModalBuilder()
          .setCustomId(`modal-branch:${thread.id}:${repoName}`)
          .setTitle(msgs.setup.custom_branch_modal_title)

        const branchInput = new TextInputBuilder()
          .setCustomId('branch-input')
          .setLabel(msgs.setup.custom_branch_modal_input_label)
          .setRequired(true)
          .setPlaceholder(msgs.setup.custom_branch_modal_input_placeholder)
          .setStyle(TextInputStyle.Short)

        const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(branchInput)
        modal.addComponents(actionRow)

        await interaction.showModal(modal)
        return
      }

      if (branchName === 'clear-search') {
        await interaction.deferUpdate()

        // Rebuild default branch dropdown resetting search
        const repos = await JulesClient.getConnectedRepos()
        const selectedRepo = repos.find((r) => r.name === repoName)

        if (!selectedRepo) {
          await interaction.editReply({ content: msgs.errors.repo_not_found, components: [] })
          return
        }

        const branches = selectedRepo.branches || []
        const defaultBranch = threadConfig.default_branch || selectedRepo.defaultBranch || 'main'
        const row = buildBranchSelectRow(thread.id, repoName, branches, defaultBranch, msgs)
        await interaction.editReply({
          content: t(msgs.setup.configure_select_branch, { repo: repoName }),
          components: [row],
        })
        return
      }

      const botEmoji = threadConfig.bot_emoji || '🐙'
      await interaction.update({
        content: t(msgs.session.initializing, {
          emoji: botEmoji,
          repo: repoName,
          branch: branchName,
        }),
        components: [],
      })

      await initializeJulesSession(thread, repoName, branchName, streamManager)
    }
  } catch (err) {
    logger.error(`Failed to process select interaction for thread ${threadId}:`, err)
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
