import { Interaction, Events, ThreadChannel, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder } from 'discord.js'
import { prisma } from '../config.js'
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

    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return

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
            const branchSelect = new StringSelectMenuBuilder()
              .setCustomId(`select-branch:${thread.id}:${repoName}`)
              .setPlaceholder('Choose a branch...')
              .addOptions(
                branches.slice(0, 25).map(b => 
                  new StringSelectMenuOptionBuilder()
                    .setLabel(b)
                    .setValue(b)
                )
              )

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(branchSelect)
            await interaction.editReply({
              content: `📋 **Configure Jules Diagnostic Session**\nSelected Repository: \`${repoName}\`\nPlease select the branch to work on:`,
              components: [row],
            })
          }
        } else if (kind === 'select-branch') {
          const repoName = parts.slice(2).join(':')
          const branchName = interaction.values[0]

          await interaction.update({
            content: `🐙 **Initializing diagnostic Jules session...**\nRunning analysis against repository: \`${repoName}\` on branch \`${branchName}\`...`,
            components: [],
          })

          await initializeJulesSession(thread, repoName, branchName, streamManager)
        }
      } catch (err) {
        console.error(`Failed to process select interaction for thread ${threadId}:`, err)
        await interaction.reply({ content: '❌ **An error occurred while setting up the session.**', ephemeral: true })
      }
    }
  },
}
