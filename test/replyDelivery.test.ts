import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverWithReply } from '../src/lib/utils/replyDelivery.js'

function makeChannel() {
  const sends: Record<string, unknown>[] = []
  return {
    sends,
    channel: {
      send: async (payload: Record<string, unknown>) => {
        sends.push(payload)
        return { id: 'sent' }
      },
    },
  }
}

function makeTarget(reply?: (payload: Record<string, unknown>) => Promise<unknown>) {
  const replies: Record<string, unknown>[] = []
  return {
    replies,
    target: {
      id: 'msg-1',
      reply:
        reply ||
        (async (payload: Record<string, unknown>) => {
          replies.push(payload)
          return { id: 'replied' }
        }),
    },
  }
}

test('reply_silent replies to the target without pinging its author', async () => {
  const { channel, sends } = makeChannel()
  const { target, replies } = makeTarget()

  const result = await deliverWithReply(channel, target, 'reply_silent', { content: 'hi' })

  assert.equal(replies.length, 1)
  assert.equal(replies[0].content, 'hi')
  assert.deepEqual(replies[0].allowedMentions, { repliedUser: false })
  assert.equal(sends.length, 0)
  assert.equal(result.id, 'replied')
})

test('reply_ping replies with default mention behavior', async () => {
  const { channel, sends } = makeChannel()
  const { target, replies } = makeTarget()

  await deliverWithReply(channel, target, 'reply_ping', { content: 'hi' })

  assert.equal(replies.length, 1)
  assert.equal(replies[0].allowedMentions, undefined)
  assert.equal(sends.length, 0)
})

test('send mode posts in the channel even when a target exists', async () => {
  const { channel, sends } = makeChannel()
  const { target, replies } = makeTarget()

  const result = await deliverWithReply(channel, target, 'send', { content: 'hi' })

  assert.equal(replies.length, 0)
  assert.equal(sends.length, 1)
  assert.equal(result.id, 'sent')
})

test('a missing target falls back to a channel send', async () => {
  const { channel, sends } = makeChannel()

  const result = await deliverWithReply(channel, null, 'reply_silent', { content: 'hi' })

  assert.equal(sends.length, 1)
  assert.equal(sends[0].content, 'hi')
  assert.equal(result.id, 'sent')
})

test('a failed reply falls back to a channel send instead of throwing', async () => {
  const { channel, sends } = makeChannel()
  const { target } = makeTarget(async () => {
    throw new Error('Unknown message')
  })

  const result = await deliverWithReply(channel, target, 'reply_silent', { content: 'hi' })

  assert.equal(sends.length, 1)
  assert.equal(sends[0].content, 'hi')
  assert.equal(result.id, 'sent')
})

test('the fallback send preserves the payload but not reply-only options', async () => {
  const { channel, sends } = makeChannel()
  const { target } = makeTarget(async () => {
    throw new Error('boom')
  })

  await deliverWithReply(channel, target, 'reply_ping', { embeds: ['e'], components: ['c'] })

  assert.equal(sends.length, 1)
  assert.deepEqual(sends[0], { embeds: ['e'], components: ['c'] })
})
