import { Interaction, Events, ThreadChannel, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'
import { prisma, getEffectiveConfig, MESSAGES } from '../config.js'
import { t, type Messages } from '../strings.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams, initializeJulesSession } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

import { hasPermission } from '../lib/utils/permissions.js'

/**
 * Builds the branch-selection dropdown row for a repo. Lists the default branch
 * first (when present), then the remaining branches; if they would exceed
 * Discord's 25-option cap, trims and appends Search/Custom entries.
 */
function buildBranchSelectRow(
  threadId: string,
  repoName: string,
  branches: string[],
  defaultBranch: string,
  messages: Messages,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options: StringSelectMenuOptionBuilder[] = []

  let hasDefault = false
  if (defaultBranch && branches.includes(defaultBranch)) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(t(messages.setup.default_branch_option, { branch: defaultBranch }))
        .setValue(defaultBranch)
    )
    hasDefault = true
  }

  const regularBranches = hasDefault
    ? branches.filter(b => b !== defaultBranch)
    : branches

  // If the default + regular branches exceed Discord's 25-option cap, trim and
  // leave room for the Search and Custom entries.
  const needsSearch = (regularBranches.length + (hasDefault ? 1 : 0)) > 25

  if (needsSearch) {
    const maxRegularSlots = 25 - (hasDefault ? 1 : 0) - 2
    const displayBranches = regularBranches.slice(0, maxRegularSlots)
    for (const b of displayBranches) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
    }
    options.push(
      new StringSelectMenuOptionBuilder().setLabel(messages.setup.search_branches_option).setValue('search-branch-prompt'),
      new StringSelectMenuOptionBuilder().setLabel(messages.setup.custom_branch_option).setValue('custom-branch-input')
    )
  } else {
    for (const b of regularBranches) {
      options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
    }
  }

  const branchSelect = new StringSelectMenuBuilder()
    .setCustomId(`select-branch:${threadId}:${repoName}`)
    .setPlaceholder(messages.setup.branch_select_placeholder)
    .addOptions(options)

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, streamManager: StreamManager) {
    if (interaction.isChatInputCommand()) {
      // Chat input commands are handled separately or via centralized router if needed
      return
    }

    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return

    // Check permission. hasPermission resolves to an object, so a bare
    // `!await hasPermission(...)` is ALWAYS false (objects are truthy) — which
    // previously let any user who could see the buttons/menus drive plan
    // approval and repo/branch selection regardless of the allowlist. Destructure
    // `authorized` like the other call sites (index.ts, messageCreate.ts).
    const { authorized } = await hasPermission(interaction.member, interaction.user, interaction.channel)
    if (!authorized) {
      await interaction.reply({ content: MESSAGES.errors.no_permission_interaction, ephemeral: true })
      return
    }

    if (interaction.isButton()) {
      const [kind, threadId] = interaction.customId.split(':')
      if (!kind || !threadId) return

      // Get session record
      const sessionRecord = await prisma.debugSession.findUnique({
        where: { threadId },
      })

      if (!sessionRecord) {
        await interaction.reply({ content: MESSAGES.errors.session_not_found, ephemeral: true })
        return
      }

      try {
        const session = JulesClient.getSession(sessionRecord.julesSessionId)
        const thread = (await interaction.client.channels.fetch(threadId)) as ThreadChannel
        const msgs = getEffectiveConfig(thread, interaction.member).messages

        if (kind === 'plan-approve') {
          // Approve the plan
          await session.approve()

          thread.sendTyping().catch(() => {})

          // Rehydrate stream listener if not already active
          if (!activeStreams.has(thread.id)) {
            runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
          }

          await interaction.update({
            content: msgs.plan.approved,
            components: [],
          })
        } else if (kind === 'plan-reject') {
          // Rejecting a plan = don't approve and wait for the user's feedback. The
          // follow-up message is what actually tells Jules to revise (session.send
          // while awaiting approval). Make sure the stream listener is alive (e.g.
          // after a restart) so the revised response is streamed back to the thread.
          if (!activeStreams.has(thread.id)) {
            runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
          }
          await interaction.update({
            content: msgs.plan.rejected,
            components: [],
          })
        }
      } catch (err) {
        console.error(`Failed to process button interaction for thread ${threadId}:`, err)
        await interaction.reply({ content: MESSAGES.errors.jules_communication_error, ephemeral: true })
      }
    }

    if (interaction.isStringSelectMenu()) {
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
          const selectedRepo = repos.find(r => r.name === repoName)

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
            const selectedRepo = repos.find(r => r.name === repoName)

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
            content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch: branchName }),
            components: [],
          })

          await initializeJulesSession(thread, repoName, branchName, streamManager)
        }
      } catch (err) {
        console.error(`Failed to process select interaction for thread ${threadId}:`, err)
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: MESSAGES.errors.session_setup_error, ephemeral: true })
          } else {
            await interaction.followUp({ content: MESSAGES.errors.session_setup_error, ephemeral: true })
          }
        } catch (apiErr) {
          console.error('Failed to send error reply to expired interaction:', apiErr)
        }
      }
    }

    if (interaction.isModalSubmit()) {
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
              content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch: branchName }),
              components: [],
            })
          } else {
            await interaction.reply({
              content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch: branchName }),
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
          const selectedRepo = repos.find(r => r.name === repoName)

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
          const exactMatch = branches.find(b => b === query || b.toLowerCase() === query.toLowerCase())
          if (exactMatch) {
            const botEmoji = threadConfig.bot_emoji || '🐙'
            if (interaction.isFromMessage()) {
              await interaction.editReply({
                content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch: exactMatch }),
                components: [],
              })
            } else {
              await interaction.editReply({
                content: t(msgs.session.initializing, { emoji: botEmoji, repo: repoName, branch: exactMatch }),
              })
            }
            await initializeJulesSession(thread, repoName, exactMatch, streamManager)
            return
          }

          const filteredBranches = branches.filter(b => b.toLowerCase().includes(query.toLowerCase()))

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
            options.push(
              new StringSelectMenuOptionBuilder()
                .setLabel(b)
                .setValue(b)
            )
          }

          options.push(
            new StringSelectMenuOptionBuilder()
              .setLabel(msgs.setup.search_again_option)
              .setValue('search-branch-prompt'),
            new StringSelectMenuOptionBuilder()
              .setLabel(msgs.setup.clear_search_option)
              .setValue('clear-search')
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
        console.error(`Failed to process modal submit for thread ${threadId}:`, err)
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: MESSAGES.errors.session_setup_error, ephemeral: true })
          } else {
            await interaction.followUp({ content: MESSAGES.errors.session_setup_error, ephemeral: true })
          }
        } catch (apiErr) {
          console.error('Failed to send error reply to expired interaction:', apiErr)
        }
      }
    }
  },
}
