import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReplyContext } from '../src/lib/utils/reply.js'

function createMockMessage(opts: {
  id?: string
  content?: string
  referenceId?: string
  referencedMessage?: any
  fetchError?: boolean
  botUserId?: string
  onFetchReference?: () => void
}) {
  const botUserId = opts.botUserId || 'BOT_123'
  return {
    id: opts.id || 'MSG_100',
    content: opts.content || 'Hello',
    reference: opts.referenceId ? { messageId: opts.referenceId } : null,
    client: {
      user: { id: botUserId },
    },
    fetchReference: async () => {
      opts.onFetchReference?.()
      if (opts.fetchError) {
        throw new Error('Message deleted or not found')
      }
      return opts.referencedMessage
    },
  } as any
}

test('resolveReplyContext: returns empty for message without reference', async () => {
  const msg = createMockMessage({ referenceId: undefined })
  const result = await resolveReplyContext(msg, 'message_id')
  assert.equal(result.replyInfo, '')
  assert.equal(result.quotePrefix, '')
})

test('resolveReplyContext: returns empty when mode is none', async () => {
  const msg = createMockMessage({ referenceId: 'REF_999' })
  const result = await resolveReplyContext(msg, 'none')
  assert.equal(result.replyInfo, '')
  assert.equal(result.quotePrefix, '')
})

test('resolveReplyContext: message_id mode does not fetch the referenced message', async () => {
  let fetches = 0
  const msg = createMockMessage({ referenceId: 'REF_999', onFetchReference: () => fetches++ })
  const result = await resolveReplyContext(msg, 'message_id')
  assert.equal(result.replyInfo, ', In reply to Message ID: REF_999')
  assert.equal(result.quotePrefix, '')
  assert.equal(result.replyMessageId, 'REF_999')
  assert.equal(fetches, 0)
})

test('resolveReplyContext: full_message mode formats quote from referenced message', async () => {
  const refMsg = {
    id: 'REF_999',
    author: { id: 'USER_1', username: 'alice' },
    member: { displayName: 'Alice' },
    content: 'Please check the logs',
    attachments: new Map(),
  }
  const msg = createMockMessage({
    referenceId: 'REF_999',
    referencedMessage: refMsg,
  })

  const result = await resolveReplyContext(msg, 'full_message')
  assert.equal(result.replyInfo, ', In reply to Message ID: REF_999')
  assert.equal(
    result.quotePrefix,
    '[In reply to @Alice (Message ID: REF_999): "Please check the logs"]\n\n',
  )
})

test('resolveReplyContext: full_message labels bot authors as Jules (Bot)', async () => {
  const botId = 'BOT_123'
  const refMsg = {
    id: 'REF_888',
    author: { id: botId, username: 'jules' },
    content: 'Plan proposed.',
    attachments: new Map(),
  }
  const msg = createMockMessage({
    referenceId: 'REF_888',
    referencedMessage: refMsg,
    botUserId: botId,
  })

  const result = await resolveReplyContext(msg, 'full_message')
  assert.equal(
    result.quotePrefix,
    '[In reply to Jules (Bot) (Message ID: REF_888): "Plan proposed."]\n\n',
  )
})

test('resolveReplyContext: full_message truncates long snippets', async () => {
  const longContent = 'A'.repeat(500)
  const refMsg = {
    id: 'REF_777',
    author: { id: 'USER_2', username: 'bob' },
    content: longContent,
    attachments: new Map(),
  }
  const msg = createMockMessage({
    referenceId: 'REF_777',
    referencedMessage: refMsg,
  })

  const result = await resolveReplyContext(msg, 'full_message')
  assert.ok(result.quotePrefix.includes('A'.repeat(300) + '...'))
})

test('resolveReplyContext: full_message fetches the referenced message once', async () => {
  let fetches = 0
  const refMsg = {
    id: 'REF_123',
    author: { id: 'USER_3', username: 'carol' },
    content: 'Original message',
    attachments: new Map(),
  }
  const msg = createMockMessage({
    referenceId: 'REF_123',
    referencedMessage: refMsg,
    onFetchReference: () => fetches++,
  })

  await resolveReplyContext(msg, 'full_message')
  assert.equal(fetches, 1)
})

test('resolveReplyContext: full_message handles fetch failure gracefully', async () => {
  const msg = createMockMessage({
    referenceId: 'REF_DELETED',
    fetchError: true,
  })

  const result = await resolveReplyContext(msg, 'full_message')
  assert.equal(result.replyInfo, ', In reply to Message ID: REF_DELETED')
  assert.equal(
    result.quotePrefix,
    '[In reply to Message ID: REF_DELETED (original message unavailable)]\n\n',
  )
})
