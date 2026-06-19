import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAttachmentMetadata } from '../src/lib/utils/attachments.js'

test('returns empty string when no attachments', () => {
  assert.equal(formatAttachmentMetadata([]), '')
})

test('formats attachment details and instructions correctly', () => {
  const attachments = [
    {
      name: 'cat.png',
      url: 'https://cdn.discordapp.com/attachments/12345/67890/cat.png',
      contentType: 'image/png',
      size: 46285, // 45.2 KB
    },
  ]

  const output = formatAttachmentMetadata(attachments)

  // Verify key fields are present
  assert.ok(output.includes('📎 **Attachments Attached:**'))
  assert.ok(output.includes('- **Name:** `cat.png`'))
  assert.ok(output.includes('**URL:** https://cdn.discordapp.com/attachments/12345/67890/cat.png'))
  assert.ok(output.includes('**Type:** `image/png`'))
  assert.ok(output.includes('**Size:** `45.2 KB`'))
  assert.ok(
    output.includes(
      '*(Note to Jules: If you need to inspect or analyze the attachments listed above',
    ),
  )
})
