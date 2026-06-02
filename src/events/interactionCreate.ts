import { Interaction, Events, ThreadChannel, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'
import { prisma, getEffectiveConfig } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams, busySessions, initializeJulesSession } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

import { hasPermission } from '../lib/utils/permissions.js'

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, streamManager: StreamManager) {
    if (interaction.isChatInputCommand()) {
      // Chat input commands are handled separately or via centralized router if needed
      return
    }

    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return

    // Check permission
    if (!await hasPermission(interaction.member, interaction.user, interaction.channel)) {
      await interaction.reply({ content: '❌ **You do not have permission to interact with this session.**', ephemeral: true })
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
        await interaction.reply({ content: '❌ Session not found.', ephemeral: true })
        return
      }

      try {
        const session = JulesClient.getSession(sessionRecord.julesSessionId)
        const thread = (await interaction.client.channels.fetch(threadId)) as ThreadChannel

        if (kind === 'plan-approve') {
          // Approve the plan
          await session.approve()

          // Mark session as busy
          busySessions.add(thread.id)

          // Rehydrate stream listener if not already active
          if (!activeStreams.has(thread.id)) {
            runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
          }

          await interaction.update({
            content: '✅ **Plan approved. Jules is continuing the diagnostic steps...**',
            components: [],
          })
        } else if (kind === 'plan-reject') {
          // Reject the plan (User must describe what they want next in the thread)
          await interaction.update({
            content: '❌ **Plan rejected. Please describe the changes or alternative approach you want Jules to take.**',
            components: [],
          })
        }
      } catch (err) {
        console.error(`Failed to process button interaction for thread ${threadId}:`, err)
        await interaction.reply({ content: '❌ **An error occurred while communicating with Jules.**', ephemeral: true })
      }
    }

    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(':')
      const kind = parts[0]
      const threadId = parts[1]
      if (!kind || !threadId) return

      try {
        const thread = (await interaction.client.channels.fetch(threadId)) as ThreadChannel

        if (kind === 'select-repo') {
          const repoName = interaction.values[0]
          await interaction.deferUpdate()

          // Find the selected repo branches
          const repos = await JulesClient.getConnectedRepos()
          const selectedRepo = repos.find(r => r.name === repoName)

          if (!selectedRepo) {
            await interaction.followUp({ content: '❌ Selected repository not found.', ephemeral: true })
            return
          }

          const branches = selectedRepo.branches || []
          if (branches.length === 0) {
            const branch = selectedRepo.defaultBranch || 'main'
            await interaction.editReply({
              content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${branch}\`...`,
              components: [],
            })

            await initializeJulesSession(thread, repoName, branch, streamManager)
          } else {
            const threadConfig = getEffectiveConfig(thread, interaction.member)
            const defaultBranch = threadConfig.default_branch || selectedRepo.defaultBranch || 'main'
            const options: StringSelectMenuOptionBuilder[] = []

            let hasDefault = false
            if (defaultBranch && branches.includes(defaultBranch)) {
              options.push(
                new StringSelectMenuOptionBuilder()
                  .setLabel(`⭐ Default: ${defaultBranch}`)
                  .setValue(defaultBranch)
              )
              hasDefault = true
            }

            const regularBranches = hasDefault
              ? branches.filter(b => b !== defaultBranch)
              : branches

            // If regular branches + default branch is > 25, we need search/custom branch options
            const needsSearch = (regularBranches.length + (hasDefault ? 1 : 0)) > 25

            if (needsSearch) {
              const maxRegularSlots = 25 - (hasDefault ? 1 : 0) - 2 // Leave 2 slots for Search and Custom
              const displayBranches = regularBranches.slice(0, maxRegularSlots)

              for (const b of displayBranches) {
                options.push(
                  new StringSelectMenuOptionBuilder()
                    .setLabel(b)
                    .setValue(b)
                )
              }

              options.push(
                new StringSelectMenuOptionBuilder()
                  .setLabel('🔍 Search Branches...')
                  .setValue('search-branch-prompt'),
                new StringSelectMenuOptionBuilder()
                  .setLabel('✍️ Enter Custom Branch...')
                  .setValue('custom-branch-input')
              )
            } else {
              for (const b of regularBranches) {
                options.push(
                  new StringSelectMenuOptionBuilder()
                    .setLabel(b)
                    .setValue(b)
                )
              }
            }

            const branchSelect = new StringSelectMenuBuilder()
              .setCustomId(`select-branch:${thread.id}:${repoName}`)
              .setPlaceholder('Choose a branch...')
              .addOptions(options)

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
            await interaction.editReply({
              content: `📋 **Configure Jules Diagnostic Session**\nSelected Repository: \`${repoName}\`\nPlease select the branch to work on:`,
              components: [row],
            })
          }
        } else if (kind === 'select-branch') {
          const repoName = parts.slice(2).join(':')
          const branchName = interaction.values[0]

          if (branchName === 'search-branch-prompt') {
            const modal = new ModalBuilder()
              .setCustomId(`modal-search-branch:${thread.id}:${repoName}`)
              .setTitle('Search Branches')

            const queryInput = new TextInputBuilder()
              .setCustomId('search-query')
              .setLabel('Branch Name or Search Keyword')
              .setRequired(true)
              .setPlaceholder('e.g. feature/auth, main, develop')
              .setStyle(TextInputStyle.Short)

            const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(queryInput)
            modal.addComponents(actionRow)

            await interaction.showModal(modal)
            return
          }

          if (branchName === 'custom-branch-input') {
            const modal = new ModalBuilder()
              .setCustomId(`modal-branch:${thread.id}:${repoName}`)
              .setTitle('Enter Custom Branch')

            const branchInput = new TextInputBuilder()
              .setCustomId('branch-input')
              .setLabel('Exact Branch Name')
              .setRequired(true)
              .setPlaceholder('e.g. feature/cool-stuff')
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
              await interaction.editReply({ content: '❌ Selected repository not found.', components: [] })
              return
            }

            const branches = selectedRepo.branches || []
            const threadConfig = getEffectiveConfig(thread, interaction.member)
            const defaultBranch = threadConfig.default_branch || selectedRepo.defaultBranch || 'main'
            const options: StringSelectMenuOptionBuilder[] = []

            let hasDefault = false
            if (defaultBranch && branches.includes(defaultBranch)) {
              options.push(
                new StringSelectMenuOptionBuilder()
                  .setLabel(`⭐ Default: ${defaultBranch}`)
                  .setValue(defaultBranch)
              )
              hasDefault = true
            }

            const regularBranches = hasDefault
              ? branches.filter(b => b !== defaultBranch)
              : branches

            const needsSearch = (regularBranches.length + (hasDefault ? 1 : 0)) > 25

            if (needsSearch) {
              const maxRegularSlots = 25 - (hasDefault ? 1 : 0) - 2
              const displayBranches = regularBranches.slice(0, maxRegularSlots)

              for (const b of displayBranches) {
                options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
              }

              options.push(
                new StringSelectMenuOptionBuilder().setLabel('🔍 Search Branches...').setValue('search-branch-prompt'),
                new StringSelectMenuOptionBuilder().setLabel('✍️ Enter Custom Branch...').setValue('custom-branch-input')
              )
            } else {
              for (const b of regularBranches) {
                options.push(new StringSelectMenuOptionBuilder().setLabel(b).setValue(b))
              }
            }

            const branchSelect = new StringSelectMenuBuilder()
              .setCustomId(`select-branch:${thread.id}:${repoName}`)
              .setPlaceholder('Choose a branch...')
              .addOptions(options)

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
            await interaction.editReply({
              content: `📋 **Configure Jules Diagnostic Session**\nSelected Repository: \`${repoName}\`\nPlease select the branch to work on:`,
              components: [row],
            })
            return
          }

          await interaction.update({
            content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${branchName}\`...`,
            components: [],
          })

          await initializeJulesSession(thread, repoName, branchName, streamManager)
        }
      } catch (err) {
        console.error(`Failed to process select interaction for thread ${threadId}:`, err)
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ **An error occurred while setting up the session.**', ephemeral: true })
          } else {
            await interaction.followUp({ content: '❌ **An error occurred while setting up the session.**', ephemeral: true })
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

        if (kind === 'modal-branch') {
          const branchName = interaction.fields.getTextInputValue('branch-input')

          if (interaction.isFromMessage()) {
            await interaction.update({
              content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${branchName}\`...`,
              components: [],
            })
          } else {
            await interaction.reply({
              content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${branchName}\`...`,
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
              await interaction.followUp({ content: '❌ Selected repository not found.', ephemeral: true })
            } else {
              await interaction.editReply({ content: '❌ Selected repository not found.' })
            }
            return
          }

          const branches = selectedRepo.branches || []
          
          // Check for exact case-insensitive match
          const exactMatch = branches.find(b => b === query || b.toLowerCase() === query.toLowerCase())
          if (exactMatch) {
            if (interaction.isFromMessage()) {
              await interaction.editReply({
                content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${exactMatch}\`...`,
                components: [],
              })
            } else {
              await interaction.editReply({
                content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${exactMatch}\`...`,
              })
            }
            await initializeJulesSession(thread, repoName, exactMatch, streamManager)
            return
          }

          const filteredBranches = branches.filter(b => b.toLowerCase().includes(query.toLowerCase()))

          if (filteredBranches.length === 0) {
            if (interaction.isFromMessage()) {
              await interaction.followUp({
                content: `❌ **No branches matched your search query "${query}".** Please try again.`,
                ephemeral: true,
              })
            } else {
              await interaction.editReply({
                content: `❌ **No branches matched your search query "${query}".** Please try again.`,
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
              .setLabel('🔍 Search Again...')
              .setValue('search-branch-prompt'),
            new StringSelectMenuOptionBuilder()
              .setLabel('❌ Clear Search / Reset')
              .setValue('clear-search')
          )

          const branchSelect = new StringSelectMenuBuilder()
            .setCustomId(`select-branch:${thread.id}:${repoName}`)
            .setPlaceholder(`Search results for "${query}"...`)
            .addOptions(options)

          const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
          if (interaction.isFromMessage()) {
            await interaction.editReply({
              content: `📋 **Configure Jules Diagnostic Session**\nSelected Repository: \`${repoName}\` (Search results for: \`${query}\`)\nPlease select the branch to work on:`,
              components: [row],
            })
          } else {
            await interaction.editReply({
              content: `📋 **Configure Jules Diagnostic Session**\nSelected Repository: \`${repoName}\` (Search results for: \`${query}\`)\nPlease select the branch to work on:`,
              components: [row],
            })
          }
        }
      } catch (err) {
        console.error(`Failed to process modal submit for thread ${threadId}:`, err)
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ **An error occurred while setting up the session.**', ephemeral: true })
          } else {
            await interaction.followUp({ content: '❌ **An error occurred while setting up the session.**', ephemeral: true })
          }
        } catch (apiErr) {
          console.error('Failed to send error reply to expired interaction:', apiErr)
        }
      }
    }
  },
}
