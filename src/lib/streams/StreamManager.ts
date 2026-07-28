import { logger } from '../utils/logger.js'
import { Client, Message, ThreadChannel, TextChannel } from 'discord.js'
import { prisma, getEffectiveConfig } from '../../config.js'
import { t } from '../../strings.js'
import { splitMessage } from '../utils/messageSplitter.js'

type JulesDiscordChannel = ThreadChannel | TextChannel

export class StreamManager {
  private buffers = new Map<string, string[]>()
  private timers = new Map<string, NodeJS.Timeout>()
  private activeSteps = new Map<string, { title: string; description?: string }>()
  private overflowMessageIds = new Map<string, string[]>()

  constructor(private client: Client) {}

  async handleProgress(threadId: string, title: string, description?: string) {
    const session = await prisma.debugSession.findUnique({
      where: { threadId },
    })
    if (!session) return

    const thread = (await this.client.channels.fetch(threadId)) as JulesDiscordChannel
    if (!thread) return

    let statusMessageId = session.statusMessageId
    if (!statusMessageId) {
      const threadConfig = getEffectiveConfig(thread)
      const botEmoji = threadConfig.bot_emoji || '🐙'
      const msg = await thread.send(
        t(threadConfig.messages.stream.initial_status, { emoji: botEmoji }),
      )
      statusMessageId = msg.id
      await prisma.debugSession.update({
        where: { threadId },
        data: { statusMessageId },
      })
    }

    const logLine = description ? `[${title}] ${description}` : title
    const buf = this.buffers.get(threadId) ?? []
    if (buf.length === 0 || buf[buf.length - 1] !== logLine) {
      buf.push(logLine)
    }
    const bufSlice = buf.slice(-15)
    this.buffers.set(threadId, bufSlice)

    this.activeSteps.set(threadId, { title, description })

    if (this.timers.has(threadId)) return

    const timer = setTimeout(() => this.flush(thread, statusMessageId!), 3000)
    this.timers.set(threadId, timer)
  }

  private async findOverflowMessages(
    thread: JulesDiscordChannel,
    statusMessageId: string,
  ): Promise<Message[]> {
    const cachedIds = this.overflowMessageIds.get(thread.id) ?? []
    if (cachedIds.length > 0) {
      const cached: Message[] = []
      for (const id of cachedIds) {
        try {
          cached.push(await thread.messages.fetch(id))
        } catch {
          // Fall through to recent-message recovery below.
        }
      }
      if (cached.length === cachedIds.length) return cached
    }

    try {
      const recent = await thread.messages.fetch({ limit: 100 })
      const recovered = [...recent.values()]
        .filter(
          (message) =>
            message.author.id === this.client.user?.id &&
            message.reference?.messageId === statusMessageId,
        )
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      this.overflowMessageIds.set(
        thread.id,
        recovered.map((message) => message.id),
      )
      return recovered
    } catch (err) {
      logger.warn(`[StreamManager] Could not recover overflow messages for ${thread.id}:`, err)
      return []
    }
  }

  private async syncStatusContent(
    thread: JulesDiscordChannel,
    statusMessageId: string,
    content: string,
  ) {
    const chunks = splitMessage(content, 1990)
    const primary = await thread.messages.fetch(statusMessageId)
    await primary.edit({ content: chunks[0] || '\u200b' })

    const overflowChunks = chunks.slice(1)
    const existing = await this.findOverflowMessages(thread, statusMessageId)
    const nextIds: string[] = []

    for (let i = 0; i < overflowChunks.length; i++) {
      const current = existing[i]
      if (current) {
        await current.edit({ content: overflowChunks[i] })
        nextIds.push(current.id)
      } else {
        const sent = await primary.reply({
          content: overflowChunks[i],
          allowedMentions: { repliedUser: false },
        })
        nextIds.push(sent.id)
      }
    }

    for (const stale of existing.slice(overflowChunks.length)) {
      await stale.delete().catch((err) => {
        logger.warn(`[StreamManager] Could not delete stale overflow message ${stale.id}:`, err)
      })
    }

    if (nextIds.length > 0) this.overflowMessageIds.set(thread.id, nextIds)
    else this.overflowMessageIds.delete(thread.id)
  }

  private async flush(thread: JulesDiscordChannel, statusMessageId: string) {
    this.timers.delete(thread.id)
    const buf = this.buffers.get(thread.id) ?? []
    const activeStep = this.activeSteps.get(thread.id)

    const threadConfig = getEffectiveConfig(thread)
    const botEmoji = threadConfig.bot_emoji || '🐙'
    const m = threadConfig.messages.stream

    let content = t(m.analyzing_header, { emoji: botEmoji }) + '\n\n'
    if (activeStep) {
      content += t(m.current_step, { title: activeStep.title }) + '\n'
      if (activeStep.description) {
        content += t(m.current_step_description, { description: activeStep.description }) + '\n'
      }
      content += '\n'
    }

    if (buf.length > 0) {
      content += m.execution_logs_header + '\n```\n' + buf.join('\n') + '\n```'
    }

    try {
      await this.syncStatusContent(thread, statusMessageId, content)
    } catch (err) {
      logger.error('Failed to update status message:', err)
    }
  }

  /**
   * Clears all pending debounce timers and in-memory buffers. Called on process
   * shutdown so dangling 3s flush timers don't fire against a torn-down client.
   */
  dispose() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.buffers.clear()
    this.activeSteps.clear()
    this.overflowMessageIds.clear()
  }

  async finalizeSession(
    threadId: string,
    success: boolean,
    reason?: string,
    result?: { pullRequestUrl?: string },
  ) {
    // Clear any pending timers
    const timer = this.timers.get(threadId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(threadId)
    }

    const session = await prisma.debugSession.findUnique({
      where: { threadId },
    })
    if (!session || !session.statusMessageId) return

    try {
      const thread = (await this.client.channels.fetch(threadId)) as JulesDiscordChannel
      if (!thread) return

      const m = getEffectiveConfig(thread).messages.stream
      const buf = this.buffers.get(threadId) ?? []
      const statusText = success
        ? m.completed
        : `${m.failed}${reason ? t(m.failed_reason_suffix, { reason }) : ''}`

      const resultBlock =
        success && result?.pullRequestUrl
          ? `\n\n${t(m.pull_request_reported, { url: result.pullRequestUrl })}`
          : ''
      const logsBlock =
        buf.length > 0 ? `\n\n${m.final_logs_header}\n\`\`\`\n${buf.join('\n')}\n\`\`\`` : ''

      await this.syncStatusContent(
        thread,
        session.statusMessageId,
        `${statusText}${resultBlock}${logsBlock}`,
      )
    } catch (err) {
      logger.error('Failed to finalize status message:', err)
    }

    // Clean up in-memory buffer
    this.buffers.delete(threadId)
    this.activeSteps.delete(threadId)
  }
}
