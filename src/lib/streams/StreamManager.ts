import { Client, ThreadChannel } from 'discord.js'
import { prisma } from '../../config'

export class StreamManager {
  private buffers = new Map<string, string[]>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private client: Client) {}

  async handleProgress(threadId: string, line: string) {
    const session = await prisma.debugSession.findUnique({
      where: { threadId },
    })
    if (!session) return

    const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel
    if (!thread) return

    let statusMessageId = session.statusMessageId
    if (!statusMessageId) {
      const msg = await thread.send('⚙️ **Jules is analyzing the workspace...**\n\n*Logs will stream below:*')
      statusMessageId = msg.id
      await prisma.debugSession.update({
        where: { threadId },
        data: { statusMessageId },
      })
    }

    const buf = this.buffers.get(threadId) ?? []
    buf.push(line)
    // Keep last 15 lines of output to fit in Discord's 2000 character limit
    this.buffers.set(threadId, buf.slice(-15))

    if (this.timers.has(threadId)) return

    const timer = setTimeout(() => this.flush(thread, statusMessageId!), 3000)
    this.timers.set(threadId, timer)
  }

  private async flush(thread: ThreadChannel, statusMessageId: string) {
    this.timers.delete(thread.id)
    const buf = this.buffers.get(thread.id) ?? []
    const content =
      '⚙️ **Jules is analyzing the workspace...**\n\n**Latest steps:**\n```\n' +
      buf.join('\n') +
      '\n```'

    try {
      const msg = await thread.messages.fetch(statusMessageId)
      await msg.edit({ content: content.slice(0, 1990) })
    } catch (err) {
      console.error('Failed to update status message:', err)
    }
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

      const buf = this.buffers.get(threadId) ?? []
      const statusText = success
        ? '✅ **Jules analysis completed successfully.**'
        : `❌ **Jules analysis failed.**${reason ? ` Reason: ${reason}` : ''}`

      const logsBlock = buf.length > 0
        ? `\n\n**Final execution logs:**\n\`\`\`\n${buf.join('\n')}\n\`\`\``
        : ''

      const msg = await thread.messages.fetch(session.statusMessageId)
      await msg.edit({ content: `${statusText}${logsBlock}`.slice(0, 1990) })
    } catch (err) {
      console.error('Failed to finalize status message:', err)
    }

    // Clean up in-memory buffer
    this.buffers.delete(threadId)
  }
}
