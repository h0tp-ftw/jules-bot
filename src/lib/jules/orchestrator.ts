import { ThreadChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import { StreamManager } from '../streams/StreamManager.js'
import { prisma } from '../../config.js'

export const activeStreams = new Set<string>()

export async function runJulesStream(sessionId: string, thread: ThreadChannel, streamManager: StreamManager) {
  if (activeStreams.has(thread.id)) return
  activeStreams.add(thread.id)

  try {
    const session = JulesClient.getSession(sessionId)

    // Wait until session is no longer queued to avoid 404 Not Found error on stream()
    let info = await session.info()
    while (info && info.state === 'queued') {
      console.log(`Session ${sessionId} is queued. Waiting 5s...`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      info = await session.info()
    }

    for await (const activity of session.stream()) {
      const type = activity.type

      switch (type) {
        case 'planGenerated': {
          const plan = activity.plan || (activity as any).planGenerated?.plan
          if (!plan || !plan.steps) break

          const stepsText = plan.steps
            .map((step: any, i: number) => `**${i + 1}.** ${step.title}`)
            .join('\n')

          const embed = new EmbedBuilder()
            .setTitle('🐙 Jules Proposed Diagnostic Plan')
            .setDescription(stepsText.slice(0, 4000) || 'No details provided.')
            .setColor(0x00ae86)

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`plan-approve:${thread.id}`)
              .setLabel('Approve Plan')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`plan-reject:${thread.id}`)
              .setLabel('Reject Plan')
              .setStyle(ButtonStyle.Danger)
          )

          const msg = await thread.send({
            embeds: [embed],
            components: [row],
          })

          await prisma.debugSession.update({
            where: { threadId: thread.id },
            data: { planMessageId: msg.id },
          })
          break
        }

        case 'progressUpdated': {
          const title = activity.title || (activity as any).progressUpdated?.title || ''
          const description = activity.description || (activity as any).progressUpdated?.description || ''
          const logLine = description ? `${title}\n${description}` : title
          if (logLine) {
            await streamManager.handleProgress(thread.id, logLine)
          }
          break
        }

        case 'agentMessaged': {
          const message = activity.message || (activity as any).agentMessaged?.message || ''
          if (message) {
            await thread.send(message.slice(0, 2000))
          }
          break
        }

        case 'sessionCompleted': {
          await streamManager.finalizeSession(thread.id, true)
          activeStreams.delete(thread.id)
          return
        }

        case 'sessionFailed': {
          const reason = activity.reason || (activity as any).sessionFailed?.reason || ''
          await streamManager.finalizeSession(thread.id, false, reason)
          activeStreams.delete(thread.id)
          return
        }
      }
    }
  } catch (err) {
    console.error(`Error in Jules stream for thread ${thread.id}:`, err)
    await thread.send('⚠️ **An error occurred during the diagnostic analysis session.**')
  } finally {
    activeStreams.delete(thread.id)
  }
}
