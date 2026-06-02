import { ThreadChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Message } from 'discord.js'
import { JulesClient } from './JulesClient.js'
import { StreamManager } from '../streams/StreamManager.js'
import { prisma, getEffectiveConfig, yamlConfig } from '../../config.js'
import { replenishPool } from './PreWarmedManager.js'
import { processAttachments } from '../utils/docling.js'
import { resolveMessageEmojis } from '../utils/emojis.js'

export const activeStreams = new Set<string>()
export const autoRejectedSessions = new Set<string>()
export const busySessions = new Set<string>()
export interface QueuedMessage {
  authorNickname: string
  messageTime: string
  content: string
}
export const queuedMessages = new Map<string, QueuedMessage[]>()


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

export async function getLastHumanMessage(thread: ThreadChannel): Promise<Message | null> {
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

export async function updateReaction(message: Message | null, newStage: string) {
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
    const threadConfig = getEffectiveConfig(message.channel, message.member)
    const reactions = threadConfig.reactions || {}
    const emojiStr = reactions[newStage]
    if (emojiStr) {
      const emoji = parseEmojiForReaction(message.client, emojiStr)
      await message.react(emoji)
    }
  } catch (err) {
    console.error(`Failed to update reaction to stage ${newStage}:`, err)
  }
}


export async function runJulesStream(sessionId: string, thread: ThreadChannel, streamManager: StreamManager, initialProcessedIds?: Set<string>) {
  if (activeStreams.has(thread.id)) return
  activeStreams.add(thread.id)
  busySessions.add(thread.id)

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

  const processedActivityIds = initialProcessedIds || new Set<string>()
  let consecutiveFailures = 0
  const maxRetries = 20
  let retryDelay = 5000

  while (consecutiveFailures < maxRetries) {
    try {
      startTyping()
      const session = JulesClient.getSession(sessionId)

      // Wait until session is no longer queued to avoid 404 Not Found error on stream()
      let info = await session.info()
      if (info && (info.state === 'completed' || info.state === 'failed')) {
        console.log(`Session ${sessionId} is already ${info.state}. Exiting stream handler.`)
        stopTyping()
        activeStreams.delete(thread.id)
        return
      }
      if (info && info.state === 'queued') {
        const targetMessage = await getLastHumanMessage(thread)
        await updateReaction(targetMessage, 'queued')
      }
      while (info && info.state === 'queued') {
        console.log(`Session ${sessionId} is queued. Waiting 5s...`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        info = await session.info()
      }

      const targetMessage = await getLastHumanMessage(thread)
      await updateReaction(targetMessage, 'in_progress')

      let agentMessagedInThisTurn = false

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

            const lastHuman = await getLastHumanMessage(thread)
            const threadConfig = getEffectiveConfig(thread, lastHuman?.member)
            const autoReject = threadConfig.auto_reject || {}
            const shouldAutoReject = autoReject.enabled && !autoRejectedSessions.has(sessionId)
            if (shouldAutoReject) {
              autoRejectedSessions.add(sessionId)
              const feedback = autoReject.message || 'Please do not create or refine an implementation plan. Instead, just talk directly with me to understand the goals and discuss the issue.'
              await thread.send(`🤖 **Plan Automatically Rejected:**\nFeedback: "${feedback}"\nJules is revising the plan...`)
              await session.send(feedback)
              const target = await getLastHumanMessage(thread)
              await updateReaction(target, 'in_progress')
              break
            }

            const target = await getLastHumanMessage(thread)
            await updateReaction(target, 'awaiting_plan_approval')
            busySessions.delete(thread.id)

            const stepsText = plan.steps
              .map((step: any, i: number) => `**${i + 1}.** ${step.title}`)
              .join('\n')

            const embed = new EmbedBuilder()
              .setTitle(`${threadConfig.bot_emoji || '🐙'} Jules Proposed Diagnostic Plan`)
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
            const target = await getLastHumanMessage(thread)
            await updateReaction(target, 'in_progress')
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
              agentMessagedInThisTurn = true
              const resolved = resolveMessageEmojis(thread.client, message)
              const lastHuman = await getLastHumanMessage(thread)
              if (lastHuman) {
                await lastHuman.reply(resolved.slice(0, 2000))
              } else {
                await thread.send(resolved.slice(0, 2000))
              }
            }
            break
          }

          case 'sessionCompleted': {
            const target = await getLastHumanMessage(thread)
            await updateReaction(target, 'completed')
            await streamManager.finalizeSession(thread.id, true)
            activeStreams.delete(thread.id)
            busySessions.delete(thread.id)
            queuedMessages.delete(thread.id)
            stopTyping()
            return
          }

          case 'sessionFailed': {
            const target = await getLastHumanMessage(thread)
            await updateReaction(target, 'failed')
            const reason = activity.reason || (activity as any).sessionFailed?.reason || ''
            await streamManager.finalizeSession(thread.id, false, reason)
            activeStreams.delete(thread.id)
            busySessions.delete(thread.id)
            queuedMessages.delete(thread.id)
            stopTyping()
            return
          }
        }
      }

      // Stream loop finished for this turn
      if (agentMessagedInThisTurn) {
        const lastHuman = await getLastHumanMessage(thread)
        await updateReaction(lastHuman, 'responded')
      }

      stopTyping()
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
  busySessions.delete(thread.id)

  // Flush queued messages if any exist
  const queued = queuedMessages.get(thread.id)
  if (queued && queued.length > 0) {
    queuedMessages.delete(thread.id)
    try {
      const combinedPrompt = queued
        .map((msg) => `[Message details - Author Nickname: ${msg.authorNickname}, Message Time: ${msg.messageTime}]\n\n${msg.content}`)
        .join('\n\n---\n\n')

      console.log(`[Queue] Flushing ${queued.length} queued messages for thread ${thread.id}`)
      await thread.send('⚙️ **Sending queued messages to Jules...**')

      const session = JulesClient.getSession(sessionId)
      await session.send(combinedPrompt)

      // Restart runJulesStream to process the next turn in the background
      setTimeout(() => {
        runJulesStream(sessionId, thread, streamManager)
      }, 1000)
    } catch (err) {
      console.error(`Failed to send combined queued messages for thread ${thread.id}:`, err)
      await thread.send('❌ **Failed to deliver queued messages to Jules.**')
    }
  }
}

export async function initializeJulesSession(
  thread: ThreadChannel,
  repoName: string,
  branchName: string,
  streamManager: StreamManager
) {
  const starterMessage = await thread.fetchStarterMessage()
  if (!starterMessage || (!starterMessage.content && starterMessage.attachments.size === 0)) {
    await thread.send('⚠️ **Could not retrieve the starter message for this thread. Please reply with your issue details to start.**')
    return
  }

  const authorNickname = starterMessage.member?.displayName || starterMessage.author.username
  const messageTime = starterMessage.createdAt.toISOString()
  const threadTitle = thread.name
  
  let starterContent = starterMessage.content || ''
  if (starterMessage.attachments.size > 0) {
    const attachmentList = Array.from(starterMessage.attachments.values()).map(att => ({
      name: att.name,
      url: att.url
    }))
    const parsedAttachments = await processAttachments(attachmentList, thread)
    starterContent += parsedAttachments
  }

  const promptWithMetadata = `[Message details - Author Nickname: ${authorNickname}, Message Time: ${messageTime}, Issue/Thread Title: ${threadTitle}]\n\n${starterContent}`

  let session: any = null
  let usedPreWarmed = false
  let initialSkipIds: Set<string> | undefined
  let welcomePlanRejected = false
  let welcomeFeedback = ''

  const threadConfig = getEffectiveConfig(thread, starterMessage.member)
  
  // Determine matching contextKey and pool eligibility
  let contextKey: string | null = null
  let usePool = false

  const channelsConfig = yamlConfig.channels || {}
  const rolesConfig = yamlConfig.roles || {}

  if (thread.id && channelsConfig[thread.id] && channelsConfig[thread.id].pre_warmed_sessions?.enabled) {
    contextKey = thread.id
    usePool = true
  } else if (thread.parentId && channelsConfig[thread.parentId] && channelsConfig[thread.parentId].pre_warmed_sessions?.enabled) {
    contextKey = thread.parentId
    usePool = true
  } else {
    // Check roles
    if (starterMessage.member && starterMessage.member.roles) {
      for (const [roleKey, roleVal] of Object.entries(rolesConfig)) {
        let hasRole = false
        const roles = starterMessage.member.roles as any
        if (roles && roles.cache) {
          hasRole = roles.cache.has(roleKey) || 
                    roles.cache.some((r: any) => r.name === roleKey)
        } else if (Array.isArray(roles)) {
          hasRole = roles.includes(roleKey)
        }
        if (hasRole && roleVal && typeof roleVal === 'object' && (roleVal as any).pre_warmed_sessions?.enabled) {
          contextKey = roleKey
          usePool = true
          break
        }
      }
    }
  }

  if (!usePool) {
    // Check if global pool is enabled and prompts are NOT overridden
    const globalConfig = getEffectiveConfig()
    const isPromptOverridden = threadConfig.diagnostic_prompt !== globalConfig.diagnostic_prompt ||
      threadConfig.agents_personality !== globalConfig.agents_personality ||
      threadConfig.soul_personality !== globalConfig.soul_personality

    if (threadConfig.pre_warmed_sessions.enabled && !isPromptOverridden) {
      contextKey = null
      usePool = true
    }
  }

  // Pre-warmed sessions are currently only created for the default branch (usually 'main')
  const isDefaultBranch = branchName === (threadConfig.default_branch || 'main')

  if (usePool && isDefaultBranch) {
    let preWarmed = await prisma.preWarmedSession.findFirst({
      where: { repoName, ready: true, contextKey },
      orderBy: { createdAt: 'asc' },
    })

    if (!preWarmed) {
      const warming = await prisma.preWarmedSession.findFirst({
        where: { repoName, ready: false, contextKey },
        orderBy: { createdAt: 'asc' },
      })
      if (warming) {
        const statusMsg = await thread.send('⏳ **A session is currently pre-warming. Waiting for it to become ready...**')
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
          const check = await prisma.preWarmedSession.findUnique({
            where: { id: warming.id }
          })
          if (check && check.ready) {
            preWarmed = check
            break
          }
        }
        await statusMsg.delete().catch(() => {})
      }
    }

    if (preWarmed) {
      try {
        session = JulesClient.getSession(preWarmed.id)
        
        const info = await session.info()
        console.log(`[initializeJulesSession] Session ${session.id} state at consumption: ${info.state}`)
        
        // If auto-reject is enabled, we check if there's any active plan to reject
        if (threadConfig.auto_reject?.enabled) {
          const hasActivePlan = !!info.plan
          const hasPlanInHistory = info.activities?.some((a: any) => a.type === 'planGenerated')
          
          if (hasActivePlan || hasPlanInHistory || info.state === 'awaitingPlanApproval') {
            console.log(`[initializeJulesSession] Plan detected for session ${session.id} (Active: ${hasActivePlan}, History: ${hasPlanInHistory}, State: ${info.state}). Marking for rejection.`)
            welcomePlanRejected = true
            welcomeFeedback = threadConfig.auto_reject?.message || 'Please do not create or refine an implementation plan. Instead, just talk directly with me to understand the goals and discuss the issue.'
          }
        }

        if (info.activities) {
          console.log(`[initializeJulesSession] Session ${session.id} has ${info.activities.length} activities.`)
          initialSkipIds = new Set(info.activities.map((a: any) => a.id))
          for (const activity of info.activities) {
            console.log(`[initializeJulesSession] Activity Type: ${activity.type}`)
            if (activity.type === 'agentMessaged') {
              const message = activity.message || (activity as any).agentMessaged?.message || ''
              if (message) {
                const resolved = resolveMessageEmojis(thread.client, message)
                await thread.send(resolved.slice(0, 2000))
              }
            } else if (activity.type === 'planGenerated') {
              const plan = activity.plan || (activity as any).planGenerated?.plan
              if (plan && plan.steps) {
                console.log(`[initializeJulesSession] Rendering plan from history for session ${session.id}`)
                const stepsText = plan.steps
                  .map((step: any, i: number) => `**${i + 1}.** ${step.title}`)
                  .join('\n')

                const embed = new EmbedBuilder()
                  .setTitle(`${threadConfig.bot_emoji || '🐙'} Jules Proposed Diagnostic Plan`)
                  .setDescription(stepsText.slice(0, 4000) || 'No details provided.')
                  .setColor(0x00ae86)
                  .setFooter({ text: 'Welcome plan detected.' })

                await thread.send({ embeds: [embed] })
              }
            }
          }
        }

        if (welcomePlanRejected) {
          autoRejectedSessions.add(session.id)
          const botEmoji = threadConfig.bot_emoji || '🐙'
          console.log(`[initializeJulesSession] Automatically rejecting welcome plan for pre-warmed session ${session.id}`)
          await thread.send(`${botEmoji} **Plan Automatically Rejected:**\nFeedback: "${welcomeFeedback}"\nJules is revising the plan...`)
        }

        await prisma.preWarmedSession.delete({
          where: { id: preWarmed.id },
        })
        
        usedPreWarmed = true
        console.log(`[initializeJulesSession] Consumed pre-warmed session ${session.id} for repo ${repoName} (Context: ${contextKey || 'global'})`)
      } catch (err) {
        console.error(`[initializeJulesSession] Failed to rehydrate pre-warmed session ${preWarmed.id}:`, err)
      }
    }
  }

  if (!session) {
    session = await JulesClient.createSession({
      prompt: promptWithMetadata,
      repo: repoName,
      branch: branchName,
      title: thread.name,
      thread: thread,
      member: starterMessage.member,
    })
  }

  await prisma.debugSession.create({
    data: {
      threadId: thread.id,
      guildId: thread.guildId,
      julesSessionId: session.id,
      repoName: repoName,
    },
  })

  // Ensure autoRejectedSessions entry persists if we rejected a plan during initialization,
  // so runJulesStream doesn't try to reject the SAME plan again.
  // We will only delete it AFTER the user prompt is sent and we want to allow a NEW rejection.

  // Start processing events in the background
  runJulesStream(session.id, thread, streamManager, initialSkipIds)

  if (usedPreWarmed) {
    await thread.send('🚀 **Ready session found! Processing your issue...**')
    thread.sendTyping().catch(() => {})
    
    if (welcomePlanRejected) {
      // Send rejection separately BEFORE the user prompt
      const rejectionDirective = `[System Directive: Auto-Reject Plan]\nFeedback: "${welcomeFeedback}"\n\nPlease do not create or refine an implementation plan. Respond directly to the user's prompt.`
      console.log(`[initializeJulesSession] Sending auto-rejection directive for session ${session.id}`)
      await session.send(rejectionDirective)
      
      // Wait for it to process the rejection so it's ready for the prompt
      console.log(`[initializeJulesSession] Waiting for session ${session.id} to process rejection...`)
      for (let i = 0; i < 20; i++) {
        const info = await session.info()
        if (info.state !== 'queued') {
          console.log(`[initializeJulesSession] Session ${session.id} finished processing rejection (State: ${info.state})`)
          break
        }
        await new Promise(r => setTimeout(r, 1000))
      }
      
      // Briefly wait for any immediate follow-up activities to settle
      await new Promise(r => setTimeout(r, 2000))
      
      // Now that we've rejected the welcome plan, we clear the set so that the 
      // FIRST plan for the ACTUAL prompt can also be rejected.
      autoRejectedSessions.delete(session.id)
    }
    
    console.log(`[initializeJulesSession] Sending user prompt to session ${session.id}`)
    await session.send(promptWithMetadata)
    replenishPool(repoName, contextKey).catch(() => {})
  } else if (usePool) {
    replenishPool(repoName, contextKey).catch(() => {})
  }
}
