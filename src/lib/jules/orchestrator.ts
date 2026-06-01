import { ThreadChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Message } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import { StreamManager } from '../streams/StreamManager.js'
import { prisma, REACTIONS, AUTO_REJECT } from '../../config.js'

export const activeStreams = new Set<string>()
export const autoRejectedSessions = new Set<string>()


function parseEmojiForReaction(client: any, emojiStr: string): string {
  const trimmed = emojiStr.trim()
  // Match <:name:id> or <a:name:id>
  const match = trimmed.match(/^<a?:([a-zA-Z0-9_]+):([0-9]+)>$/)
  if (match) {
    return `${match[1]}:${match[2]}`
  }

  // Match raw name:id
  const rawMatch = trimmed.match(/^([a-zA-Z0-9_]+):([0-9]+)$/)
  if (rawMatch) {
    return trimmed
  }

  // Match raw ID
  if (/^[0-9]+$/.test(trimmed)) {
    const cachedEmoji = client.emojis.cache.get(trimmed)
    if (cachedEmoji) {
      return `${cachedEmoji.name}:${cachedEmoji.id}`
    }
    return trimmed
  }

  return trimmed
}

async function getLastHumanMessage(thread: ThreadChannel): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 20 })
    const sorted = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    const lastHuman = sorted.find((m) => !m.author.bot)
    return lastHuman || null
  } catch (err) {
    console.error('Failed to fetch last human message for reply:', err)
    return null
  }
}

async function updateReaction(message: Message | null, newStage: keyof typeof REACTIONS) {
  if (!message) return
  try {
    const botId = message.client.user?.id
    if (botId) {
      // Remove any existing bot reactions to clean up previous stages
      for (const reaction of message.reactions.cache.values()) {
        try {
          if (reaction.me) {
            await reaction.users.remove(botId)
          }
        } catch (err) {
          // Ignore removal errors
        }
      }
    }

    // Add new reaction emoji
    const emojiStr = REACTIONS[newStage]
    if (emojiStr) {
      const emoji = parseEmojiForReaction(message.client, emojiStr)
      await message.react(emoji)
    }
  } catch (err) {
    console.error(`Failed to update reaction to stage ${newStage}:`, err)
  }
}


export async function runJulesStream(sessionId: string, thread: ThreadChannel, streamManager: StreamManager) {
  if (activeStreams.has(thread.id)) return
  activeStreams.add(thread.id)

  let typingInterval: NodeJS.Timeout | null = null

  const startTyping = () => {
    if (typingInterval) return
    thread.sendTyping().catch(() => {})
    typingInterval = setInterval(() => {
      thread.sendTyping().catch(() => {})
    }, 8000)
  }

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval)
      typingInterval = null
    }
  }

  let starterMessage: Message | null = null
  try {
    starterMessage = await thread.fetchStarterMessage()
  } catch (err) {
    console.error(`Failed to fetch starter message for thread ${thread.id}:`, err)
  }

  const processedActivityIds = new Set<string>()
  let consecutiveFailures = 0
  const maxRetries = 20
  let retryDelay = 5000

  while (consecutiveFailures < maxRetries) {
    try {
      startTyping()
      const session = JulesClient.getSession(sessionId)

      // Wait until session is no longer queued to avoid 404 Not Found error on stream()
      let info = await session.info()
      if (info && info.state === 'queued') {
        await updateReaction(starterMessage, 'queued')
      }
      while (info && info.state === 'queued') {
        console.log(`Session ${sessionId} is queued. Waiting 5s...`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        info = await session.info()
      }

      await updateReaction(starterMessage, 'in_progress')

      for await (const activity of session.stream()) {
        const id = activity.id
        if (processedActivityIds.has(id)) {
          continue
        }
        processedActivityIds.add(id)
        consecutiveFailures = 0
        retryDelay = 5000

        const type = activity.type

        switch (type) {
          case 'planGenerated': {
            const plan = activity.plan || (activity as any).planGenerated?.plan
            if (!plan || !plan.steps) break

            stopTyping()

            const shouldAutoReject = AUTO_REJECT.enabled && !autoRejectedSessions.has(sessionId)
            if (shouldAutoReject) {
              autoRejectedSessions.add(sessionId)
              const feedback = AUTO_REJECT.message || 'Please revise the proposed plan.'
              await thread.send(`🤖 **Plan Automatically Rejected:**\nFeedback: "${feedback}"\nJules is revising the plan...`)
              await session.send(feedback)
              await updateReaction(starterMessage, 'in_progress')
              startTyping()
              break
            }

            await updateReaction(starterMessage, 'awaiting_plan_approval')

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
            // If we were awaiting approval, go back to in_progress on updates
            await updateReaction(starterMessage, 'in_progress')
            startTyping()
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
              const lastHuman = await getLastHumanMessage(thread)
              if (lastHuman) {
                await lastHuman.reply(message.slice(0, 2000))
              } else {
                await thread.send(message.slice(0, 2000))
              }
              stopTyping()
            }
            break
          }

          case 'sessionCompleted': {
            stopTyping()
            await updateReaction(starterMessage, 'completed')
            await streamManager.finalizeSession(thread.id, true)
            activeStreams.delete(thread.id)
            return
          }

          case 'sessionFailed': {
            stopTyping()
            await updateReaction(starterMessage, 'failed')
            const reason = activity.reason || (activity as any).sessionFailed?.reason || ''
            await streamManager.finalizeSession(thread.id, false, reason)
            activeStreams.delete(thread.id)
            return
          }
        }
      }

      break
    } catch (err: any) {
      consecutiveFailures++
      console.error(`[Stream Retry ${consecutiveFailures}/${maxRetries}] Error in Jules stream for thread ${thread.id}:`, err)

      if (consecutiveFailures >= maxRetries) {
        const errorMsg = err instanceof Error ? err.stack || err.message : String(err)
        await thread.send(`❌ **The diagnostic analysis session failed after multiple reconnection attempts:**\n\`\`\`ts\n${errorMsg.slice(0, 1800)}\n\`\`\``)
        break
      }

      console.log(`Reconnecting stream in ${retryDelay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
      retryDelay = Math.min(retryDelay * 1.5, 30000)
    } finally {
      stopTyping()
    }
  }

  activeStreams.delete(thread.id)
}
