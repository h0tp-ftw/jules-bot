import './_ensureDb.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamManager } from '../src/lib/streams/StreamManager.js'

type FakeMessage = {
  id: string
  content: string
  author: { id: string }
  reference?: { messageId: string }
  createdTimestamp: number
  edit: (options: { content: string }) => Promise<FakeMessage>
  reply: (options: {
    content: string
    allowedMentions?: { repliedUser: boolean }
  }) => Promise<FakeMessage>
  delete: () => Promise<void>
}

test('preserves long status content across reusable overflow messages', async () => {
  const messages = new Map<string, FakeMessage>()
  let nextId = 1
  let replyCount = 0

  const createMessage = (
    id: string,
    content: string,
    reference?: { messageId: string },
  ): FakeMessage => {
    const message: FakeMessage = {
      id,
      content,
      author: { id: 'bot-user' },
      reference,
      createdTimestamp: nextId,
      async edit(options) {
        message.content = options.content
        return message
      },
      async reply(options) {
        replyCount++
        const reply = createMessage(`overflow-${nextId++}`, options.content, { messageId: id })
        messages.set(reply.id, reply)
        return reply
      },
      async delete() {
        messages.delete(id)
      },
    }
    return message
  }

  const primary = createMessage('status-message', '')
  messages.set(primary.id, primary)

  const thread = {
    id: 'thread-1',
    messages: {
      async fetch(arg: string | { limit: number }) {
        if (typeof arg === 'string') {
          const message = messages.get(arg)
          if (!message) throw new Error(`Missing message ${arg}`)
          return message
        }
        return messages
      },
    },
  }

  const manager = new StreamManager({ user: { id: 'bot-user' } } as never)
  const syncStatusContent = (
    manager as unknown as {
      syncStatusContent: (
        thread: unknown,
        statusMessageId: string,
        content: string,
      ) => Promise<void>
    }
  ).syncStatusContent.bind(manager)

  const firstContent = 'A'.repeat(4500)
  await syncStatusContent(thread, primary.id, firstContent)

  const firstOverflow = [...messages.values()]
    .filter((message) => message.reference?.messageId === primary.id)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)

  assert.equal(replyCount, 2)
  assert.equal(
    [primary.content, ...firstOverflow.map((message) => message.content)].join(''),
    firstContent,
  )
  assert.ok([primary, ...firstOverflow].every((message) => message.content.length <= 1990))

  const secondContent = 'B'.repeat(4300)
  await syncStatusContent(thread, primary.id, secondContent)

  const secondOverflow = [...messages.values()]
    .filter((message) => message.reference?.messageId === primary.id)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)

  assert.equal(replyCount, 2, 'existing overflow messages should be edited, not duplicated')
  assert.equal(
    [primary.content, ...secondOverflow.map((message) => message.content)].join(''),
    secondContent,
  )

  await syncStatusContent(thread, primary.id, 'Done')
  assert.equal(primary.content, 'Done')
  assert.equal(
    [...messages.values()].filter((message) => message.reference?.messageId === primary.id).length,
    0,
  )
})
