import { Client, ThreadChannel } from 'discord.js'
import { prisma, getEffectiveConfig } from '../../config.js'
import { t } from '../../strings.js'

export class StreamManager {
  private buffers = new Map<string, string[]>()
  private timers = new Map<string, NodeJS.Timeout>()
  private activeSteps = new Map<string, { title: string; description?: string }>()

  constructor(private client: Client) {}

  async handleProgress(threadId: string, title: string, description?: string) {
    const session = await prisma.debugSession.findUnique({
      where: { threadId },
    })
    if (!session) return

    const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel
    if (!thread) return

    let statusMessageId = session.statusMessageId
    if (!statusMessageId) {
      const threadConfig = getEffectiveConfig(thread)
      const botEmoji = threadConfig.bot_emoji || '🐙'
      const msg = await thread.send(t(threadConfig.messages.stream.initial_status, { emoji: botEmoji }))
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

  private async flush(thread: ThreadChannel, statusMessageId: string) {
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
      const msg = await thread.messages.fetch(statusMessageId)
      await msg.edit({ content: content.slice(0, 1990) })
    } catch (err) {
      console.error('Failed to update status message:', err)
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
  }

  async finalizeSession(threadId: string, success: boolean, reason?: string) {
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
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel
      if (!thread) return

      const m = getEffectiveConfig(thread).messages.stream
      const buf = this.buffers.get(threadId) ?? []
      const statusText = success
        ? m.completed
        : `${m.failed}${reason ? t(m.failed_reason_suffix, { reason }) : ''}`

      const logsBlock = buf.length > 0
        ? `\n\n${m.final_logs_header}\n\`\`\`\n${buf.join('\n')}\n\`\`\``
        : ''

      const msg = await thread.messages.fetch(session.statusMessageId)
      await msg.edit({ content: `${statusText}${logsBlock}`.slice(0, 1990) })
    } catch (err) {
      console.error('Failed to finalize status message:', err)
    }

    // Clean up in-memory buffer
    this.buffers.delete(threadId)
    this.activeSteps.delete(threadId)
  }
}
