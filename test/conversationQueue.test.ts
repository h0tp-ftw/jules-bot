import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'discord.js'
import {
  completeConversationTurn,
  enqueueConversationMessage,
  getActiveConversationQueueSnapshots,
  getActiveConversationTurn,
  getConversationQueueDepth,
  markConversationTurnDispatched,
  markConversationTurnResponded,
  scheduleConversationNudge,
} from '../src/lib/jules/ConversationQueue.js'

function fakeMessage(id: string): Message {
  return { id } as Message
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

test('snapshots the active turn and pending queue depth for shutdown notices', async () => {
  const channelId = 'queue-shutdown-snapshot'
  let firstTurnId = ''

  const first = enqueueConversationMessage(channelId, fakeMessage('message-1'), async (turn) => {
    firstTurnId = turn.id
    markConversationTurnDispatched(channelId, turn.id)
    return true
  })
  const second = enqueueConversationMessage(channelId, fakeMessage('message-2'), async () => false)

  await nextTick()
  const snapshot = getActiveConversationQueueSnapshots().find(
    (candidate) => candidate.turn.channelId === channelId,
  )
  assert.equal(snapshot?.turn.message.id, 'message-1')
  assert.equal(snapshot?.pendingCount, 1)
  assert.equal(snapshot?.depth, 2)

  completeConversationTurn(channelId, 'session_completed', firstTurnId)
  await Promise.all([first, second])
  assert.equal(
    getActiveConversationQueueSnapshots().some(
      (candidate) => candidate.turn.channelId === channelId,
    ),
    false,
  )
})

test('runs the queued-reaction preparation for pending turns immediately', async () => {
  const channelId = 'queue-preparation'
  const prepared: string[] = []
  let firstTurnId = ''

  const first = enqueueConversationMessage(
    channelId,
    fakeMessage('message-1'),
    async (turn) => {
      firstTurnId = turn.id
      markConversationTurnDispatched(channelId, turn.id)
      return true
    },
    async () => {
      prepared.push('message-1')
    },
  )
  const second = enqueueConversationMessage(
    channelId,
    fakeMessage('message-2'),
    async () => false,
    async () => {
      prepared.push('message-2')
    },
  )

  await nextTick()
  assert.deepEqual(prepared, ['message-1', 'message-2'])
  completeConversationTurn(channelId, 'session_completed', firstTurnId)
  await Promise.all([first, second])
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

test('releases a turn after its first agent response', async () => {
  const channelId = 'queue-agent-response'
  const dispatched: string[] = []
  let firstTurnId = ''

  const first = enqueueConversationMessage(channelId, fakeMessage('message-1'), async (turn) => {
    firstTurnId = turn.id
    dispatched.push('message-1')
    markConversationTurnDispatched(channelId, turn.id)
    return true
  })
  const second = enqueueConversationMessage(channelId, fakeMessage('message-2'), async () => {
    dispatched.push('message-2')
    return false
  })

  await nextTick()
  assert.equal(markConversationTurnResponded(channelId, firstTurnId), true)
  assert.equal(completeConversationTurn(channelId, 'agent_responded', firstTurnId), true)
  await Promise.all([first, second])

  assert.deepEqual(dispatched, ['message-1', 'message-2'])
  assert.equal(getConversationQueueDepth(channelId), 0)
})

test('sends one nudge when the active turn remains unanswered', async () => {
  const channelId = 'queue-nudge'
  let turnId = ''
  let nudges = 0

  const completion = enqueueConversationMessage(
    channelId,
    fakeMessage('message-1'),
    async (turn) => {
      turnId = turn.id
      markConversationTurnDispatched(channelId, turn.id)
      assert.equal(
        scheduleConversationNudge(
          channelId,
          10,
          async () => {
            nudges++
          },
          turn.id,
        ),
        true,
      )
      return true
    },
  )

  await sleep(30)
  assert.equal(nudges, 1)
  assert.ok(getActiveConversationTurn(channelId)?.nudgedAt)
  assert.equal(
    scheduleConversationNudge(channelId, 10, async () => {}, turnId),
    false,
  )

  completeConversationTurn(channelId, 'session_completed', turnId)
  await completion
})

test('cancels the nudge as soon as Jules responds', async () => {
  const channelId = 'queue-nudge-cancelled'
  let turnId = ''
  let nudges = 0

  const completion = enqueueConversationMessage(
    channelId,
    fakeMessage('message-1'),
    async (turn) => {
      turnId = turn.id
      markConversationTurnDispatched(channelId, turn.id)
      scheduleConversationNudge(
        channelId,
        25,
        async () => {
          nudges++
        },
        turn.id,
      )
      return true
    },
  )

  await nextTick()
  assert.equal(markConversationTurnResponded(channelId, turnId), true)
  await sleep(40)
  assert.equal(nudges, 0)

  completeConversationTurn(channelId, 'session_completed', turnId)
  await completion
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
