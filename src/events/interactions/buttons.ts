import { logger } from '../../lib/utils/logger.js'
import type { ButtonInteraction, ThreadChannel } from 'discord.js'
import { prisma, getEffectiveConfig, MESSAGES } from '../../config.js'
import { JulesClient } from '../../lib/jules/JulesClient.js'
import {
  runJulesStream,
  activeStreams,
  scheduleJulesRequest,
  wakeJulesStream,
} from '../../lib/jules/orchestrator.js'
import type { StreamManager } from '../../lib/streams/StreamManager.js'

// Plan approve/reject buttons embedded in the planGenerated embed.
export async function handleButtonInteraction(
  interaction: ButtonInteraction,
  streamManager: StreamManager,
) {
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
      // A shared Jules cooldown can legitimately last longer than Discord's
      // interaction acknowledgement window, so acknowledge first.
      await interaction.deferUpdate()
      await scheduleJulesRequest(() => session.approve())
      wakeJulesStream(thread.id)

      thread.sendTyping().catch(() => {})

      // Rehydrate stream listener if not already active
      if (!activeStreams.has(thread.id)) {
        runJulesStream(sessionRecord.julesSessionId, thread, streamManager)
      }

      await interaction.editReply({
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
    logger.error(`Failed to process button interaction for thread ${threadId}:`, err)
    await interaction.reply({
      content: MESSAGES.errors.jules_communication_error,
      ephemeral: true,
    })
  }
}
