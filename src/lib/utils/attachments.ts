import { DEFAULT_MESSAGES, t, type Messages } from '../../strings.js'

export interface SimpleAttachment {
  name: string
  url: string
  contentType?: string
  size?: number
}

/**
 * Formats attachment details into a descriptive markdown list with instructions
 * for Jules. Strings come from the resolved message catalog; pass
 * `cfg.messages.attachments` to honor per-channel/role overrides, otherwise the
 * built-in defaults are used.
 */
export function formatAttachmentMetadata(
  attachments: SimpleAttachment[],
  messages: Messages['attachments'] = DEFAULT_MESSAGES.attachments,
): string {
  if (attachments.length === 0) return ''

  let attachmentMetadata = messages.header
  for (const att of attachments) {
    attachmentMetadata += t(messages.item, { name: att.name, url: att.url })
    if (att.contentType) {
      attachmentMetadata += t(messages.type, { type: att.contentType })
    }
    if (att.size) {
      attachmentMetadata += t(messages.size, { size: (att.size / 1024).toFixed(1) })
    }
  }
  attachmentMetadata += messages.instructions

  return attachmentMetadata
}
