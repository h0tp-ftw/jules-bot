import { Interaction, Events, ThreadChannel } from 'discord.js'
import { prisma } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams, busySessions } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

import { hasPermission } from '../lib/utils/permissions.js'

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, streamManager: StreamManager) {
    if (interaction.isChatInputCommand()) {
      // Chat input commands are handled separately or via centralized router if needed
      return
    }

    if (!interaction.isButton()) return

    // Check permission
    if (!await hasPermission(interaction.member, interaction.user, interaction.channel)) {
      await interaction.reply({ content: '❌ **You do not have permission to interact with this session.**', ephemeral: true })
      return
    }

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
  },
}
