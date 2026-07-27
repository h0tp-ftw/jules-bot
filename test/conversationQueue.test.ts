import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'discord.js'
import {
  completeConversationTurn,
  enqueueConversationMessage,
  getActiveConversationTurn,
  getConversationQueueDepth,
  markConversationTurnDispatched,
  markConversationTurnResponded,
} from '../src/lib/jules/ConversationQueue.js'

function fakeMessage(id: string): Message {
  return { id } as Message
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('serializes turns until the active Jules session completes', async () => {
  const channelId = 'queue-serial'
  const dispatched: string[] = []
  let firstTurnId = ''

  const first = enqueueConversationMessage(channelId, fakeMessage('message-1'), async (turn) => {
    firstTurnId = turn.id
    dispatched.push('message-1')
    markConversationTurnDispatched(channelId, turn.id)
    return true
  })
  const second = enqueueConversationMessage(channelId, fakeMessage('message-2'), async (turn) => {
    dispatched.push('message-2')
    markConversationTurnDispatched(channelId, turn.id)
    return false
  })

  await nextTick()
  assert.deepEqual(dispatched, ['message-1'])
  assert.equal(getConversationQueueDepth(channelId), 2)
  assert.equal(getActiveConversationTurn(channelId)?.message.id, 'message-1')
  assert.equal(completeConversationTurn(channelId, 'session_completed', 'wrong-turn'), false)

  assert.equal(completeConversationTurn(channelId, 'session_completed', firstTurnId), true)
  await Promise.all([first, second])

  assert.deepEqual(dispatched, ['message-1', 'message-2'])
  assert.equal(getConversationQueueDepth(channelId), 0)
})

test('records an agent response without releasing the next queued turn', async () => {
  const channelId = 'queue-response-marker'
  let firstTurnId = ''
  let secondDispatched = false

  const first = enqueueConversationMessage(channelId, fakeMessage('message-1'), async (turn) => {
    firstTurnId = turn.id
    markConversationTurnDispatched(channelId, turn.id)
    return true
  })
  const second = enqueueConversationMessage(channelId, fakeMessage('message-2'), async () => {
    secondDispatched = true
    return false
  })

  await nextTick()
  assert.equal(markConversationTurnResponded(channelId, firstTurnId), true)
  assert.ok(getActiveConversationTurn(channelId)?.respondedAt)
  await nextTick()
  assert.equal(secondDispatched, false)

  completeConversationTurn(channelId, 'session_completed', firstTurnId)
  await Promise.all([first, second])
  assert.equal(secondDispatched, true)
})

test('a failed dispatch does not block later queued messages', async () => {
  const channelId = 'queue-dispatch-failure'
  const dispatched: string[] = []

  const first = enqueueConversationMessage(channelId, fakeMessage('message-1'), async () => {
    dispatched.push('message-1')
    throw new Error('send failed')
  })
  const second = enqueueConversationMessage(channelId, fakeMessage('message-2'), async () => {
    dispatched.push('message-2')
    return false
  })

  await assert.rejects(first, /send failed/)
  await second
  assert.deepEqual(dispatched, ['message-1', 'message-2'])
  assert.equal(getConversationQueueDepth(channelId), 0)
})
