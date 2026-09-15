import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startTypingLoop,
  stopTypingLoop,
  isTypingLoopActive,
} from '../src/lib/utils/typingManager.js'

function makeChannel(id: string) {
  let calls = 0
  return {
    channel: {
      id,
      sendTyping: () => {
        calls++
        return Promise.resolve()
      },
    },
    count: () => calls,
  }
}

test('start sends typing immediately and refreshes on an interval', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { channel, count } = makeChannel('typing-1')

  startTypingLoop(channel)
  assert.equal(count(), 1)
  assert.equal(isTypingLoopActive('typing-1'), true)

  t.mock.timers.tick(8000)
  assert.equal(count(), 2)
  t.mock.timers.tick(16000)
  assert.equal(count(), 4)

  stopTypingLoop('typing-1')
})

test('start is idempotent while a loop is active', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { channel, count } = makeChannel('typing-2')

  startTypingLoop(channel)
  startTypingLoop(channel)
  assert.equal(count(), 1) // second start is a no-op, no duplicate immediate ping

  t.mock.timers.tick(8000)
  assert.equal(count(), 2) // one shared interval, not two

  stopTypingLoop('typing-2')
})

test('stop clears the loop and further ticks send nothing', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { channel, count } = makeChannel('typing-3')

  startTypingLoop(channel)
  stopTypingLoop('typing-3')
  assert.equal(isTypingLoopActive('typing-3'), false)

  t.mock.timers.tick(80000)
  assert.equal(count(), 1) // only the immediate ping from start

  stopTypingLoop('typing-3') // stopping an inactive loop is a safe no-op
})

test('the 30-minute safety timeout stops a stuck loop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { channel, count } = makeChannel('typing-4')

  startTypingLoop(channel)
  t.mock.timers.tick(30 * 60 * 1000)
  assert.equal(isTypingLoopActive('typing-4'), false)

  const countAtTimeout = count()
  t.mock.timers.tick(80000)
  assert.equal(count(), countAtTimeout)
})

test('loops for different channels are independent', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const a = makeChannel('typing-5a')
  const b = makeChannel('typing-5b')

  startTypingLoop(a.channel)
  startTypingLoop(b.channel)
  stopTypingLoop('typing-5a')

  t.mock.timers.tick(8000)
  assert.equal(a.count(), 1)
  assert.equal(b.count(), 2)
  assert.equal(isTypingLoopActive('typing-5b'), true)

  stopTypingLoop('typing-5b')
})
