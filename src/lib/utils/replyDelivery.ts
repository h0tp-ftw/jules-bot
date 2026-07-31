import { logger } from './logger.js'

export type ReplyMode = 'reply_ping' | 'reply_silent' | 'send'

// Structural types so the helper stays unit-testable without discord.js.
export interface ReplyTargetLike {
  id: string
  reply: (payload: Record<string, unknown>) => Promise<any>
}

export interface SendChannelLike {
  send: (payload: Record<string, unknown>) => Promise<any>
}

// Deliver a payload as a Discord reply to `target` when the effective
// reply_mode asks for one, falling back to a plain channel send when the reply
// fails (deleted target message, missing read-history permission, …). A stale
// reply reference must never lose the content or kill the stream via the
// retry loop — that regression is why reply_mode used to default to 'send'.
export async function deliverWithReply(
  channel: SendChannelLike,
  target: ReplyTargetLike | null | undefined,
  replyMode: ReplyMode,
  payload: Record<string, unknown>,
): Promise<any> {
  if (target && replyMode !== 'send') {
    try {
      return await target.reply({
        ...payload,
        allowedMentions: replyMode === 'reply_silent' ? { repliedUser: false } : undefined,
      })
    } catch (err) {
      logger.warn(
        `[deliverWithReply] Reply to message ${target.id} failed; sending in channel instead:`,
        err,
      )
    }
  }
  return await channel.send(payload)
}
