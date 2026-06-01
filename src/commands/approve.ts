import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'
import { prisma } from '../config.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

export default {
  data: new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve the proposed plan for this diagnostic session'),
  async execute(interaction: ChatInputCommandInteraction, streamManager: StreamManager) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true })
      return
    }

    const thread = interaction.channel
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: '❌ This command can only be used inside a Jules diagnostic thread.',
        ephemeral: true,
      })
      return
    }

    // Get session record
    const sessionRecord = await prisma.debugSession.findUnique({
      where: { threadId: thread.id },
    })

    if (!sessionRecord) {
      await interaction.reply({
        content: '❌ No active Jules session found for this thread.',
        ephemeral: true,
      })
      return
    }

    await interaction.deferReply()

    try {
      const session = JulesClient.getSession(sessionRecord.julesSessionId)
      const info = await session.info()

      if (info.state !== 'awaitingPlanApproval') {
        await interaction.editReply({
          content: `❌ **Cannot approve plan.** Current session state is \`${info.state}\` (needs to be \`awaitingPlanApproval\`).`,
        })
        return
      }

      // Approve the plan
      await session.approve()

      // Rehydrate stream listener if not already active
      if (!activeStreams.has(thread.id)) {
        runJulesStream(sessionRecord.julesSessionId, thread as any, streamManager)
      }

      await interaction.editReply({
        content: '✅ **Plan approved via slash command! Jules is continuing the diagnostic steps...**',
      })
    } catch (err) {
      console.error(`Failed to approve plan via command for thread ${thread.id}:`, err)
      await interaction.editReply({
        content: '❌ **Failed to approve plan. An error occurred while communicating with Jules.**',
      })
    }
  },
}
