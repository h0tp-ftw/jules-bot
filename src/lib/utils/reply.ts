import type { Message } from 'discord.js'
import { t, type Messages, DEFAULT_MESSAGES } from '../../strings.js'
import type { ReplyContextMode } from '../../config.js'

export interface ResolvedReplyContext {
  replyInfo: string
  quotePrefix: string
  replyMessageId?: string
}

/**
 * Resolves reply context based on the configured mode:
 * - 'message_id' (default): Synchronously extracts message.reference.messageId,
 *   formatting `, In reply to Message ID: <id>`.
 * - 'full_message': Asynchronously fetches the referenced message (with error handling
 *   and truncation) and formats a quote prefix block.
 * - 'none': Ignores reply reference.
 */
export async function resolveReplyContext(
  message: Message,
  mode: ReplyContextMode = 'message_id',
  messages: Messages['prompts'] = DEFAULT_MESSAGES.prompts,
): Promise<ResolvedReplyContext> {
  const referenceId = message.reference?.messageId
  if (!referenceId || mode === 'none') {
    return { replyInfo: '', quotePrefix: '' }
  }

  const replyInfo = t(messages.reply_info, { reply_message_id: referenceId })

  if (mode === 'message_id') {
    return {
      replyInfo,
      quotePrefix: '',
      replyMessageId: referenceId,
    }
  }

  // mode === 'full_message'
  try {
    const referencedMsg = await message.fetchReference()
    if (referencedMsg) {
      const author =
        referencedMsg.author.id === message.client.user?.id
          ? 'Jules (Bot)'
          : `@${referencedMsg.member?.displayName || referencedMsg.author.username}`

      let snippet = referencedMsg.content || ''
      if (snippet.length > 300) {
        snippet = `${snippet.slice(0, 300)}...`
      } else if (!snippet && referencedMsg.attachments.size > 0) {
        snippet = '[Attachments only]'
      } else if (!snippet) {
        snippet = '[Empty or Embed]'
      }

      const quotePrefix = t(messages.reply_quote, {
        author,
        reply_message_id: referenceId,
        snippet,
      })

      return {
        replyInfo,
        quotePrefix,
        replyMessageId: referenceId,
      }
    }
  } catch {
    // If original message is deleted or inaccessible
  }

  const quotePrefix = t(messages.reply_quote_unavailable, {
    reply_message_id: referenceId,
  })

  return {
    replyInfo,
    quotePrefix,
    replyMessageId: referenceId,
  }
}
