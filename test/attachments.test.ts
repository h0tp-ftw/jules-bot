import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAttachmentMetadata } from '../src/lib/utils/attachments.js'
import { DEFAULT_MESSAGES } from '../src/strings.js'

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

test('omits the Type and Size lines when those fields are absent', () => {
  const out = formatAttachmentMetadata([{ name: 'doc', url: 'https://x/doc' }])
  assert.ok(out.includes('`doc`'))
  assert.ok(!out.includes('**Type:**'))
  assert.ok(!out.includes('**Size:**'))
})

test('renders one entry per attachment', () => {
  const out = formatAttachmentMetadata([
    { name: 'a.png', url: 'https://x/a' },
    { name: 'b.png', url: 'https://x/b' },
  ])
  assert.ok(out.includes('`a.png`'))
  assert.ok(out.includes('`b.png`'))
})

test('reports size in KB to one decimal place', () => {
  const out = formatAttachmentMetadata([{ name: 'f', url: 'https://x/f', size: 1536 }])
  assert.ok(out.includes('1.5 KB'), out)
})

test('honors a custom messages override', () => {
  const custom = { ...DEFAULT_MESSAGES.attachments, header: 'CUSTOM HEADER\n' }
  const out = formatAttachmentMetadata([{ name: 'a', url: 'https://x/a' }], custom)
  assert.ok(out.startsWith('CUSTOM HEADER'))
})
