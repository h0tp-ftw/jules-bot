import { logger } from '../lib/utils/logger.js'
import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'
import { prisma, getEffectiveConfig, MESSAGES } from '../config.js'
import { t } from '../strings.js'
import { JulesClient } from '../lib/jules/JulesClient.js'
import { runJulesStream, activeStreams } from '../lib/jules/orchestrator.js'
import { StreamManager } from '../lib/streams/StreamManager.js'

export default {
  data: new SlashCommandBuilder()
    .setName('approve')
    .setDescription(MESSAGES.commands.approve_description),
  async execute(interaction: ChatInputCommandInteraction, streamManager: StreamManager) {
    if (!interaction.guildId) {
      await interaction.reply({ content: MESSAGES.errors.guild_only, ephemeral: true })
      return
    }

    const thread = interaction.channel
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: MESSAGES.commands.approve_thread_only,
        ephemeral: true,
      })
      return
    }

    const msgs = getEffectiveConfig(thread, interaction.member).messages

    // Get session record
    const sessionRecord = await prisma.debugSession.findUnique({
      where: { threadId: thread.id },
    })

    if (!sessionRecord) {
      await interaction.reply({
        content: msgs.commands.approve_no_active_session,
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
          content: t(msgs.commands.approve_cannot_approve_state, { state: info.state }),
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
        content: msgs.plan.approved_via_command,
      })
    } catch (err) {
      logger.error(`Failed to approve plan via command for thread ${thread.id}:`, err)
      await interaction.editReply({
        content: msgs.commands.approve_failed,
      })
    }
  },
}
