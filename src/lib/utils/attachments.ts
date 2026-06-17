export interface SimpleAttachment {
  name: string
  url: string
  contentType?: string
  size?: number
}

/**
 * Formats attachment details into a descriptive markdown list with instructions for Jules.
 */
export function formatAttachmentMetadata(attachments: SimpleAttachment[]): string {
  if (attachments.length === 0) return ''

  let attachmentMetadata = '\n\n📎 **Attachments Attached:**\n'
  for (const att of attachments) {
    attachmentMetadata += `- **Name:** \`${att.name}\`\n  **URL:** ${att.url}\n`
    if (att.contentType) {
      attachmentMetadata += `  **Type:** \`${att.contentType}\`\n`
    }
    if (att.size) {
      attachmentMetadata += `  **Size:** \`${(att.size / 1024).toFixed(1)} KB\`\n`
    }
  }
  attachmentMetadata += `\n*(Note to Jules: If you need to inspect or analyze the attachments listed above, you should download them inside your workspace. For example, you can run \`curl -o "filename" "URL"\` or use a download script to save the file. Once downloaded locally in your workspace, you can use your native read/view tools on the downloaded file. If it is an image or PDF, your native read tool can handle it multimodally.)*\n`

  return attachmentMetadata
}
